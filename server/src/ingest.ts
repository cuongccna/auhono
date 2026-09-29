// Nhận số đo từ thiết bị: lưu, chạy máy trạng thái, ghi sự kiện cảnh báo (cùng một batch).
import { step, type AlertEvent, type Reading } from './alerts.ts';
import { alertConfigFor, commitState, getState } from './db.ts';
import type { DeviceRow } from './types.ts';

/** Số đo cũ hơn mức này bị bỏ (thiết bị gửi bù dữ liệu tồn tối đa 24 giờ). */
export const MAX_AGE_SECONDS = 24 * 3600;
/** Cho phép đồng hồ chip lệch nhẹ về phía tương lai. */
export const MAX_FUTURE_SECONDS = 300;
/** Số lần thử lại khi va chạm với cron/request khác cùng sửa trạng thái. */
const MAX_ATTEMPTS = 4;

export interface IngestResult {
  accepted: number;
  dropped: number;
  events: AlertEvent[];
}

export async function ingest(
  db: D1Database,
  device: DeviceRow,
  input: Reading[],
  now: number,
  firmware?: string,
): Promise<IngestResult> {
  // Sắp theo thời gian; loại số đo ngoài cửa sổ hợp lệ và trùng ts trong cùng gói.
  const seen = new Set<number>();
  const readings = input
    .filter((r) => r.ts >= now - MAX_AGE_SECONDS && r.ts <= now + MAX_FUTURE_SECONDS)
    .sort((a, b) => a.ts - b.ts)
    .filter((r) => (seen.has(r.ts) ? false : (seen.add(r.ts), true)));

  const cfg = alertConfigFor(device);

  // Phần idempotent (INSERT OR IGNORE / UPDATE cố định): chạy lại khi thử lại vẫn an toàn.
  const idempotent = (): D1PreparedStatement[] => [
    ...readings.map((r) =>
      db.prepare('INSERT OR IGNORE INTO readings (device_id, ts, temp_c) VALUES (?, ?, ?)').bind(device.id, r.ts, r.c),
    ),
    // last_seen = giờ NHẬN (không phải ts số đo): phát hiện im lặng dựa trên lúc gói tới.
    db
      .prepare('UPDATE devices SET last_seen = ?, firmware = COALESCE(?, firmware) WHERE id = ?')
      .bind(now, firmware ?? null, device.id),
  ];

  let events: AlertEvent[] = [];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const before = await getState(db, device.id);
    let state = before.state;
    events = [];
    for (const r of readings) {
      const res = step(state, r, cfg);
      state = res.state;
      events.push(...res.events);
    }
    // Luôn ghi trạng thái (tăng version) kể cả khi không đổi: nếu cron vừa kết luận "mất kết nối"
    // dựa trên dữ liệu cũ thì phép so version của ta thất bại và ta đọc lại thay vì bỏ sót.
    if (await commitState(db, device.id, before, state, events, now, idempotent(), device.paused_until)) break;
    events = [];
    if (attempt === MAX_ATTEMPTS - 1) {
      // Vẫn va chạm sau nhiều lần (rất hiếm): số đo đã lưu; trạng thái sẽ được lần gửi sau/cron xử lý.
      console.warn('ingest: version conflict, state not updated', device.id);
    }
  }
  return { accepted: readings.length, dropped: input.length - readings.length, events };
}
