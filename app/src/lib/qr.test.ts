import { describe, expect, it } from 'vitest';
import { normalizeActivationCode, normalizeDeviceId, parseClaimQr, validateManualClaim } from './qr.ts';

const CODE = 'ABCDEFGHJK'; // 10 ký tự thuộc bảng chữ Crockford (không có I, L, O, U)

describe('parseClaimQr', () => {
  it('chấp nhận mã QR hợp lệ (đúng định dạng provision.ts tạo ra)', () => {
    expect(parseClaimQr(`auhono://claim?d=AUH-000001&c=${CODE}`)).toEqual({ ok: true, deviceId: 'AUH-000001', code: CODE });
  });

  it('bỏ khoảng trắng đầu/cuối, chấp nhận thứ tự tham số đảo và scheme viết hoa', () => {
    expect(parseClaimQr(`  AUHONO://CLAIM?c=${CODE}&d=AUH-000042\n`)).toEqual({ ok: true, deviceId: 'AUH-000042', code: CODE });
  });

  it('chịu được mã viết thường và có gạch ngăn cách', () => {
    expect(parseClaimQr('auhono://claim?d=auh-000001&c=abcde-fghjk')).toEqual({ ok: true, deviceId: 'AUH-000001', code: CODE });
  });

  it('chuỗi rỗng', () => {
    expect(parseClaimQr('')).toEqual({ ok: false, reason: 'empty' });
    expect(parseClaimQr('   ')).toEqual({ ok: false, reason: 'empty' });
  });

  it.each([
    ['sai scheme', `https://claim?d=AUH-000001&c=${CODE}`],
    ['scheme lạ', `javascript:alert(1)`],
    ['sai host', `auhono://evil?d=AUH-000001&c=${CODE}`],
    ['host có userinfo', `auhono://claim@evil.example/?d=AUH-000001&c=${CODE}`],
    ['URL web', 'https://example.com/claim?d=AUH-000001&c=' + CODE],
    ['văn bản thường', 'xin chao'],
    ['không có ?', `auhono://claim/d=AUH-000001&c=${CODE}`],
  ])('không phải mã Auhono: %s', (_label, payload) => {
    expect(parseClaimQr(payload)).toEqual({ ok: false, reason: 'not_auhono' });
  });

  it.each([
    ['thiếu c', 'auhono://claim?d=AUH-000001'],
    ['thiếu d', `auhono://claim?c=${CODE}`],
    ['tham số thừa', `auhono://claim?d=AUH-000001&c=${CODE}&redirect=https://evil.example`],
    ['tham số thừa (open)', `auhono://claim?d=AUH-000001&c=${CODE}&open=1`],
    ['tham số lặp', `auhono://claim?d=AUH-000001&d=AUH-000002&c=${CODE}`],
    ['tên tham số sai', `auhono://claim?id=AUH-000001&code=${CODE}`],
    ['có fragment', `auhono://claim?d=AUH-000001&c=${CODE}#x`],
    ['ký tự % (mã hóa URL)', `auhono://claim?d=AUH-000001&c=${CODE}%00`],
    ['thẻ script', `auhono://claim?d=AUH-000001&c=<script>alert(1)</script>`],
    ['dấu nháy / SQL', `auhono://claim?d=AUH-000001'--&c=${CODE}`],
    ['xuống dòng chen giữa', `auhono://claim?d=AUH-000001\n&c=${CODE}`],
    ['khoảng trắng chen giữa', `auhono://claim?d=AUH 000001&c=${CODE}`],
    ['đường dẫn lạ', `auhono://claim?d=../../etc/passwd&c=${CODE}`],
    ['mã có ký tự ngoài bảng (U)', 'auhono://claim?d=AUH-000001&c=ABCDEFGHUK'],
    ['mã quá ngắn', 'auhono://claim?d=AUH-000001&c=ABCDE'],
    ['mã quá dài', `auhono://claim?d=AUH-000001&c=${CODE}${CODE}`],
    ['giá trị rỗng', 'auhono://claim?d=&c='],
    ['dấu & thừa', `auhono://claim?d=AUH-000001&c=${CODE}&`],
    ['payload quá dài', `auhono://claim?d=AUH-000001&c=${CODE}&x=${'a'.repeat(500)}`],
  ])('đúng scheme nhưng sai nội dung: %s', (_label, payload) => {
    expect(parseClaimQr(payload)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('normalizeActivationCode (nhập tay)', () => {
  it('không phân biệt hoa thường, bỏ khoảng trắng và mọi loại gạch', () => {
    expect(normalizeActivationCode('abcdefghjk')).toBe(CODE);
    expect(normalizeActivationCode(' abcde fghjk ')).toBe(CODE);
    expect(normalizeActivationCode('ABCDE-FGHJK')).toBe(CODE);
    expect(normalizeActivationCode('abcde–fghjk')).toBe(CODE); // gạch dài do bàn phím tự đổi
  });

  it('sửa nhầm lẫn kiểu Crockford: O→0, I/L→1', () => {
    expect(normalizeActivationCode('O1234ABCDE')).toBe('01234ABCDE');
    expect(normalizeActivationCode('OOOOOOOOOO')).toBe('0000000000');
    expect(normalizeActivationCode('IIIIILLLLL')).toBe('1111111111');
  });

  it('từ chối U, ký tự lạ, sai độ dài', () => {
    expect(normalizeActivationCode('UUUUUUUUUU')).toBeNull();
    expect(normalizeActivationCode('ABCDEFGHJ')).toBeNull();
    expect(normalizeActivationCode('ABCDEFGHJKM')).toBeNull();
    expect(normalizeActivationCode('ABCDE_FGHJK')).toBeNull();
    expect(normalizeActivationCode('')).toBeNull();
    expect(normalizeActivationCode('A'.repeat(1000))).toBeNull();
  });
});

describe('normalizeDeviceId', () => {
  it('đưa các cách gõ về AUH-000001', () => {
    for (const raw of ['AUH-000001', 'auh-000001', 'AUH000001', 'auh 000001', ' AUH – 000001 ', 'AUH-OOOOO1']) {
      expect(normalizeDeviceId(raw)).toBe('AUH-000001');
    }
  });

  it('chấp nhận định dạng khác miễn khớp quy tắc của server, từ chối phần còn lại', () => {
    expect(normalizeDeviceId('xyz-12')).toBe('XYZ-12');
    expect(normalizeDeviceId('')).toBeNull();
    expect(normalizeDeviceId('AB')).toBeNull();
    expect(normalizeDeviceId('AUH/000001')).toBeNull();
    expect(normalizeDeviceId('A'.repeat(33))).toBeNull();
  });
});

describe('validateManualClaim', () => {
  it('hợp lệ', () => {
    expect(validateManualClaim('auh 000001', 'abcde fghjk')).toEqual({ ok: true, deviceId: 'AUH-000001', code: CODE });
  });
  it('báo lỗi đúng từng ô', () => {
    const r = validateManualClaim('###', 'ABCDEFGHJK');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.idError).toBeTruthy();
      expect(r.codeError).toBeUndefined();
    }
    const r2 = validateManualClaim('AUH-000001', 'xx');
    if (!r2.ok) {
      expect(r2.idError).toBeUndefined();
      expect(r2.codeError).toBeTruthy();
    }
  });
});
