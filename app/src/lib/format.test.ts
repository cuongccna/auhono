import { describe, expect, it } from 'vitest';
import { formatAgo, formatTemp, formatTempShort, formatVnDate, formatVnDateTime, formatVnTime } from './format.ts';

describe('giờ Việt Nam (UTC+7)', () => {
  // 2026-09-29T17:30:00Z = 00:30 ngày 30/09 giờ Việt Nam
  const t = Date.UTC(2026, 8, 29, 17, 30) / 1000;
  it('đổi sang UTC+7 bất kể múi giờ máy', () => {
    expect(formatVnTime(t)).toBe('00:30');
    expect(formatVnDate(t)).toBe('30/09');
    expect(formatVnDateTime(t)).toBe('00:30 30/09');
  });
  it('0 giờ UTC là 07:00', () => {
    expect(formatVnTime(Date.UTC(2026, 0, 1) / 1000)).toBe('07:00');
  });
});

describe('định dạng số', () => {
  it('nhiệt độ dùng dấu phẩy', () => {
    expect(formatTemp(-21.34)).toBe('-21,3°C');
    expect(formatTemp(4)).toBe('4,0°C');
    expect(formatTemp(-0.04)).toBe('0,0°C');
    expect(formatTempShort(-18)).toBe('-18°');
    expect(formatTempShort(2.5)).toBe('2,5°');
  });
  it('thời gian tương đối', () => {
    expect(formatAgo(1000, 990)).toBe('vừa xong');
    expect(formatAgo(1000, 1000 - 5 * 60)).toBe('5 phút trước');
    expect(formatAgo(10000, 10000 - 3 * 3600)).toBe('3 giờ trước');
    expect(formatAgo(500000, 500000 - 2 * 86400)).toBe('2 ngày trước');
  });
});
