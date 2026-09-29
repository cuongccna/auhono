// Tác vụ hẹn giờ (mỗi 5 phút): phát hiện im lặng, nhắc lại, gộp dữ liệu cũ.
import { tick } from './alerts.ts';
import { alertConfigFor, eventStmts, getState, saveStateStmt } from './db.ts';
import type { DeviceRow } from './types.ts';

/** Giữ số đo chi tiết 7 ngày, sau đó chỉ giữ trung bình theo giờ. */
export const RETENTION_SECONDS = 7 * 24 * 3600;

export async function checkDevices(db: D1Database, now: number): Promise<number> {
  // Chỉ thiết bị đã gắn chủ, chưa bị thu hồi và từng gửi số đo.
  const { results } = await db
    .prepare('SELECT * FROM devices WHERE account_id IS NOT NULL AND revoked = 0 AND last_seen IS NOT NULL')
    .all<DeviceRow>();

  let events = 0;
  for (const d of results) {
    const before = await getState(db, d.id);
    const res = tick(before, now, d.last_seen, alertConfigFor(d));
    if (JSON.stringify(res.state) === JSON.stringify(before)) continue;
    const stmts = [saveStateStmt(db, d.id, res.state)];
    for (const e of res.events) stmts.push(...eventStmts(db, d.id, e, now));
    await db.batch(stmts);
    events += res.events.length;
  }
  return events;
}

/** Gộp số đo cũ hơn 7 ngày thành trung bình theo giờ rồi xóa số đo chi tiết. Idempotent. */
export async function rollupOldReadings(db: D1Database, now: number): Promise<void> {
  // Cắt theo đầu giờ để không gộp dở một giờ.
  const cutoff = Math.floor((now - RETENTION_SECONDS) / 3600) * 3600;
  await db.batch([
    db
      .prepare(
        `INSERT OR REPLACE INTO readings_hourly (device_id, hour_ts, avg_c, min_c, max_c, n)
         SELECT device_id, (ts / 3600) * 3600, AVG(temp_c), MIN(temp_c), MAX(temp_c), COUNT(*)
         FROM readings WHERE ts < ?1 GROUP BY device_id, (ts / 3600) * 3600`,
      )
      .bind(cutoff),
    db.prepare('DELETE FROM readings WHERE ts < ?').bind(cutoff),
  ]);
}
