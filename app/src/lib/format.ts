// Định dạng số/giờ cho người Việt. Giờ Việt Nam = UTC+7, tính bằng số học để kết quả
// không phụ thuộc múi giờ của điện thoại hay của máy chạy test.

/** Việt Nam không có giờ mùa hè: cố định UTC+7. */
export const VN_OFFSET_SECONDS = 7 * 3600;

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Các thành phần ngày giờ theo giờ Việt Nam từ Unix timestamp (giây). */
export function vnParts(tsSeconds: number): { year: number; month: number; day: number; hour: number; minute: number } {
  const d = new Date((tsSeconds + VN_OFFSET_SECONDS) * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

/** "14:05" theo giờ Việt Nam. */
export function formatVnTime(tsSeconds: number): string {
  const p = vnParts(tsSeconds);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** "30/09" theo giờ Việt Nam. */
export function formatVnDate(tsSeconds: number): string {
  const p = vnParts(tsSeconds);
  return `${pad2(p.day)}/${pad2(p.month)}`;
}

/** "14:05 30/09" */
export function formatVnDateTime(tsSeconds: number): string {
  return `${formatVnTime(tsSeconds)} ${formatVnDate(tsSeconds)}`;
}

/** Nhiệt độ kiểu Việt Nam: dấu phẩy thập phân, 1 chữ số. VD: -21,3°C */
export function formatTemp(c: number): string {
  const r = Math.round(c * 10) / 10;
  return `${(Object.is(r, -0) ? 0 : r).toFixed(1).replace('.', ',')}°C`;
}

/** Nhiệt độ ngắn cho trục biểu đồ (không số lẻ nếu là số nguyên). */
export function formatTempShort(c: number): string {
  const r = Math.round(c * 10) / 10;
  return `${Number.isInteger(r) ? r : r.toFixed(1).replace('.', ',')}°`;
}

/** "vừa xong", "5 phút trước", "3 giờ trước", "2 ngày trước". */
export function formatAgo(nowSeconds: number, tsSeconds: number): string {
  const diff = Math.max(0, nowSeconds - tsSeconds);
  if (diff < 60) return 'vừa xong';
  if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`;
  return `${Math.floor(diff / 86400)} ngày trước`;
}
