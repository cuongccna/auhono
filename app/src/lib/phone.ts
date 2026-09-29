// Số điện thoại di động Việt Nam: chuẩn hóa giống hệt server (server/src/app.ts `normalizePhone`)
// để báo lỗi sớm ngay trên máy, không phải chờ server từ chối.

/** Server giới hạn chuỗi gửi lên tối đa 20 ký tự. */
export const PHONE_MAX_INPUT = 20;

/** Về dạng 84xxxxxxxxx (định dạng ZNS). null nếu không hợp lệ. */
export function normalizePhone(raw: string): string | null {
  if (raw.length > PHONE_MAX_INPUT) return null;
  const digits = raw.replace(/[\s.\-()]/g, '').replace(/^\+/, '');
  const n = digits.startsWith('84') ? digits : digits.startsWith('0') ? '84' + digits.slice(1) : digits;
  return /^84[35789]\d{8}$/.test(n) ? n : null;
}

/** Hiển thị dễ đọc: 84912345678 → 0912 345 678. Chuỗi lạ thì trả nguyên. */
export function formatPhone(normalized: string): string {
  const m = /^84(\d{3})(\d{3})(\d{3})$/.exec(normalized);
  return m ? `0${m[1]} ${m[2]} ${m[3]}` : normalized;
}

/** Server cho tối đa 5 người nhận mỗi thiết bị. */
export const MAX_RECIPIENTS = 5;
export const RECIPIENT_NAME_MAX = 60;

/** Kiểm tra form thêm người nhận; lỗi tiếng Việt gắn theo từng ô. */
export function validateRecipientInput(
  rawName: string,
  rawPhone: string,
): { ok: true; name: string; phone: string } | { ok: false; nameError?: string; phoneError?: string } {
  const name = rawName.trim();
  const phone = normalizePhone(rawPhone.trim());
  const nameError =
    name.length === 0
      ? 'Hãy nhập tên người nhận, ví dụ "Vợ" hoặc "Quản lý".'
      : name.length > RECIPIENT_NAME_MAX
        ? `Tên tối đa ${RECIPIENT_NAME_MAX} ký tự.`
        : undefined;
  const phoneError = phone ? undefined : 'Số điện thoại chưa đúng. Hãy nhập số di động Việt Nam, ví dụ 0912 345 678.';
  if (!nameError && phone) return { ok: true, name, phone };
  return { ok: false, nameError, phoneError };
}
