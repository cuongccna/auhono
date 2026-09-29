// Nhận số đo từ thiết bị: lưu, chạy máy trạng thái, ghi sự kiện cảnh báo (cùng một batch).
import { step, type AlertEvent, type Reading } from './alerts.ts';
import { alertConfigFor, eventStmts, getState, saveStateStmt } from './db.ts';
import type { DeviceRow } from './types.ts';

/** Số đo cũ hơn mức này bị bỏ (thiết bị gửi bù dữ liệu tồn tối đa 24 giờ). */
export const MAX_AGE_SECONDS = 24 * 3600;
/** Cho phép đồng hồ chip lệch nhẹ về phía tương lai. */
export const MAX_FUTURE_SECONDS = 300;

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
  const before = await getState(db, device.id);
  let state = before;
  const events: AlertEvent[] = [];
  for (const r of readings) {
    const res = step(state, r, cfg);
    state = res.state;
    events.push(...res.events);
  }

  const stmts: D1PreparedStatement[] = readings.map((r) =>
    db
      .prepare('INSERT OR IGNORE INTO readings (device_id, ts, temp_c) VALUES (?, ?, ?)')
      .bind(device.id, r.ts, r.c),
  );
  // last_seen = giờ NHẬN (không phải ts số đo): phát hiện im lặng dựa trên lúc gói tới.
  stmts.push(
    db
      .prepare('UPDATE devices SET last_seen = ?, firmware = COALESCE(?, firmware) WHERE id = ?')
      .bind(now, firmware ?? null, device.id),
  );
  // Chỉ ghi trạng thái khi thật sự đổi (tiết kiệm lượt ghi D1).
  if (JSON.stringify(state) !== JSON.stringify(before)) stmts.push(saveStateStmt(db, device.id, state));
  for (const e of events) stmts.push(...eventStmts(db, device.id, e, now));

  await db.batch(stmts);
  return { accepted: readings.length, dropped: input.length - readings.length, events };
}
