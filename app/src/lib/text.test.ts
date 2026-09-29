import { describe, expect, it } from 'vitest';
import { cleanText, foldWidth, NAME_MAX, validateName } from './text.ts';

// "Tủ đông" ở dạng dựng sẵn (NFC) và dạng tổ hợp (NFD: chữ cái + dấu rời) — bàn phím iOS/Android có thể gửi cả hai.
const NFC = 'Tủ đông hải sản'.normalize('NFC');
const NFD = 'Tủ đông hải sản'.normalize('NFD');

describe('cleanText', () => {
  it('đưa chữ Việt dạng tổ hợp (NFD) về NFC', () => {
    expect(NFD).not.toBe(NFC);
    expect(NFD.length).toBeGreaterThan(NFC.length);
    expect(cleanText(NFD)).toBe(NFC);
  });
  it('cắt khoảng trắng đầu/cuối, gộp khoảng trắng và xuống dòng thành một dấu cách', () => {
    expect(cleanText('  Tủ   kem \n\t mới  ')).toBe('Tủ kem mới');
    expect(cleanText('\u00A0Tủ\u00A0kem\u3000')).toBe('Tủ kem');
  });
  it('bỏ ký tự vô hình / điều khiển / đổi chiều chữ (dán từ tin nhắn)', () => {
    expect(cleanText('Tủ\u200B kem\u0000\u202E')).toBe('Tủ kem');
    expect(cleanText('\uFEFFTủ kem')).toBe('Tủ kem');
  });
  it('giữ emoji ghép (ZWJ ở giữa) nhưng bỏ ZWJ lẻ loi', () => {
    const family = '👨\u200D👩\u200D👧';
    expect(cleanText(`Tủ ${family}`)).toBe(`Tủ ${family}`);
    expect(cleanText('\u200D\u200C')).toBe('');
    expect(cleanText('Tủ \u200D kem\u200D')).toBe('Tủ kem');
  });
  it('giữ emoji hợp lệ, bỏ nửa cặp surrogate lẻ', () => {
    expect(cleanText('Tủ kem 🍦')).toBe('Tủ kem 🍦');
    expect(cleanText('Tủ\uD83C')).toBe('Tủ'); // nửa đầu của emoji bị cắt
    expect(cleanText('\uDF66Tủ')).toBe('Tủ');
  });
});

describe('validateName (giống server: 1..60 ký tự sau khi cắt)', () => {
  const empty = 'trống';
  it('tên bình thường', () => {
    expect(validateName('  Tủ kem  ', empty)).toEqual({ ok: true, value: 'Tủ kem' });
  });
  it('rỗng hoặc chỉ khoảng trắng/ký tự vô hình => lỗi hướng dẫn', () => {
    for (const raw of ['', '   ', '\n', '\u200B\u200B']) expect(validateName(raw, empty)).toEqual({ ok: false, error: empty });
  });
  it('độ dài đếm SAU khi NFC: 60 ký tự dạng tổ hợp (~100 đơn vị) vẫn hợp lệ', () => {
    const name60 = 'ế'.repeat(NAME_MAX); // 60 ký tự NFC
    const decomposed = name60.normalize('NFD');
    expect(decomposed.length).toBeGreaterThan(NAME_MAX);
    expect(validateName(decomposed, empty)).toEqual({ ok: true, value: name60 });
    expect(validateName('a'.repeat(NAME_MAX + 1), empty).ok).toBe(false);
  });
  it('emoji tính 2 đơn vị như server (z.string().max đếm UTF-16)', () => {
    expect(validateName('🍦'.repeat(30), empty).ok).toBe(true); // 60 đơn vị
    const r = validateName('🍦'.repeat(31), empty); // 62 đơn vị
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('60');
  });
});

describe('foldWidth', () => {
  it('chữ số/chữ toàn chiều rộng về ASCII', () => {
    expect(foldWidth('０９１２ＡＢＣ')).toBe('0912ABC');
    expect(foldWidth('－１８')).toBe('-18');
  });
});
