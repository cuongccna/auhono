import { describe, expect, it } from 'vitest';
import { formatPhone, MAX_RECIPIENTS, normalizePhone, validateRecipientInput } from './phone.ts';

// Các ca dưới đây khớp server/test/owner-api.test.ts ("người nhận cảnh báo").
describe('normalizePhone', () => {
  it.each([
    ['0912345678', '84912345678'],
    ['+84 912 345 678', '84912345678'],
    ['84912345678', '84912345678'],
    ['+84 912 345 679', '84912345679'],
    ['0912-345-679', '84912345679'],
    ['0912.345.679', '84912345679'],
    ['(0912) 345 679', '84912345679'],
    ['  0912345678  ', '84912345678'],
  ])('chấp nhận %s', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it.each([
    ['123'],
    ['0212345678'], // đầu số không phải di động (điện thoại bàn)
    ['abc'],
    [''],
    ['091234567'], // thiếu số
    ['09123456789'], // thừa số
    ['0112345678'],
    ['912345678'], // thiếu số 0 đầu
    ['+1 555 123 4567'],
    ['0912345678; DROP TABLE'],
    ['0'.repeat(30)],
  ])('từ chối %j', (raw) => {
    expect(normalizePhone(raw)).toBeNull();
  });
});

describe('formatPhone', () => {
  it('hiển thị dễ đọc', () => {
    expect(formatPhone('84912345678')).toBe('0912 345 678');
    expect(formatPhone('lạ')).toBe('lạ');
  });
});

describe('validateRecipientInput', () => {
  it('hợp lệ: cắt tên, chuẩn hóa số', () => {
    expect(validateRecipientInput('  Vợ ', '0912 345 678')).toEqual({ ok: true, name: 'Vợ', phone: '84912345678' });
  });
  it('lỗi theo từng ô', () => {
    const r = validateRecipientInput('', '123');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.nameError).toBeTruthy();
      expect(r.phoneError).toBeTruthy();
    }
    const r2 = validateRecipientInput('x'.repeat(61), '0912345678');
    if (!r2.ok) expect(r2.nameError).toContain('60');
  });
  it('tối đa 5 người như server', () => {
    expect(MAX_RECIPIENTS).toBe(5);
  });
});
