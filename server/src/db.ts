// Truy cập D1 và ánh xạ hàng <-> kiểu của máy trạng thái.
//
// ĐỒNG THỜI: cron và request thiết bị có thể cùng sửa trạng thái của một thiết bị. Mọi thay đổi
// trạng thái đi qua `commitState`: một batch (giao dịch) so-và-tăng `version` (khóa lạc quan).
// Nếu người khác đã đổi trước, sự kiện/tin nhắn của batch này KHÔNG được ghi và hàm trả false
// để bên gọi đọc lại rồi thử lại. Nhờ đó không có báo trùng hay "mất kết nối" oan.
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
  armed: number;
  acked_until: number | null;
  version: number;
}

export interface LoadedState {
  state: AlertState;
  /** 0 nếu thiết bị chưa có dòng trạng thái. */
  version: number;
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

/** Chấp nhận cả dòng alert_state lẫn dòng JOIN từ devices (cột trạng thái có thể null nếu chưa có dòng). */
type LooseStateRow = { [K in Exclude<keyof StateRow, 'phase'>]?: StateRow[K] | null } & { phase?: string | null };
export function stateFromRow(r: LooseStateRow | null): LoadedState {
  if (!r || r.phase === undefined || r.phase === null) return { state: initialState(), version: 0 };
  return {
    version: r.version ?? 0,
    state: {
      phase: r.phase as AlertState['phase'],
      breachKind: r.breach_kind ?? null,
      breachSince: r.breach_since ?? null,
      inRangeSince: r.in_range_since ?? null,
      lastNotifiedAt: r.last_notified_at ?? null,
      remindersSent: r.reminders_sent ?? 0,
      lastTs: r.last_ts ?? null,
      armed: (r.armed ?? 0) === 1,
      ackedUntil: r.acked_until ?? null,
    },
  };
}

export async function getState(db: D1Database, deviceId: string): Promise<LoadedState> {
  const r = await db.prepare('SELECT * FROM alert_state WHERE device_id = ?').bind(deviceId).first<StateRow>();
  return stateFromRow(r);
}

/** Ghi trạng thái CHỈ nếu version còn đúng `expected`; meta.changes === 1 nghĩa là thành công. */
function saveStateStmt(db: D1Database, deviceId: string, s: AlertState, expected: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO alert_state (device_id, phase, breach_kind, breach_since, in_range_since, last_ts, last_notified_at, reminders_sent, armed, acked_until, version)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?12, ?10)
       ON CONFLICT(device_id) DO UPDATE SET
         phase = ?2, breach_kind = ?3, breach_since = ?4, in_range_since = ?5,
         last_ts = ?6, last_notified_at = ?7, reminders_sent = ?8, armed = ?9, acked_until = ?12, version = ?10
       WHERE alert_state.version = ?11`,
    )
    .bind(
      deviceId, s.phase, s.breachKind, s.breachSince, s.inRangeSince, s.lastTs, s.lastNotifiedAt,
      s.remindersSent, s.armed ? 1 : 0, expected + 1, expected, s.ackedUntil,
    );
}

/** Nhắc lại qua ZNS chỉ gửi cho người nhận chính (đăng ký đầu tiên): tiết kiệm tiền tin, tránh làm phiền cả nhà. */
const REMINDER_KINDS = new Set(['temp_reminder', 'offline_reminder', 'sensor_fault_reminder']);

/** Các lý do không gửi. `zns`: tạm dừng hoặc vượt trần chi phí. `telegram` (miễn phí): chỉ khi tạm dừng. */
export interface Suppress {
  zns: boolean;
  telegram: boolean;
}

/**
 * Ghi sự kiện + tin cho người nhận, chỉ khi version còn đúng. Mỗi người nhận có thể có 2 tin độc lập
 * (ZNS và Telegram) để một kênh hỏng không làm mất cảnh báo ở kênh kia.
 * - Báo mới / "đã ổn" / "kết nối lại": mọi người nhận. Nhắc lại ZNS: chỉ người nhận chính; nhắc lại Telegram: mọi
 *   người đã liên kết (miễn phí).
 * - Tin bị chặn vẫn được ghi (status 'suppressed') để tra cứu nhưng không bao giờ được gửi.
 * Tin gắn với sự kiện qua `token` ngẫu nhiên (không dùng last_insert_rowid: SQLite có thể
 * đổi giá trị đó giữa chừng khi INSERT...SELECT nhiều dòng).
 */
function eventStmts(
  db: D1Database,
  deviceId: string,
  e: AlertEvent,
  now: number,
  expected: number,
  suppress: Suppress,
): D1PreparedStatement[] {
  const token = crypto.randomUUID();
  const primaryOnly = REMINDER_KINDS.has(e.kind);
  return [
    db
      .prepare(
        `INSERT INTO alert_events (token, device_id, kind, ts, temp_c, detail)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
         WHERE COALESCE((SELECT version FROM alert_state WHERE device_id = ?2), 0) = ?7`,
      )
      .bind(token, deviceId, e.kind, e.ts, e.tempC, e.detail, expected),
    db
      .prepare(
        `INSERT INTO notifications (event_id, channel, target, status, updated_at)
         SELECT ev.id, 'zns', r.phone, ?3, ?2 FROM alert_events ev
         JOIN recipients r ON r.device_id = ev.device_id
         WHERE ev.token = ?1 AND r.mode IN ('zns', 'both')
           AND (?4 = 0 OR r.id = (SELECT MIN(id) FROM recipients WHERE device_id = ev.device_id))`,
      )
      .bind(token, now, suppress.zns ? 'suppressed' : 'pending', primaryOnly ? 1 : 0),
    db
      .prepare(
        `INSERT INTO notifications (event_id, channel, target, status, updated_at)
         SELECT ev.id, 'telegram', CAST(r.telegram_chat_id AS TEXT), ?3, ?2 FROM alert_events ev
         JOIN recipients r ON r.device_id = ev.device_id
         WHERE ev.token = ?1 AND r.mode IN ('telegram', 'both') AND r.telegram_chat_id IS NOT NULL`,
      )
      .bind(token, now, suppress.telegram ? 'suppressed' : 'pending'),
  ];
}

/**
 * Trần tin nhắn mỗi thiết bị mỗi 24 giờ: chặn "bão báo động" (tủ dao động ngưỡng, lỗi cảm biến...)
 * đốt tiền ZNS. Vượt trần thì tin bị 'suppressed'; sự kiện vẫn được ghi.
 */
export const DAILY_MESSAGE_CAP = 20;

/**
 * Một giao dịch: [thao tác phụ idempotent] + sự kiện + trạng thái mới, có khóa lạc quan.
 * Trả false nếu trạng thái đã bị người khác đổi (khi đó sự kiện không được ghi).
 */
export async function commitState(
  db: D1Database,
  deviceId: string,
  before: LoadedState,
  next: AlertState,
  events: AlertEvent[],
  now: number,
  extra: D1PreparedStatement[] = [],
  /** Thiết bị đang tạm dừng tới mốc này: sự kiện vẫn ghi nhưng không gửi tin. */
  pausedUntil: number | null = null,
): Promise<boolean> {
  const stmts = [...extra];
  if (events.length > 0) {
    const paused = pausedUntil !== null && now < pausedUntil;
    let overCap = false;
    if (!paused) {
      // Trần chỉ tính tin ZNS (tốn tiền); Telegram miễn phí nên không bị trần này chặn.
      const used = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM notifications n JOIN alert_events e ON e.id = n.event_id
           WHERE e.device_id = ? AND e.ts >= ? AND n.channel = 'zns' AND n.status != 'suppressed'`,
        )
        .bind(deviceId, now - 24 * 3600)
        .first<{ n: number }>();
      overCap = (used?.n ?? 0) >= DAILY_MESSAGE_CAP;
    }
    const suppress: Suppress = { zns: paused || overCap, telegram: paused };
    for (const e of events) stmts.push(...eventStmts(db, deviceId, e, now, before.version, suppress));
  }
  stmts.push(saveStateStmt(db, deviceId, next, before.version));
  const res = await db.batch(stmts);
  return res[res.length - 1]!.meta.changes === 1;
}

/**
 * Đặt lại trạng thái (đổi ngưỡng, gắn/gỡ thiết bị): xóa đếm giờ, hủy báo động đang có (không gửi
 * "đã ổn"), tủ phải đạt ngưỡng lại mới báo. Không điều kiện, luôn thắng và tăng version để mọi
 * xử lý đang chạy song song phải đọc lại.
 */
export function resetStateStmt(db: D1Database, deviceId: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO alert_state (device_id, version) VALUES (?1, 1)
       ON CONFLICT(device_id) DO UPDATE SET
         phase = 'ok', breach_kind = NULL, breach_since = NULL, in_range_since = NULL,
         last_notified_at = NULL, reminders_sent = 0, armed = 0, last_ts = NULL, acked_until = NULL,
         version = alert_state.version + 1`,
    )
    .bind(deviceId);
}
