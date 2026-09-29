// Máy trạng thái cảnh báo: hàm THUẦN (không đụng DB/mạng) nên test được dễ dàng.
//
// Quy tắc (xem docs/PLAN.md, Giai đoạn 2):
//  - Chống báo nhầm: chỉ báo khi vượt ngưỡng LIÊN TỤC >= breachSeconds.
//  - Chịu dao động quanh ngưỡng: về trong ngưỡng ngắn hơn dipSeconds (cảm biến nhiễu, máy nén
//    chạy/ngắt) KHÔNG làm đếm lại từ đầu.
//  - Chống làm phiền nhưng không im lặng khi tủ hỏng lâu: báo một lần, nhắc mỗi 30 phút (fastReminders
//    lần đầu), sau đó mỗi 2 giờ, tối đa maxReminders lần; "đã ổn" khi bình thường liên tục >= recoverSeconds.
//  - Chưa "vào chế độ báo động" (armed = false) cho tới khi tủ đạt ngưỡng ít nhất một lần: lắp thiết
//    bị vào tủ đang ấm/vừa rã đông không gây báo động oan. Quá warmupMaxSeconds vẫn ấm thì báo.
//  - Mất kết nối: không có số đo hợp lệ quá offlineSeconds; thiết bị đã gắn chủ mà chưa từng gửi
//    số đo sau neverSeenSeconds cũng báo (Wi-Fi 5 GHz, nhập sai mật khẩu...).

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
  /** Đã từng thấy nhiệt độ trong ngưỡng kể từ lúc gắn/đổi ngưỡng => cho phép báo động. */
  armed: boolean;
}

export interface AlertConfig {
  minC: number;
  maxC: number;
  breachSeconds: number;
  recoverSeconds: number;
  /** Chu kỳ nhắc lại cho `fastReminders` lần đầu. */
  reminderSeconds: number;
  fastReminders: number;
  /** Chu kỳ nhắc lại sau đó (tủ hỏng lâu: vẫn nhắc, nhưng thưa hơn). */
  laterReminderSeconds: number;
  maxReminders: number;
  offlineSeconds: number;
  /** Đã gắn chủ mà chưa từng có số đo: sau bao lâu thì báo. */
  neverSeenSeconds: number;
  /** Về trong ngưỡng ngắn hơn mức này không tính là "hết vượt ngưỡng". */
  dipSeconds: number;
  /** Tối đa bao lâu chờ tủ đạt ngưỡng lần đầu trước khi vẫn báo động. */
  warmupMaxSeconds: number;
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
  fastReminders: 4,
  laterReminderSeconds: 2 * 3600,
  maxReminders: 16, // 4 x 30 phút + 12 x 2 giờ = 26 giờ
  offlineSeconds: 15 * 60,
  neverSeenSeconds: 60 * 60,
  dipSeconds: 2 * 60,
  warmupMaxSeconds: 12 * 3600,
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
    armed: false,
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
      s.armed = true;
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
      s.armed = true;
      if (s.breachSince !== null) {
        // Đang đếm vượt ngưỡng: chỉ huỷ khi về trong ngưỡng đủ lâu (bỏ qua dao động ngắn).
        s.inRangeSince ??= r.ts;
        if (r.ts - s.inRangeSince >= cfg.dipSeconds) {
          s.breachKind = null;
          s.breachSince = null;
          s.inRangeSince = null;
        }
      }
      return { state: s, events };
    }
    s.inRangeSince = null;
    if (s.breachSince === null || s.breachKind !== breach) {
      s.breachKind = breach;
      s.breachSince = r.ts;
    }
    const needed = s.armed ? cfg.breachSeconds : cfg.warmupMaxSeconds;
    if (r.ts - s.breachSince >= needed) {
      s.phase = 'temp_alarm';
      s.armed = true;
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

/** Khoảng cách tới lần nhắc kế tiếp: dày lúc đầu, thưa dần khi sự cố kéo dài. */
function reminderInterval(sent: number, cfg: AlertConfig): number {
  return sent < cfg.fastReminders ? cfg.reminderSeconds : cfg.laterReminderSeconds;
}

/**
 * Xử lý theo thời gian (cron 5 phút): phát hiện im lặng và nhắc lại.
 * `lastSeen` = giờ nhận số đo gần nhất (null nếu chưa từng gửi); `claimedAt` = giờ gắn chủ.
 */
export function tick(
  prev: AlertState,
  now: number,
  lastSeen: number | null,
  cfg: AlertConfig,
  claimedAt: number | null = null,
): StepResult {
  const s: AlertState = { ...prev };
  const events: AlertEvent[] = [];
  const silentSince = lastSeen ?? claimedAt;
  if (silentSince === null) return { state: s, events };
  const limit = lastSeen !== null ? cfg.offlineSeconds : cfg.neverSeenSeconds;

  if (s.phase !== 'offline' && now - silentSince >= limit) {
    s.phase = 'offline';
    s.breachKind = null;
    s.breachSince = null;
    s.inRangeSince = null;
    s.lastNotifiedAt = now;
    s.remindersSent = 0;
    events.push({ kind: 'offline', ts: now, tempC: null, detail: lastSeen === null ? 'never_seen' : null });
    return { state: s, events };
  }

  const due =
    s.lastNotifiedAt !== null &&
    now - s.lastNotifiedAt >= reminderInterval(s.remindersSent, cfg) &&
    s.remindersSent < cfg.maxReminders;
  if (!due) return { state: s, events };

  if (s.phase === 'temp_alarm' && s.inRangeSince === null) {
    s.lastNotifiedAt = now;
    s.remindersSent += 1;
    events.push({ kind: 'temp_reminder', ts: now, tempC: null, detail: s.breachKind });
  } else if (s.phase === 'offline') {
    s.lastNotifiedAt = now;
    s.remindersSent += 1;
    events.push({ kind: 'offline_reminder', ts: now, tempC: null, detail: lastSeen === null ? 'never_seen' : null });
  }
  return { state: s, events };
}
