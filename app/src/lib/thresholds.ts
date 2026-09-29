// Ngưỡng cảnh báo: gợi ý sẵn theo loại tủ + kiểm tra hợp lệ giống server (patchSchema trong app.ts).

export type Kind = 'freezer' | 'chiller';

export const KIND_LABEL: Record<Kind, string> = { freezer: 'Tủ đông', chiller: 'Tủ mát' };

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

/** Đọc số người dùng gõ: chấp nhận dấu phẩy "−18,5" và dấu trừ Unicode. null nếu không phải số. */
export function parseNumberInput(raw: string): number | null {
  const s = raw.trim().replace(/[−–—]/g, '-').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
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
