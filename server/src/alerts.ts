// Máy trạng thái cảnh báo: hàm THUẦN (không đụng DB/mạng) nên test được dễ dàng.
//
// Quy tắc (xem docs/PLAN.md, Giai đoạn 2):
//  - Chống báo nhầm: chỉ báo khi vượt ngưỡng LIÊN TỤC >= breachSeconds.
//  - Chịu dao động quanh ngưỡng: về trong ngưỡng ngắn hơn dipSeconds (cảm biến nhiễu, máy nén
//    chạy/ngắt) KHÔNG làm đếm lại từ đầu.
//  - Chống làm phiền và TIẾT KIỆM TIỀN TIN NHẮN (mỗi tin ZNS ~220đ): báo một lần, nhắc theo lịch thưa dần
//    (reminderDelays), dừng khi chủ quán bấm "đã biết" (ackedUntil); "đã ổn" khi bình thường liên tục
//    >= recoverSeconds. Tổng số tin cho một sự cố luôn bị chặn trên.
//  - Chưa "vào chế độ báo động" (armed = false) cho tới khi tủ đạt ngưỡng ít nhất một lần: lắp thiết
//    bị vào tủ đang ấm/vừa rã đông không gây báo động oan. Quá warmupMaxSeconds vẫn ấm thì báo.
//  - Mất kết nối: không có số đo hợp lệ quá offlineSeconds; thiết bị đã gắn chủ mà chưa từng gửi
//    số đo sau neverSeenSeconds cũng báo (Wi-Fi 5 GHz, nhập sai mật khẩu...).

export type Phase = 'ok' | 'temp_alarm' | 'offline' | 'sensor_fault';
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
  /** Chủ quán đã "đã biết": không nhắc lại trước mốc này (unix giây). */
  ackedUntil: number | null;
}

export interface AlertConfig {
  minC: number;
  maxC: number;
  breachSeconds: number;
  recoverSeconds: number;
  /** Khoảng cách (giây) từ lần báo trước tới lần nhắc thứ i của báo động nhiệt độ; hết mảng thì dừng. */
  reminderDelays: readonly number[];
  /** Như trên cho mất kết nối: thưa hơn vì mất điện thường không xử lý được ngay. */
  offlineReminderDelays: readonly number[];
  offlineSeconds: number;
  /** Thiết bị còn liên lạc (gửi nhịp tim) nhưng không có số đo hợp lệ quá mức này => lỗi cảm biến. */
  sensorFaultSeconds: number;
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
  | 'sensor_fault'
  | 'sensor_fault_reminder'
  | 'sensor_recovered'
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
  // Nhiệt độ: +30 phút, +2 giờ, +4 giờ, +8 giờ, +12 giờ (tức 0,5 / 2,5 / 6,5 / 14,5 / 26,5 giờ sau lần báo đầu).
  reminderDelays: [1800, 7200, 14400, 28800, 43200],
  // Mất kết nối: +2 giờ, +6 giờ, +12 giờ.
  offlineReminderDelays: [7200, 21600, 43200],
  offlineSeconds: 15 * 60,
  sensorFaultSeconds: 15 * 60,
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
    ackedUntil: null,
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

  if (s.phase === 'offline' || s.phase === 'sensor_fault') {
    // Có số đo trở lại => hết mất kết nối / hết lỗi cảm biến.
    const kind = s.phase === 'sensor_fault' ? 'sensor_recovered' : 'reconnected';
    s.phase = 'ok';
    s.ackedUntil = null;
    s.lastNotifiedAt = null;
    s.remindersSent = 0;
    s.breachKind = null;
    s.breachSince = null;
    s.inRangeSince = null;
    if (breach === null) {
      s.armed = true;
      events.push({ kind, ts: r.ts, tempC: r.c, detail: null });
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
      s.ackedUntil = null;
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
    s.ackedUntil = null;
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
 * Xử lý theo thời gian (cron 5 phút): phát hiện im lặng, lỗi cảm biến và nhắc lại.
 * - `lastSeen`: giờ nhận GÓI hợp lệ gần nhất, kể cả gói nhịp tim không có số đo (null nếu chưa từng gửi).
 * - `lastReadingAt`: giờ nhận số đo hợp lệ gần nhất (null nếu chưa từng có).
 * - `claimedAt`: giờ gắn chủ.
 * Mất liên lạc (mất điện/Wi-Fi) ưu tiên hơn lỗi cảm biến: thiết bị cũ không gửi nhịp tim sẽ luôn rơi vào "mất kết nối".
 */
export function tick(
  prev: AlertState,
  now: number,
  lastSeen: number | null,
  cfg: AlertConfig,
  claimedAt: number | null = null,
  lastReadingAt: number | null = null,
): StepResult {
  const s: AlertState = { ...prev };
  const events: AlertEvent[] = [];
  const silentSince = lastSeen ?? claimedAt;
  if (silentSince === null) return { state: s, events };
  const limit = lastSeen !== null ? cfg.offlineSeconds : cfg.neverSeenSeconds;
  const contactLost = now - silentSince >= limit;
  const neverSeen = lastSeen === null;

  const enter = (phase: 'offline' | 'sensor_fault', detail: string | null) => {
    s.phase = phase;
    s.ackedUntil = null;
    s.breachKind = null;
    s.breachSince = null;
    s.inRangeSince = null;
    s.lastNotifiedAt = now;
    s.remindersSent = 0;
    events.push({ kind: phase, ts: now, tempC: null, detail });
  };

  if (s.phase !== 'offline' && contactLost) {
    enter('offline', neverSeen ? 'never_seen' : null);
    return { state: s, events };
  }

  // Còn liên lạc (có nhịp tim) nhưng lâu không có số đo hợp lệ: đầu dò đứt/hỏng.
  const readingSince = lastReadingAt ?? claimedAt;
  if (
    !contactLost &&
    !neverSeen &&
    s.phase !== 'sensor_fault' &&
    readingSince !== null &&
    now - readingSince >= cfg.sensorFaultSeconds
  ) {
    enter('sensor_fault', null);
    return { state: s, events };
  }

  // Lịch nhắc theo loại sự cố; chủ quán đã bấm "đã biết" thì im lặng tới mốc ackedUntil.
  const schedule =
    s.phase === 'temp_alarm' ? cfg.reminderDelays : s.phase === 'offline' || s.phase === 'sensor_fault' ? cfg.offlineReminderDelays : [];
  const acked = s.ackedUntil !== null && now < s.ackedUntil;
  const delay = schedule[s.remindersSent];
  const due = !acked && delay !== undefined && s.lastNotifiedAt !== null && now - s.lastNotifiedAt >= delay;
  if (!due) return { state: s, events };

  if (s.phase === 'temp_alarm' && s.inRangeSince === null) {
    s.lastNotifiedAt = now;
    s.remindersSent += 1;
    events.push({ kind: 'temp_reminder', ts: now, tempC: null, detail: s.breachKind });
  } else if (s.phase === 'offline') {
    s.lastNotifiedAt = now;
    s.remindersSent += 1;
    events.push({ kind: 'offline_reminder', ts: now, tempC: null, detail: neverSeen ? 'never_seen' : null });
  } else if (s.phase === 'sensor_fault') {
    s.lastNotifiedAt = now;
    s.remindersSent += 1;
    events.push({ kind: 'sensor_fault_reminder', ts: now, tempC: null, detail: null });
  }
  return { state: s, events };
}
