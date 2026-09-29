import { describe, expect, it } from 'vitest';
import { AppError } from './errors.ts';
import { parseDevice, parseDeviceList, parseOk, parseReadings, parseRecipient, parseRecipientList } from './schemas.ts';

const device = {
  id: 'AUH-000001',
  name: 'Tủ kem',
  kind: 'freezer',
  min_c: -40,
  max_c: -18,
  breach_minutes: 15,
  last_seen: 1_800_000_000,
  firmware: '1.0.0',
  phase: 'ok',
  latest: { ts: 1_800_000_000, temp_c: -20.5 },
};

const bad = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe('bad_response');
    return;
  }
  throw new Error('phải ném bad_response');
};

describe('parseDevice', () => {
  it('đúng dạng (khớp publicDevice của server)', () => {
    expect(parseDevice(device)).toEqual(device);
  });
  it('thiết bị mới kích hoạt: latest/last_seen/firmware là null', () => {
    const d = parseDevice({ ...device, latest: null, last_seen: null, firmware: null });
    expect(d.latest).toBeNull();
    expect(d.last_seen).toBeNull();
    expect(d.firmware).toBeNull();
  });
  it('sai dạng => bad_response', () => {
    bad(() => parseDevice(null));
    bad(() => parseDevice({ ...device, kind: 'oven' }));
    bad(() => parseDevice({ ...device, min_c: '−40' }));
    bad(() => parseDevice({ ...device, min_c: NaN }));
    bad(() => parseDevice({ ...device, latest: { ts: 1 } }));
    bad(() => parseDevice({ ...device, id: 5 }));
  });
});

describe('danh sách / số đo / người nhận', () => {
  it('parseDeviceList', () => {
    expect(parseDeviceList({ devices: [device] })).toHaveLength(1);
    expect(parseDeviceList({ devices: [] })).toEqual([]);
    bad(() => parseDeviceList({}));
    bad(() => parseDeviceList([]));
  });
  it('parseReadings', () => {
    const r = parseReadings({ min_c: 2, max_c: 8, points: [{ t: 1, avg: 4, min: 3, max: 5 }] });
    expect(r.points[0]).toEqual({ t: 1, avg: 4, min: 3, max: 5 });
    bad(() => parseReadings({ min_c: 2, max_c: 8, points: [{ t: 1, avg: null, min: 3, max: 5 }] }));
    bad(() => parseReadings({ min_c: 2, max_c: 8 }));
  });
  it('parseRecipient(List)', () => {
    expect(parseRecipient({ id: 1, name: 'Vợ', phone: '84912345678' })).toEqual({ id: 1, name: 'Vợ', phone: '84912345678' });
    expect(parseRecipientList({ recipients: [] })).toEqual([]);
    bad(() => parseRecipient({ id: '1', name: 'x', phone: 'y' }));
    bad(() => parseRecipientList({ recipients: 'x' }));
  });
  it('parseOk', () => {
    expect(() => parseOk({ ok: true })).not.toThrow();
    bad(() => parseOk({ ok: false }));
    bad(() => parseOk(null));
  });
});
