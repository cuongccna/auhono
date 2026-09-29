// Máy trạng thái cảnh báo: hàm THUẦN (không đụng DB/mạng) nên test được dễ dàng.
//
// Quy tắc (xem docs/PLAN.md, Giai đoạn 2):
//  - Chống báo nhầm: chỉ báo khi vượt ngưỡng LIÊN TỤC >= breachSeconds.
//  - Chống làm phiền: báo một lần, nhắc lại mỗi reminderSeconds (tối đa maxReminders
//    lần), và chỉ báo "đã ổn" khi nhiệt độ về bình thường liên tục >= recoverSeconds.
//  - Mất kết nối: không có số đo hợp lệ quá offlineSeconds.

export type Phase = 'ok' | 'temp_alarm' | 'offline';
export type BreachKind = 'high' | 'low';

export interface AlertState {
  phase: Phase;
  breachKind: BreachKind | null;
  breachSince: number | null;
  inRangeSince: number | null;
  lastNotifiedAt: number | null;
  remindersSent: number;
  /** ts số đo mới nhất đã xử lý; số đo cũ hơn (gửi lại muộn) chỉ được lưu, không đổi trạng thái. */
  lastTs: number | null;
}

export interface AlertConfig {
  minC: number;
  maxC: number;
  breachSeconds: number;
  recoverSeconds: number;
  reminderSeconds: number;
  maxReminders: number;
  offlineSeconds: number;
}

export type AlertEventKind =
  | 'temp_alarm'
  | 'temp_reminder'
  | 'offline'
  | 'offline_reminder'
  | 'recovered'
  | 'reconnected';

export interface AlertEvent {
  kind: AlertEventKind;
  ts: number;
  tempC: number | null;
  /** 'high' | 'low' với temp_alarm/temp_reminder. */
  detail: string | null;
}

export interface Reading {
  ts: number;
  c: number;
}

export interface StepResult {
  state: AlertState;
  events: AlertEvent[];
}

export const DEFAULTS = {
  recoverSeconds: 5 * 60,
  reminderSeconds: 30 * 60,
  maxReminders: 4,
  offlineSeconds: 15 * 60,
} as const;

export function initialState(): AlertState {
  return {
    phase: 'ok',
    breachKind: null,
    breachSince: null,
    inRangeSince: null,
    lastNotifiedAt: null,
    remindersSent: 0,
    lastTs: null,
  };
}

function breachOf(c: number, cfg: AlertConfig): BreachKind | null {
  if (c > cfg.maxC) return 'high';
  if (c < cfg.minC) return 'low';
  return null;
}

/** Đưa MỘT số đo vào máy trạng thái. Gọi theo thứ tự ts tăng dần. */
export function step(prev: AlertState, r: Reading, cfg: AlertConfig): StepResult {
  // Số đo cũ/trùng: bỏ qua, tránh trạng thái nhảy lùi khi thiết bị gửi bù dữ liệu tồn.
  if (prev.lastTs !== null && r.ts <= prev.lastTs) return { state: prev, events: [] };

  const s: AlertState = { ...prev, lastTs: r.ts };
  const events: AlertEvent[] = [];
  const breach = breachOf(r.c, cfg);

  if (s.phase === 'offline') {
    // Có số đo trở lại => hết mất kết nối.
    s.phase = 'ok';
    s.lastNotifiedAt = null;
    s.remindersSent = 0;
    s.breachKind = null;
    s.breachSince = null;
    s.inRangeSince = null;
    if (breach === null) {
      events.push({ kind: 'reconnected', ts: r.ts, tempC: r.c, detail: null });
      return { state: s, events };
    }
    // Trở lại nhưng nhiệt độ đang lệch: bắt đầu đếm thời gian vượt ngưỡng, không báo "ổn".
    s.breachKind = breach;
    s.breachSince = r.ts;
    return { state: s, events };
  }

  if (s.phase === 'ok') {
    if (breach === null) {
      s.breachKind = null;
      s.breachSince = null;
      return { state: s, events };
    }
    if (s.breachSince === null || s.breachKind !== breach) {
      s.breachKind = breach;
      s.breachSince = r.ts;
    }
    if (r.ts - s.breachSince >= cfg.breachSeconds) {
      s.phase = 'temp_alarm';
      s.inRangeSince = null;
      s.lastNotifiedAt = r.ts;
      s.remindersSent = 0;
      events.push({ kind: 'temp_alarm', ts: r.ts, tempC: r.c, detail: breach });
    }
    return { state: s, events };
  }

  // phase === 'temp_alarm'
  if (breach !== null) {
    s.breachKind = breach;
    s.inRangeSince = null;
    return { state: s, events };
  }
  if (s.inRangeSince === null) s.inRangeSince = r.ts;
  if (r.ts - s.inRangeSince >= cfg.recoverSeconds) {
    s.phase = 'ok';
    s.breachKind = null;
    s.breachSince = null;
    s.inRangeSince = null;
    s.lastNotifiedAt = null;
    s.remindersSent = 0;
    events.push({ kind: 'recovered', ts: r.ts, tempC: r.c, detail: null });
  }
  return { state: s, events };
}

/**
 * Xử lý theo thời gian (cron 5 phút): phát hiện im lặng và nhắc lại.
 * `lastSeen` = ts nhận số đo hợp lệ gần nhất (null nếu thiết bị chưa từng gửi).
 */
export function tick(
  prev: AlertState,
  now: number,
  lastSeen: number | null,
  cfg: AlertConfig,
): StepResult {
  const s: AlertState = { ...prev };
  const events: AlertEvent[] = [];
  if (lastSeen === null) return { state: s, events };

  if (s.phase !== 'offline' && now - lastSeen >= cfg.offlineSeconds) {
    s.phase = 'offline';
    s.breachKind = null;
    s.breachSince = null;
    s.inRangeSince = null;
    s.lastNotifiedAt = now;
    s.remindersSent = 0;
    events.push({ kind: 'offline', ts: now, tempC: null, detail: null });
    return { state: s, events };
  }

  const due =
    s.lastNotifiedAt !== null &&
    now - s.lastNotifiedAt >= cfg.reminderSeconds &&
    s.remindersSent < cfg.maxReminders;
  if (!due) return { state: s, events };

  if (s.phase === 'temp_alarm' && s.inRangeSince === null) {
    s.lastNotifiedAt = now;
    s.remindersSent += 1;
    events.push({ kind: 'temp_reminder', ts: now, tempC: null, detail: s.breachKind });
  } else if (s.phase === 'offline') {
    s.lastNotifiedAt = now;
    s.remindersSent += 1;
    events.push({ kind: 'offline_reminder', ts: now, tempC: null, detail: null });
  }
  return { state: s, events };
}
