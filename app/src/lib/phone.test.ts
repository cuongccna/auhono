import { describe, expect, it } from 'vitest';
import { formatPhone, MAX_RECIPIENTS, normalizePhone, phoneProblem, validateRecipientInput } from './phone.ts';

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


describe('số điện thoại: các cách viết thực tế', () => {
  it.each([
    ['+84 (0) 912 345 678', '84912345678'], // viết thừa số 0 trong ngoặc
    ['+84(0)912345678', '84912345678'],
    ['0084912345678', '84912345678'], // tiền tố quốc tế 00
    ['84 0912 345 678', '84912345678'], // 84 + 0 thừa
    ['０９１２３４５６７８', '84912345678'], // chữ số toàn chiều rộng
    ['0912.345.678', '84912345678'],
    ['(091) 234-5678', '84912345678'],
    ['0912–345–678', '84912345678'], // gạch en-dash do bàn phím tự đổi
  ])('%s => %s', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it.each(['0212345678', '0281234567', '84212345678', '0112345678', '012345678', '091234567', '09123456789', '+1 415 555 0100', '0912 345 67x'])(
    'từ chối %s (số bàn, thiếu/thừa số, nước ngoài)',
    (raw) => {
      expect(normalizePhone(raw)).toBeNull();
    },
  );

  it('mọi đầu số di động hiện hành 03/05/07/08/09 đều được nhận', () => {
    for (const p of ['0331234567', '0561234567', '0771234567', '0881234567', '0991234567']) expect(normalizePhone(p)).toBe('84' + p.slice(1));
    for (const p of ['0131234567', '0231234567', '0431234567', '0631234567']) expect(normalizePhone(p)).toBeNull();
  });

  it('luôn ra đúng dạng mà normalizePhone CỦA SERVER chấp nhận (84 + [35789] + 8 số)', () => {
    for (const raw of ['+84 (0) 912 345 678', '0084912345678', '０９１２３４５６７８']) {
      expect(normalizePhone(raw)).toMatch(/^84[35789]\d{8}$/);
    }
  });
});

describe('phoneProblem: nói rõ sai ở đâu', () => {
  it('số bàn / số 11 số cũ / thiếu số / quá nhiều số / rỗng', () => {
    expect(phoneProblem('0212345678')).toContain('điện thoại bàn');
    expect(phoneProblem('01234567890')).toContain('11 số kiểu cũ');
    expect(phoneProblem('0912')).toContain('thiếu số');
    expect(phoneProblem('09123456789012')).toContain('quá nhiều');
    expect(phoneProblem('')).toContain('Hãy nhập');
  });
});

describe('validateRecipientInput: tên', () => {
  it('tên NFD được đưa về NFC và cắt khoảng trắng trước khi gửi', () => {
    const r = validateRecipientInput('  Bà Hạnh  '.normalize('NFD'), '0912345678');
    expect(r).toEqual({ ok: true, name: 'Bà Hạnh', phone: '84912345678' });
  });
  it('tên 60 ký tự dạng tổ hợp vẫn hợp lệ; 61 ký tự bị từ chối', () => {
    expect(validateRecipientInput('ế'.repeat(60).normalize('NFD'), '0912345678').ok).toBe(true);
    const r = validateRecipientInput('a'.repeat(61), '0912345678');
    expect(r.ok).toBe(false);
  });
  it('tên rỗng / chỉ ký tự vô hình bị từ chối, số sai báo đúng ô', () => {
    const r = validateRecipientInput('\u200B ', 'abc');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.nameError).toBeTruthy();
      expect(r.phoneError).toBeTruthy();
    }
  });
});
