// Độ tương phản chữ/nền (WCAG AA >= 4.5:1) cho cả giao diện sáng và tối, đọc thẳng từ app.css.
// Đây là kiểm tra TOÁN HỌC trên mã màu, không thay được việc nhìn thử ngoài nắng trên máy thật.
import { describe, expect, it } from 'vitest';
import css from './app.css?raw';

function vars(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Giá trị là mã màu, hoặc var(--zaui-..., #mã-màu-dự-phòng) (lấy màu dự phòng, khi Zalo không cấp biến thì dùng nó).
  for (const m of block.matchAll(/--(auh-[\w-]+):\s*(?:var\([^,)]+,\s*)?(#[0-9a-fA-F]{6})\)?\s*;/g)) out[m[1]!] = m[2]!;
  return out;
}
const light = vars(css.slice(css.indexOf(':root {'), css.indexOf(":root[data-auh-theme='dark']")));
const darkBlock = css.slice(css.indexOf(":root[data-auh-theme='dark']"));
const dark = { ...light, ...vars(darkBlock.slice(0, darkBlock.indexOf('}'))) };

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** [chữ, nền, mô tả] */
const PAIRS: [string, string, string][] = [
  ['auh-text', 'auh-bg', 'chữ chính trên nền trang'],
  ['auh-text', 'auh-card', 'chữ chính trên thẻ'],
  ['auh-muted', 'auh-card', 'chữ phụ trên thẻ'],
  ['auh-muted', 'auh-bg', 'chữ phụ trên nền trang'],
  ['auh-muted', 'auh-neutral-bg', 'huy hiệu "Chưa có dữ liệu"'],
  ['auh-ok', 'auh-ok-bg', 'huy hiệu Bình thường'],
  ['auh-alarm', 'auh-alarm-bg', 'huy hiệu / banner báo động'],
  ['auh-alarm', 'auh-card', 'lỗi dưới ô nhập'],
  ['auh-off', 'auh-off-bg', 'huy hiệu Mất kết nối / banner cảnh báo'],
  ['auh-info', 'auh-info-bg', 'banner thông tin / nút phụ'],
  ['auh-on-primary', 'auh-primary', 'chữ trên nút chính'],
  ['auh-text', 'auh-input-bg', 'chữ trong ô nhập'],
];

describe.each([
  ['sáng', light],
  ['tối', dark],
] as const)('độ tương phản giao diện %s', (_name, theme) => {
  it.each(PAIRS)('%s trên %s (%s) >= 4.5:1', (fg, bg, _desc) => {
    expect(theme[fg], `thiếu biến ${fg}`).toBeDefined();
    expect(theme[bg], `thiếu biến ${bg}`).toBeDefined();
    expect(contrast(theme[fg]!, theme[bg]!)).toBeGreaterThanOrEqual(4.5);
  });
});
