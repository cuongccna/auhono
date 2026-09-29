// Ngưỡng cảnh báo: gợi ý sẵn theo loại tủ + kiểm tra hợp lệ giống server (patchSchema trong app.ts).
import { formatTemp } from './format.ts';
import { foldWidth } from './text.ts';

export type Kind = 'freezer' | 'chiller';

export const KIND_LABEL: Record<Kind, string> = { freezer: 'Tủ đông', chiller: 'Tủ mát' };

/** Nhãn cho cả loại tủ mà app chưa biết (server thêm loại mới). */
export function kindLabel(kind: Kind | 'other'): string {
  return kind === 'other' ? 'Tủ' : KIND_LABEL[kind];
}

/** Khớp KIND_PRESETS của server (server/src/types.ts). Người dùng chọn loại tủ, không tự nghĩ con số. */
export const KIND_PRESETS: Record<Kind, { min_c: number; max_c: number; hint: string }> = {
  freezer: { min_c: -40, max_c: -18, hint: 'Báo khi nóng hơn -18°C' },
  chiller: { min_c: 2, max_c: 8, hint: 'Báo khi ngoài khoảng 2°C đến 8°C' },
};

/** Giới hạn của server. */
export const TEMP_LIMIT = { min: -60, max: 30 } as const;
export const BREACH_LIMIT = { min: 5, max: 60 } as const;
export const DEFAULT_BREACH_MINUTES = 15;

export interface ThresholdValues {
  min_c: number;
  max_c: number;
  breach_minutes: number;
}

export type ThresholdErrors = Partial<Record<'min' | 'max' | 'breach', string>>;

/**
 * Đọc số người dùng gõ. Bàn phím tiếng Việt cho ra "-18,5" (dấu phẩy), "−18" (dấu trừ Unicode), "－１８" (toàn chiều rộng):
 * tất cả đều được chấp nhận. Dạng khoa học ("1e3"), nhiều dấu, chữ lạ => null.
 */
export function parseNumberInput(raw: string): number | null {
  if (raw.length > 24) return null;
  const s = foldWidth(raw)
    .trim()
    .replace(/[\u2010-\u2015\u2212\uFE63\uFF0D]/g, '-') // mọi loại dấu gạch/dấu trừ
    .replace(',', '.');
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n === 0 ? 0 : n; // "-0" => 0
}

/**
 * Cảnh báo khi nhiệt độ HIỆN TẠI của tủ đã nằm ngoài khoảng ngưỡng đang định đặt.
 * Ví dụ tủ đông gia đình chạy -12°C mà chọn "Tủ đông" (-18): báo động sẽ không kêu ngay mà chỉ bật khi tủ từng đạt ngưỡng.
 * Trả null nếu không có gì đáng lo (hoặc thiếu dữ liệu).
 */
export function currentTempWarning(input: { current: number | null; min: number | null; max: number | null }): string | null {
  const { current, min, max } = input;
  if (current === null || !Number.isFinite(current)) return null;
  const hot = max !== null && current > max;
  const cold = min !== null && current < min;
  if (!hot && !cold) return null;
  const now = formatTemp(current);
  const tail = hot
    ? 'Nếu tủ của bạn vốn chạy ở mức này, hãy nâng "Cao nhất" lên cho phù hợp.'
    : 'Nếu tủ của bạn vốn chạy ở mức này, hãy hạ "Thấp nhất" xuống cho phù hợp.';
  return `Nhiệt độ hiện tại ${now} đang vượt ngưỡng mới; báo động sẽ chỉ bật sau khi tủ đạt ngưỡng. ${tail}`;
}

/** Một câu giải thích ngưỡng bằng lời, dùng làm bản xem trước trong form. */
export function describeThresholds(v: ThresholdValues): string {
  return `Sẽ báo khi nhiệt độ nóng hơn ${formatTemp(v.max_c)} hoặc lạnh hơn ${formatTemp(v.min_c)} liên tục ${v.breach_minutes} phút.`;
}

/** Kiểm tra 3 ô "Nâng cao". Thông báo lỗi tiếng Việt, gắn vào từng ô. */
export function validateThresholds(input: {
  min: string;
  max: string;
  breach: string;
}): { ok: true; value: ThresholdValues } | { ok: false; errors: ThresholdErrors } {
  const errors: ThresholdErrors = {};
  const min = parseNumberInput(input.min);
  const max = parseNumberInput(input.max);
  const breach = parseNumberInput(input.breach);
  const range = `từ ${TEMP_LIMIT.min} đến ${TEMP_LIMIT.max}°C`;

  if (min === null) errors.min = 'Hãy nhập một con số, ví dụ -40.';
  else if (min < TEMP_LIMIT.min || min > TEMP_LIMIT.max) errors.min = `Nhiệt độ thấp nhất phải ${range}.`;

  if (max === null) errors.max = 'Hãy nhập một con số, ví dụ -18.';
  else if (max < TEMP_LIMIT.min || max > TEMP_LIMIT.max) errors.max = `Nhiệt độ cao nhất phải ${range}.`;

  if (!errors.min && !errors.max && min! >= max!) {
    errors.max = 'Nhiệt độ cao nhất phải lớn hơn nhiệt độ thấp nhất.';
  }

  if (breach === null || !Number.isInteger(breach) || breach < BREACH_LIMIT.min || breach > BREACH_LIMIT.max) {
    errors.breach = `Số phút phải là số nguyên từ ${BREACH_LIMIT.min} đến ${BREACH_LIMIT.max}.`;
  }

  if (errors.min || errors.max || errors.breach) return { ok: false, errors };
  return { ok: true, value: { min_c: min!, max_c: max!, breach_minutes: breach! } };
}
