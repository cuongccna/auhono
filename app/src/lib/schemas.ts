// Kiểm tra dữ liệu server trả về ngay tại biên (viết tay để bundle nhỏ, không cần thư viện schema).
// Dữ liệu sai dạng => ném AppError('bad_response') thay vì để giao diện hiển thị "NaN"/lỗi khó hiểu.

import { AppError } from './errors.ts';
import type { ReadingPoint } from './chart.ts';
import type { Kind } from './thresholds.ts';
import { isTelegramUrl, type RecipientMode } from './telegram.ts';

/** Loại tủ; 'other' = server có loại mới mà app chưa biết (vẫn hiển thị được, không bị lỗi cả danh sách). */
export type DeviceKind = Kind | 'other';

export interface Device {
  id: string;
  name: string;
  kind: DeviceKind;
  min_c: number;
  max_c: number;
  breach_minutes: number;
  /** Unix giây; null nếu chưa từng nhận số đo. */
  last_seen: number | null;
  firmware: string | null;
  /** 'ok' | 'temp_alarm' | 'offline' (giữ chuỗi để chịu được giá trị mới trong tương lai). */
  phase: string;
  latest: { ts: number; temp_c: number } | null;
  /** false = báo động CHƯA bật (tủ chưa từng đạt khoảng ngưỡng từ lúc lắp/đổi ngưỡng). Vắng mặt = server cũ, không biết. */
  armed?: boolean;
  /** Số người nhận cảnh báo. 0 = sẽ không có tin nào được gửi. Vắng mặt = server cũ. */
  recipient_count?: number;
  /** Số lần gửi tin thất bại trong 24 giờ qua. Vắng mặt = server cũ. */
  notify_failures_24h?: number;
  /** Đang tạm dừng cảnh báo tới mốc này (Unix giây); null = không tạm dừng. Vắng mặt = server cũ. */
  paused_until?: number | null;
  /** Chủ quán đã bấm "Đã biết": không nhắc lại tới mốc này; null = chưa. Vắng mặt = server cũ. */
  acked_until?: number | null;
  /** Lúc kích hoạt (Unix giây). Vắng mặt = server cũ. */
  claimed_at?: number | null;
}

export interface Readings {
  min_c: number;
  max_c: number;
  points: ReadingPoint[];
}

/** Chặn danh sách khổng lồ do lỗi/độc hại làm treo máy: 7 ngày × 288 điểm/ngày = 2016 là tối đa hợp lệ. */
export const MAX_POINTS = 3000;
export const MAX_DEVICES = 500;
export const MAX_RECIPIENTS_PARSED = 50;
/** Nhiệt độ ngoài khoảng này là rác (DS18B20 đo -55..125). */
const PLAUSIBLE_C = { min: -100, max: 200 };

export interface Recipient {
  id: number;
  name: string;
  /** Dạng 84xxxxxxxxx. */
  phone: string;
  /** Kênh nhận: Zalo (zns) / cả hai / chỉ Telegram. Vắng mặt = server cũ. */
  mode?: RecipientMode;
  /** Đã kết nối Telegram chưa. Vắng mặt = server cũ. */
  telegram_linked?: boolean;
}

export interface RecipientsResponse {
  /** Server đã bật Telegram? false/vắng mặt => ẩn mọi giao diện Telegram. */
  telegram_available: boolean;
  recipients: Recipient[];
}

export interface TelegramLink {
  url: string;
  /** Unix giây; vắng mặt nếu server không trả. */
  expires_at?: number;
}

