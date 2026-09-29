// Đọc và kiểm tra dữ liệu kích hoạt: từ mã QR trên hộp hoặc do người dùng nhập tay.
//
// Định dạng QR (khớp server/scripts/provision.ts):  auhono://claim?d=AUH-000001&c=XXXXXXXXXX
// Nguyên tắc bảo mật: chuỗi từ QR là DỮ LIỆU KHÔNG TIN CẬY. Ở đây chỉ TÁCH và KIỂM TRA,
// tuyệt đối không mở/điều hướng URL, không dùng `new URL` (tránh khác biệt giữa các webview).
import { foldWidth } from './text.ts';

/** Bảng chữ cái Crockford base32 của mã kích hoạt (khớp server/src/crypto.ts): không có I, L, O, U. */
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{10}$/;
/** Mã thiết bị: cùng quy tắc với server (app.ts `deviceIdRe`). */
const DEVICE_ID_RE = /^[A-Z0-9-]{3,32}$/;
/** Chuẩn in trên hộp: AUH- + 6 chữ số. Cho phép gõ nhầm O/I/L thay cho 0/1. */
const AUH_ID_RE = /^AUH-?([0-9OIL]{6})$/;

/** Mọi loại gạch ngang (bàn phím điện thoại hay tự đổi "-" thành "–"). */
const DASHES = '\\u2010-\\u2015\\u2212-';
/** Khoảng trắng, ký tự vô hình (dán từ tin nhắn Zalo hay mang theo) và các loại gạch ngang. */
const SEPARATORS_RE = new RegExp(`[\\s\\u200B-\\u200D\\u2060\\uFEFF${DASHES}]`, 'g');
const DASHES_RE = new RegExp(`[${DASHES}]`, 'g');

/** Giới hạn độ dài để không xử lý chuỗi khổng lồ do QR lạ. */
const MAX_INPUT_LENGTH = 120;
const QR_PREFIX_RE = /^auhono:\/\/claim\?/i;
/** Phần query chỉ được gồm chữ, số, '-', '=' và '&' (không %, khoảng trắng, #, /...). */
const QR_QUERY_RE = /^[A-Za-z0-9=&-]+$/;
const QR_PARAM_RE = /^([dc])=([A-Za-z0-9-]+)$/i;

/** Chuẩn hóa mã kích hoạt: bỏ khoảng trắng/gạch, không phân biệt hoa thường, sửa O→0, I/L→1. */
export function normalizeActivationCode(raw: string): string | null {
  if (raw.length > MAX_INPUT_LENGTH) return null;
  // NFKC: chữ/số toàn chiều rộng ("ＡＢＣ１２") về ASCII. Bảng chữ của server không có I, L, O, U nên
  // ánh xạ O→0, I/L→1 không bao giờ làm hai mã thật khác nhau trùng nhau (mã thật không chứa các chữ đó).
  const s = foldWidth(raw)
    .toUpperCase()
    .replace(SEPARATORS_RE, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return CODE_RE.test(s) ? s : null;
}

/** Chuẩn hóa mã thiết bị: "auh 000001" / "AUH000001" / "auh–000001" → "AUH-000001". */
export function normalizeDeviceId(raw: string): string | null {
  if (raw.length > MAX_INPUT_LENGTH) return null;
  const s = foldWidth(raw).toUpperCase().replace(/[\s\u200B-\u200D\u2060\uFEFF]+/g, '').replace(DASHES_RE, '-');
  const m = AUH_ID_RE.exec(s);
  if (m) return 'AUH-' + m[1]!.replace(/O/g, '0').replace(/[IL]/g, '1');
  return DEVICE_ID_RE.test(s) ? s : null;
}

export type QrParseResult =
  | { ok: true; deviceId: string; code: string }
  | { ok: false; reason: 'empty' | 'not_auhono' | 'malformed' };

/** Phân tích nội dung mã QR. Chặt: đúng scheme+host, đúng hai tham số d và c, không thừa gì khác. */
export function parseClaimQr(payload: string): QrParseResult {
  const s = payload.trim();
  if (s === '') return { ok: false, reason: 'empty' };
  if (!QR_PREFIX_RE.test(s)) return { ok: false, reason: 'not_auhono' };
  if (s.length > MAX_INPUT_LENGTH) return { ok: false, reason: 'malformed' };

  const query = s.slice(s.indexOf('?') + 1);
  if (!QR_QUERY_RE.test(query)) return { ok: false, reason: 'malformed' };

  const parts = query.split('&');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };

  const values: Partial<Record<'d' | 'c', string>> = {};
  for (const part of parts) {
    const m = QR_PARAM_RE.exec(part);
    if (!m) return { ok: false, reason: 'malformed' };
    const key = m[1]!.toLowerCase() as 'd' | 'c';
    if (values[key] !== undefined) return { ok: false, reason: 'malformed' }; // tham số lặp
    values[key] = m[2]!;
  }

  const deviceId = normalizeDeviceId(values.d ?? '');
  const code = normalizeActivationCode(values.c ?? '');
  if (!deviceId || !code) return { ok: false, reason: 'malformed' };
  return { ok: true, deviceId, code };
}

/** Kiểm tra dữ liệu nhập tay; trả lỗi bằng tiếng Việt cho từng ô. */
export function validateManualClaim(
  rawId: string,
  rawCode: string,
): { ok: true; deviceId: string; code: string } | { ok: false; idError?: string; codeError?: string } {
  // Người dùng dán nguyên đường dẫn auhono://claim?... vào một trong hai ô: đọc như mã QR.
  for (const pasted of [rawId, rawCode]) {
    const qr = parseClaimQr(pasted);
    if (qr.ok) return { ok: true, deviceId: qr.deviceId, code: qr.code };
  }
  const deviceId = normalizeDeviceId(rawId);
  const code = normalizeActivationCode(rawCode);
  if (deviceId && code) return { ok: true, deviceId, code };
  return {
    ok: false,
    idError: deviceId ? undefined : 'Mã thiết bị chưa đúng. Mã có dạng AUH-000001, in trên hộp.',
    codeError: code ? undefined : 'Mã kích hoạt gồm 10 ký tự chữ và số, in cạnh mã QR.',
  };
}
