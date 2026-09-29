// Truy cập D1 và ánh xạ hàng <-> kiểu của máy trạng thái.
import { DEFAULTS, initialState, type AlertConfig, type AlertEvent, type AlertState } from './alerts.ts';
import type { DeviceRow } from './types.ts';

interface StateRow {
  phase: AlertState['phase'];
  breach_kind: AlertState['breachKind'];
  breach_since: number | null;
  in_range_since: number | null;
  last_ts: number | null;
  last_notified_at: number | null;
  reminders_sent: number;
}

export function alertConfigFor(d: DeviceRow): AlertConfig {
  return {
    minC: d.min_c,
    maxC: d.max_c,
    breachSeconds: d.breach_minutes * 60,
    ...DEFAULTS,
  };
}

export async function getDevice(db: D1Database, id: string): Promise<DeviceRow | null> {
  return db.prepare('SELECT * FROM devices WHERE id = ?').bind(id).first<DeviceRow>();
}

export async function getState(db: D1Database, deviceId: string): Promise<AlertState> {
  const r = await db.prepare('SELECT * FROM alert_state WHERE device_id = ?').bind(deviceId).first<StateRow>();
  if (!r) return initialState();
  return {
    phase: r.phase,
    breachKind: r.breach_kind,
    breachSince: r.breach_since,
    inRangeSince: r.in_range_since,
    lastNotifiedAt: r.last_notified_at,
    remindersSent: r.reminders_sent,
    lastTs: r.last_ts,
  };
}

export function saveStateStmt(db: D1Database, deviceId: string, s: AlertState): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO alert_state (device_id, phase, breach_kind, breach_since, in_range_since, last_ts, last_notified_at, reminders_sent)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(device_id) DO UPDATE SET
         phase = ?2, breach_kind = ?3, breach_since = ?4, in_range_since = ?5,
         last_ts = ?6, last_notified_at = ?7, reminders_sent = ?8`,
    )
    .bind(deviceId, s.phase, s.breachKind, s.breachSince, s.inRangeSince, s.lastTs, s.lastNotifiedAt, s.remindersSent);
}

/**
 * Ghi sự kiện và tạo tin chờ gửi cho MỌI người nhận hiện tại, trong cùng một batch
 * (giao dịch) với việc đổi trạng thái => không có chuyện đổi trạng thái mà mất cảnh báo.
 */
export function eventStmts(db: D1Database, deviceId: string, e: AlertEvent, now: number): D1PreparedStatement[] {
  return [
    db
      .prepare('INSERT INTO alert_events (device_id, kind, ts, temp_c, detail) VALUES (?, ?, ?, ?, ?)')
      .bind(deviceId, e.kind, e.ts, e.tempC, e.detail),
    db
      .prepare(
        `INSERT INTO notifications (event_id, phone, updated_at)
         SELECT last_insert_rowid(), phone, ? FROM recipients WHERE device_id = ?`,
      )
      .bind(now, deviceId),
  ];
}