const bad = (): never => {
  throw new AppError('bad_response');
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

function obj(v: unknown): Obj {
  return isObj(v) ? v : bad();
}
function num(o: Obj, k: string): number {
  const v = o[k];
  return isNum(v) ? v : bad();
}
function str(o: Obj, k: string): string {
  const v = o[k];
  return isStr(v) ? v : bad();
}
function numOrNull(o: Obj, k: string): number | null {
  const v = o[k];
  return v === null || v === undefined ? null : isNum(v) ? v : bad();
}

/** Mốc thời gian: số dương hữu hạn, hoặc null; khác thì undefined (trường mới sai kiểu không được làm hỏng cả thiết bị). */
const optTs = (v: unknown): number | null | undefined => (v === null ? null : typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

/** Số nguyên không âm hợp lệ, nếu không thì undefined (trường mới: không được làm hỏng cả thiết bị). */
const optCount = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);

export function parseDevice(v: unknown): Device {
  const o = obj(v);
  const kind: DeviceKind = o.kind === 'freezer' || o.kind === 'chiller' ? o.kind : 'other';
  let latest: Device['latest'] = null;
  if (o.latest !== null && o.latest !== undefined) {
    const l = obj(o.latest);
    latest = { ts: num(l, 'ts'), temp_c: num(l, 'temp_c') };
  }
  return {
    id: str(o, 'id'),
    name: str(o, 'name'),
    kind,
    min_c: num(o, 'min_c'),
    max_c: num(o, 'max_c'),
    breach_minutes: num(o, 'breach_minutes'),
    last_seen: numOrNull(o, 'last_seen'),
    firmware: isStr(o.firmware) ? o.firmware : null,
    phase: isStr(o.phase) ? o.phase : 'ok',
    latest,
    ...(typeof o.armed === 'boolean' ? { armed: o.armed } : {}),
    ...(optCount(o.recipient_count) !== undefined ? { recipient_count: optCount(o.recipient_count)! } : {}),
    ...(optCount(o.notify_failures_24h) !== undefined ? { notify_failures_24h: optCount(o.notify_failures_24h)! } : {}),
    ...(optTs(o.paused_until) !== undefined ? { paused_until: optTs(o.paused_until)! } : {}),
    ...(optTs(o.acked_until) !== undefined ? { acked_until: optTs(o.acked_until)! } : {}),
    ...(optTs(o.claimed_at) !== undefined ? { claimed_at: optTs(o.claimed_at)! } : {}),
  };
}

/**
 * Phân tích từng dòng của một danh sách. Dòng hỏng bị BỎ QUA (một thiết bị lạ không được làm trắng cả màn hình);
 * chỉ khi có dòng mà TẤT CẢ đều hỏng thì coi cả phản hồi là sai dạng.
 */
function parseRows<T>(rows: unknown[], parseRow: (v: unknown) => T): T[] {
  const out: T[] = [];
  for (const row of rows) {
    try {
      out.push(parseRow(row));
    } catch {
      /* bỏ qua dòng hỏng */
    }
  }
  if (rows.length > 0 && out.length === 0) return bad();
  return out;
}

export function parseDeviceList(v: unknown): Device[] {
  const o = obj(v);
  if (!Array.isArray(o.devices)) return bad();
  return parseRows(o.devices.slice(0, MAX_DEVICES), parseDevice);
}

/** `server_time` hợp lệ (Unix giây) hoặc undefined. */
export function parseServerTime(v: unknown): number | undefined {
  const t = isObj(v) ? v.server_time : undefined;
  return isNum(t) && t > 1_577_836_800 && t < 4_102_444_800 ? t : undefined;
}

function parsePoint(p: unknown): ReadingPoint {
  const q = obj(p);
  const point = { t: num(q, 't'), avg: num(q, 'avg'), min: num(q, 'min'), max: num(q, 'max') };
  if ([point.avg, point.min, point.max].some((c) => c < PLAUSIBLE_C.min || c > PLAUSIBLE_C.max)) return bad();
  return point;
}

export function parseReadings(v: unknown): Readings {
  const o = obj(v);
  if (!Array.isArray(o.points)) return bad();
  // Nếu quá nhiều thì giữ phần mới nhất (cuối danh sách, đã sắp theo thời gian).
  const rows = o.points.length > MAX_POINTS ? o.points.slice(-MAX_POINTS) : o.points;
  return { min_c: num(o, 'min_c'), max_c: num(o, 'max_c'), points: parseRows(rows, parsePoint) };
}

export function parseRecipient(v: unknown): Recipient {
  const o = obj(v);
  const r: Recipient = { id: num(o, 'id'), name: str(o, 'name'), phone: str(o, 'phone') };
  // Trường Telegram: server cũ không có (vắng mặt). Giá trị lạ bị bỏ qua chứ không làm hỏng người nhận.
  if (o.mode === 'zns' || o.mode === 'both' || o.mode === 'telegram') r.mode = o.mode;
  if (typeof o.telegram_linked === 'boolean') r.telegram_linked = o.telegram_linked;
  return r;
}

export function parseRecipientList(v: unknown): Recipient[] {
  return parseRecipientsResponse(v).recipients;
}

/** `telegram_available` true chỉ khi server nói đúng `true`; vắng/sai kiểu => false (ẩn mọi giao diện Telegram). */
export function parseRecipientsResponse(v: unknown): RecipientsResponse {
  const o = obj(v);
  if (!Array.isArray(o.recipients)) return bad();
  return {
    telegram_available: o.telegram_available === true,
    recipients: parseRows(o.recipients.slice(0, MAX_RECIPIENTS_PARSED), parseRecipient),
  };
}

/** Phản hồi tạo liên kết: url PHẢI là https://t.me/<bot>?start=<mã>, nếu không => bad_response (không bao giờ đưa URL lạ đi tiếp). */
export function parseTelegramLink(v: unknown): TelegramLink {
  const o = obj(v);
  if (!isTelegramUrl(o.url)) return bad();
  return { url: o.url, expires_at: isNum(o.expires_at) && o.expires_at > 0 ? o.expires_at : undefined };
}

/** Phản hồi `{ ok: true, <field>: <Unix giây> }` (ack → acked_until, pause → paused_until). Thiếu/sai mốc thời gian => bad_response. */
export function parseOkUntil(v: unknown, field: 'acked_until' | 'paused_until'): number {
  const o = obj(v);
  if (o.ok !== true) return bad();
  const t = o[field];
  return isNum(t) && t > 0 ? t : bad();
}

/** Phản hồi chỉ cần biết là `{ ok: true }`. */
export function parseOk(v: unknown): void {
  if (obj(v).ok !== true) bad();
}
