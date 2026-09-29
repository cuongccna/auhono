import { describe, expect, it } from 'vitest';
import { KIND_PRESETS, parseNumberInput, validateThresholds } from './thresholds.ts';

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
