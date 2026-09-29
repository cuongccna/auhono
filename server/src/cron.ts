// Tác vụ hẹn giờ (mỗi 5 phút): phát hiện im lặng, nhắc lại, gộp dữ liệu cũ.
import { tick, type AlertEvent } from './alerts.ts';
import { alertConfigFor, commitState, stateFromRow } from './db.ts';
import type { DeviceRow } from './types.ts';

/** Giữ số đo chi tiết 7 ngày, sau đó chỉ giữ trung bình theo giờ. */
export const RETENTION_SECONDS = 7 * 24 * 3600;
/** Giữ lịch sử sự kiện/tin nhắn bao lâu. */
export const EVENT_RETENTION_SECONDS = 90 * 24 * 3600;

type Row = DeviceRow & {
  phase: string | null;
  breach_kind: 'high' | 'low' | null;
  breach_since: number | null;
  in_range_since: number | null;
  last_ts: number | null;
  last_notified_at: number | null;
  reminders_sent: number | null;
  armed: number | null;
  acked_until: number | null;
  version: number | null;
  latest_c: number | null;
};

/**
 * Kiểm tra mọi thiết bị đang hoạt động. Chỉ MỘT truy vấn đọc cho cả đội thiết bị (gói Workers miễn phí
 * giới hạn ~50 truy vấn D1 mỗi lần chạy); ghi chỉ khi có thay đổi. Lỗi ở một thiết bị không chặn các thiết bị khác.
 */
export async function checkDevices(db: D1Database, now: number): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT d.*, s.phase, s.breach_kind, s.breach_since, s.in_range_since, s.last_ts,
              s.last_notified_at, s.reminders_sent, s.armed, s.acked_until, s.version,
              (SELECT temp_c FROM readings r WHERE r.device_id = d.id ORDER BY ts DESC LIMIT 1) AS latest_c
       FROM devices d LEFT JOIN alert_state s ON s.device_id = d.id
       WHERE d.account_id IS NOT NULL AND d.revoked = 0`,
    )
    .all<Row>();

  let events = 0;
  for (const d of results) {
    try {
      // Đang tạm dừng (nghỉ Tết, rút điện có chủ ý): không đánh giá gì. Hết hạn tạm dừng thì thiết bị vẫn im
      // lặng sẽ bị báo "mất kết nối" ngay ở lượt cron kế tiếp.
      if (d.paused_until !== null && now < d.paused_until) continue;
      const before = stateFromRow(d);
      const res = tick(before.state, now, d.last_seen, alertConfigFor(d), d.claimed_at, d.last_reading_at);
      if (JSON.stringify(res.state) === JSON.stringify(before.state)) continue;
      // Nhắc lại nhiệt độ: kèm số đo mới nhất để tin nhắn có nội dung.
      const evs: AlertEvent[] = res.events.map((e) =>
        e.kind === 'temp_reminder' ? { ...e, tempC: d.latest_c } : e,
      );
      // Nếu va chạm với request thiết bị vừa xử lý: bỏ qua, lượt cron sau sẽ đánh giá lại.
      if (await commitState(db, d.id, before, res.state, evs, now)) events += evs.length;
    } catch (err) {
      console.error('checkDevices failed for', d.id, err instanceof Error ? err.message : err);
    }
  }
  return events;
}

/**
 * Gộp số đo cũ hơn 7 ngày thành trung bình theo giờ rồi xóa số đo chi tiết. Idempotent.
 * Làm từng thiết bị theo khóa chính (device_id, ts) để chỉ quét đúng phần cần gộp, không quét cả bảng.
 */
export async function rollupOldReadings(db: D1Database, now: number): Promise<void> {
  // Cắt theo đầu giờ để không gộp dở một giờ.
  const cutoff = Math.floor((now - RETENTION_SECONDS) / 3600) * 3600;
  const { results } = await db.prepare('SELECT id FROM devices').all<{ id: string }>();
  for (const { id } of results) {
    try {
      await db.batch([
        db
          .prepare(
            `INSERT OR REPLACE INTO readings_hourly (device_id, hour_ts, avg_c, min_c, max_c, n)
             SELECT device_id, (ts / 3600) * 3600, AVG(temp_c), MIN(temp_c), MAX(temp_c), COUNT(*)
             FROM readings WHERE device_id = ?1 AND ts < ?2 GROUP BY (ts / 3600) * 3600`,
          )
          .bind(id, cutoff),
        db.prepare('DELETE FROM readings WHERE device_id = ? AND ts < ?').bind(id, cutoff),
      ]);
    } catch (err) {
      console.error('rollup failed for', id, err instanceof Error ? err.message : err);
    }
  }
}

/** Dọn dữ liệu phụ để D1 không phình mãi: sự kiện/tin cũ, lần nhập sai mã kích hoạt. */
export async function purgeOld(db: D1Database, now: number): Promise<void> {
  const cutoff = now - EVENT_RETENTION_SECONDS;
  await db.batch([
    db.prepare('DELETE FROM alert_events WHERE ts < ?').bind(cutoff), // notifications xóa theo (ON DELETE CASCADE)
    db.prepare('DELETE FROM claim_failures WHERE ts < ?').bind(now - 24 * 3600),
  ]);
}
