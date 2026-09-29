import { describe, expect, it } from 'vitest';
import { currentTempWarning, describeThresholds, kindLabel, KIND_PRESETS, parseNumberInput, validateThresholds } from './thresholds.ts';

describe('parseNumberInput', () => {
  it('đọc số nguyên, số lẻ, dấu phẩy, dấu trừ Unicode', () => {
    expect(parseNumberInput('-18')).toBe(-18);
    expect(parseNumberInput(' 2,5 ')).toBe(2.5);
    expect(parseNumberInput('−20')).toBe(-20);
    expect(parseNumberInput('0')).toBe(0);
  });
  it('từ chối chuỗi không phải số', () => {
    for (const s of ['', 'abc', '1e3', '--1', '1.2.3', '0x10', 'Infinity', '- 5', '5°']) expect(parseNumberInput(s)).toBeNull();
  });
});

describe('validateThresholds (giống patchSchema của server)', () => {
  const ok = { min: '-40', max: '-18', breach: '15' };

  it('hợp lệ', () => {
    expect(validateThresholds(ok)).toEqual({ ok: true, value: { min_c: -40, max_c: -18, breach_minutes: 15 } });
  });

  it('biên: -60..30 và 5..60 phút đều được', () => {
    expect(validateThresholds({ min: '-60', max: '30', breach: '5' }).ok).toBe(true);
    expect(validateThresholds({ min: '-60', max: '30', breach: '60' }).ok).toBe(true);
  });

  it('min phải nhỏ hơn max (bằng nhau cũng sai, như server `bad_range`)', () => {
    const r = validateThresholds({ min: '5', max: '5', breach: '15' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.max).toBeTruthy();
    expect(validateThresholds({ min: '9', max: '3', breach: '15' }).ok).toBe(false);
  });

  it('ngoài khoảng -60..30', () => {
    const r = validateThresholds({ min: '-61', max: '31', breach: '15' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.min).toBeTruthy();
      expect(r.errors.max).toBeTruthy();
    }
  });

  it('số phút phải là số nguyên 5..60', () => {
    for (const breach of ['4', '61', '10.5', 'abc', '']) {
      const r = validateThresholds({ ...ok, breach });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.breach).toBeTruthy();
    }
  });

  it('ô trống / không phải số báo lỗi ở đúng ô', () => {
    const r = validateThresholds({ min: '', max: 'x', breach: '15' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.min).toBeTruthy();
      expect(r.errors.max).toBeTruthy();
      expect(r.errors.breach).toBeUndefined();
    }
  });

  it('các preset đều hợp lệ và khớp server', () => {
    expect(KIND_PRESETS.freezer).toMatchObject({ min_c: -40, max_c: -18 });
    expect(KIND_PRESETS.chiller).toMatchObject({ min_c: 2, max_c: 8 });
    for (const k of ['freezer', 'chiller'] as const) {
      const p = KIND_PRESETS[k];
      expect(validateThresholds({ min: String(p.min_c), max: String(p.max_c), breach: '15' }).ok).toBe(true);
    }
  });
});

describe('parseNumberInput: bàn phím tiếng Việt', () => {
  it('dấu phẩy thập phân, dấu trừ Unicode các loại, chữ số toàn chiều rộng', () => {
    expect(parseNumberInput('-18,5')).toBe(-18.5);
    expect(parseNumberInput('−18,5')).toBe(-18.5); // U+2212
    expect(parseNumberInput('–18')).toBe(-18); // en dash
    expect(parseNumberInput('—18')).toBe(-18); // em dash
    expect(parseNumberInput('‐18')).toBe(-18); // U+2010 hyphen
    expect(parseNumberInput('－１８')).toBe(-18); // toàn chiều rộng
    expect(parseNumberInput('１２,５')).toBe(12.5);
    expect(parseNumberInput('+5')).toBe(5);
    expect(parseNumberInput('.5')).toBe(0.5);
    expect(parseNumberInput('5.')).toBe(5);
  });
  it('"-0" là 0 (không gửi -0 lên server)', () => {
    expect(Object.is(parseNumberInput('-0'), 0)).toBe(true);
  });
  it('từ chối: hai dấu phẩy, nghìn, chữ, khoảng trắng giữa, quá dài', () => {
    for (const s of ['1,2,3', '1.000,5', '-', ',', '1 8', '-18°C', 'một', '1'.repeat(30)]) expect(parseNumberInput(s)).toBeNull();
  });
  it('validateThresholds nhận dạng gõ bằng dấu phẩy / dấu trừ Unicode / toàn chiều rộng', () => {
    expect(validateThresholds({ min: '−40', max: '-18,5', breach: '１５' })).toEqual({
      ok: true,
      value: { min_c: -40, max_c: -18.5, breach_minutes: 15 },
    });
  });
});

describe('currentTempWarning: tủ đông gia đình chạy -12°C', () => {
  it('nhiệt độ hiện tại nóng hơn ngưỡng cao nhất mới => cảnh báo (câu chữ theo yêu cầu)', () => {
    const w = currentTempWarning({ current: -12, min: -40, max: -18 });
    expect(w).toContain('Nhiệt độ hiện tại -12,0°C đang vượt ngưỡng mới; báo động sẽ chỉ bật sau khi tủ đạt ngưỡng');
    expect(w).toContain('nâng "Cao nhất"');
  });
  it('lạnh hơn ngưỡng thấp nhất mới => cảnh báo và gợi ý hạ "Thấp nhất"', () => {
    const w = currentTempWarning({ current: 1, min: 2, max: 8 });
    expect(w).toContain('đang vượt ngưỡng mới');
    expect(w).toContain('hạ "Thấp nhất"');
  });
  it('trong ngưỡng, sát biên, thiếu số đo hoặc ô chưa nhập hợp lệ => không cảnh báo', () => {
    expect(currentTempWarning({ current: -20, min: -40, max: -18 })).toBeNull();
    expect(currentTempWarning({ current: -18, min: -40, max: -18 })).toBeNull();
    expect(currentTempWarning({ current: null, min: -40, max: -18 })).toBeNull();
    expect(currentTempWarning({ current: NaN, min: -40, max: -18 })).toBeNull();
    expect(currentTempWarning({ current: -12, min: null, max: null })).toBeNull();
  });
  it('mô tả bằng lời + nhãn loại tủ lạ', () => {
    expect(describeThresholds({ min_c: -40, max_c: -18, breach_minutes: 15 })).toBe(
      'Sẽ báo khi nhiệt độ nóng hơn -18,0°C hoặc lạnh hơn -40,0°C liên tục 15 phút.',
    );
    expect(kindLabel('other')).toBe('Tủ');
    expect(kindLabel('chiller')).toBe('Tủ mát');
  });
});
