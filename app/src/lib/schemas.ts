// Kiểm tra dữ liệu server trả về ngay tại biên (viết tay để bundle nhỏ, không cần thư viện schema).
// Dữ liệu sai dạng => ném AppError('bad_response') thay vì để giao diện hiển thị "NaN"/lỗi khó hiểu.

import { AppError } from './errors.ts';
import type { ReadingPoint } from './chart.ts';
import type { Kind } from './thresholds.ts';

export interface Device {
  id: string;
  name: string;
  kind: Kind;
  min_c: number;
  max_c: number;
  breach_minutes: number;
  /** Unix giây; null nếu chưa từng nhận số đo. */
  last_seen: number | null;
  firmware: string | null;
  /** 'ok' | 'temp_alarm' | 'offline' (giữ chuỗi để chịu được giá trị mới trong tương lai). */
  phase: string;
  latest: { ts: number; temp_c: number } | null;
}

export interface Readings {
  min_c: number;
  max_c: number;
  points: ReadingPoint[];
}

export interface Recipient {
  id: number;
  name: string;
  /** Dạng 84xxxxxxxxx. */
  phone: string;
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

export function parseDevice(v: unknown): Device {
  const o = obj(v);
  const kind = o.kind;
  if (kind !== 'freezer' && kind !== 'chiller') return bad();
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
  };
}

export function parseDeviceList(v: unknown): Device[] {
  const o = obj(v);
  if (!Array.isArray(o.devices)) return bad();
  return o.devices.map(parseDevice);
}

export function parseReadings(v: unknown): Readings {
  const o = obj(v);
  if (!Array.isArray(o.points)) return bad();
  const points = o.points.map((p): ReadingPoint => {
    const q = obj(p);
    return { t: num(q, 't'), avg: num(q, 'avg'), min: num(q, 'min'), max: num(q, 'max') };
  });
  return { min_c: num(o, 'min_c'), max_c: num(o, 'max_c'), points };
}

export function parseRecipient(v: unknown): Recipient {
  const o = obj(v);
  return { id: num(o, 'id'), name: str(o, 'name'), phone: str(o, 'phone') };
}

export function parseRecipientList(v: unknown): Recipient[] {
  const o = obj(v);
  if (!Array.isArray(o.recipients)) return bad();
  return o.recipients.map(parseRecipient);
}

/** Phản hồi chỉ cần biết là `{ ok: true }`. */
export function parseOk(v: unknown): void {
  if (obj(v).ok !== true) bad();
}
