import { describe, expect, it } from 'vitest';
import {
  canonicalString,
  deriveActivationCode,
  deriveDeviceKey,
  signCanonical,
  timingSafeEqualStr,
  toHex,
  verifyCanonical,
} from '../src/crypto.ts';

const enc = new TextEncoder();
const base = { method: 'POST', path: '/v1/readings', deviceId: 'AUH-000001', timestamp: 1_700_000_000, seq: 5, body: enc.encode('{"a":1}') };

describe('khóa thiết bị', () => {
  it('ổn định theo (master, id) và khác nhau giữa các thiết bị/master', async () => {
    const a = toHex(await deriveDeviceKey('m', 'AUH-000001'));
    expect(a).toBe(toHex(await deriveDeviceKey('m', 'AUH-000001')));
    expect(a).not.toBe(toHex(await deriveDeviceKey('m', 'AUH-000002')));
    expect(a).not.toBe(toHex(await deriveDeviceKey('m2', 'AUH-000001')));
    expect(a).toHaveLength(64);
  });

  it('mã kích hoạt 10 ký tự Crockford base32', async () => {
    const c = await deriveActivationCode('m', 'AUH-000001');
    expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
  });
});

describe('chữ ký', () => {
  it('chữ ký đúng thì qua', async () => {
    const key = await deriveDeviceKey('m', base.deviceId);
    const canon = await canonicalString(base);
    expect(await verifyCanonical(key, canon, await signCanonical(key, canon))).toBe(true);
  });

  it.each([
    ['đổi body', { body: enc.encode('{"a":2}') }],
    ['đổi seq', { seq: 6 }],
    ['đổi timestamp', { timestamp: base.timestamp + 1 }],
    ['đổi path (dùng lại ở endpoint khác)', { path: '/v1/ota/check' }],
    ['đổi method', { method: 'GET' }],
    ['đổi device id', { deviceId: 'AUH-000002' }],
  ])('%s thì sai chữ ký', async (_n, patch) => {
    const key = await deriveDeviceKey('m', base.deviceId);
    const sig = await signCanonical(key, await canonicalString(base));
    expect(await verifyCanonical(key, await canonicalString({ ...base, ...patch }), sig)).toBe(false);
  });

  it('khóa khác thì sai; chữ ký rác/độ dài sai bị từ chối, không ném lỗi', async () => {
    const canon = await canonicalString(base);
    const sig = await signCanonical(await deriveDeviceKey('m', base.deviceId), canon);
    const other = await deriveDeviceKey('other', base.deviceId);
    expect(await verifyCanonical(other, canon, sig)).toBe(false);
    for (const bad of ['', 'zz', 'abcd', sig.slice(2), sig + '00']) {
      expect(await verifyCanonical(other, canon, bad)).toBe(false);
    }
  });
});

it('timingSafeEqualStr', async () => {
  expect(await timingSafeEqualStr('ABC', 'ABC')).toBe(true);
  expect(await timingSafeEqualStr('ABC', 'ABD')).toBe(false);
  expect(await timingSafeEqualStr('ABC', 'ABCD')).toBe(false);
});
