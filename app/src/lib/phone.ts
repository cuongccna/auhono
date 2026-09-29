// Số điện thoại di động Việt Nam: chuẩn hóa RỘNG HƠN server (server/src/app.ts `normalizePhone`) một chút
// (chịu "(0)", "00", chữ số toàn chiều rộng) nhưng luôn gửi lên dạng chuẩn 84xxxxxxxxx mà server nhận được,
// để báo lỗi sớm ngay trên máy, không phải chờ server từ chối.
import { cleanText, foldWidth, NAME_MAX, validateName } from './text.ts';

/** Server giới hạn chuỗi gửi lên tối đa 20 ký tự. */
export const PHONE_MAX_INPUT = 20;

/**
 * Về dạng 84xxxxxxxxx (định dạng ZNS). null nếu không hợp lệ. Chấp nhận các cách người Việt hay viết:
 * 0912345678 · 0912.345.678 · +84 912 345 678 · 84912345678 · 0084912345678 · +84 (0) 912 345 678 · chữ số toàn chiều rộng.
 * App luôn gửi dạng chuẩn 84xxxxxxxxx nên server (không biết "(0)" hay "00") vẫn nhận đúng.
 */
export function normalizePhone(raw: string): string | null {
  if (raw.length > PHONE_MAX_INPUT) return null;
  let digits = foldWidth(raw)
    .replace(/\(0\)/g, '') // "+84 (0) 912..." — số 0 trong ngoặc là số 0 đầu của cách gọi trong nước
    .replace(/[\s.\-()\u2010-\u2015\u2212]/g, '')
    .replace(/^\+/, '');
  if (digits.startsWith('00')) digits = digits.slice(2); // tiền tố quốc tế 00
  if (/^840\d{9}$/.test(digits)) digits = '84' + digits.slice(3); // 84 + 0 + 9 số (viết thừa số 0)
  const n = digits.startsWith('84') ? digits : digits.startsWith('0') ? '84' + digits.slice(1) : digits;
  return /^84[35789]\d{8}$/.test(n) ? n : null;
}

/** Lý do cụ thể vì sao số bị từ chối, để người dùng biết sửa gì (thay vì một câu chung). */
export function phoneProblem(raw: string): string {
  const digits = foldWidth(raw).replace(/\D/g, '');
  if (digits.length === 0) return 'Hãy nhập số điện thoại, ví dụ 0912 345 678.';
  if (/^01\d{9}$/.test(digits)) {
    return 'Đây là số 11 số kiểu cũ. Số di động hiện nay có 10 số (bắt đầu 03, 05, 07, 08, 09). Hãy nhập số đang dùng.';
  }
  if (/^(0|84)2/.test(digits)) return 'Đây là số điện thoại bàn. Hãy nhập số di động có Zalo, ví dụ 0912 345 678.';
  if (digits.length < 9) return 'Số điện thoại còn thiếu số. Số di động Việt Nam có 10 số, ví dụ 0912 345 678.';
  if (digits.length > 12) return 'Số điện thoại có quá nhiều số. Số di động Việt Nam có 10 số, ví dụ 0912 345 678.';
  return 'Số điện thoại chưa đúng. Hãy nhập số di động Việt Nam (03, 05, 07, 08, 09), ví dụ 0912 345 678.';
}

/** Hiển thị dễ đọc: 84912345678 → 0912 345 678. Chuỗi lạ thì trả nguyên. */
export function formatPhone(normalized: string): string {
  const m = /^84(\d{3})(\d{3})(\d{3})$/.exec(normalized);
  return m ? `0${m[1]} ${m[2]} ${m[3]}` : normalized;
}

/** Server cho tối đa 5 người nhận mỗi thiết bị. */
export const MAX_RECIPIENTS = 5;
export const RECIPIENT_NAME_MAX = NAME_MAX;

/** Kiểm tra form thêm người nhận; lỗi tiếng Việt gắn theo từng ô. Tên được chuẩn hóa NFC trước khi đếm ký tự. */
export function validateRecipientInput(
  rawName: string,
  rawPhone: string,
): { ok: true; name: string; phone: string } | { ok: false; nameError?: string; phoneError?: string } {
  const name = validateName(rawName, 'Hãy nhập tên người nhận, ví dụ "Vợ" hoặc "Quản lý".');
  const phone = normalizePhone(cleanText(rawPhone));
  if (name.ok && phone) return { ok: true, name: name.value, phone };
  return {
    ok: false,
    nameError: name.ok ? undefined : name.error,
    phoneError: phone ? undefined : phoneProblem(rawPhone),
  };
}
