import { describe, expect, it } from 'vitest';
import { AppError } from './errors.ts';
import { MAX_POINTS, parseDiag, parseSetup, parseOkUntil, parseRecipientsResponse, parseTelegramLink, parseDevice, parseDeviceList, parseOk, parseReadings, parseRecipient, parseRecipientList, parseServerTime } from './schemas.ts';

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
  it('loại tủ lạ (server thêm loại mới) => "other", không làm hỏng thiết bị', () => {
    expect(parseDevice({ ...device, kind: 'oven' }).kind).toBe('other');
    expect(parseDevice({ ...device, kind: 5 }).kind).toBe('other');
  });
  it('sai dạng => bad_response', () => {
    bad(() => parseDevice(null));
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

describe('hợp đồng server mới: armed / recipient_count / notify_failures_24h / server_time', () => {
  it('đọc đủ các trường mới', () => {
    const d = parseDevice({ ...device, armed: false, recipient_count: 0, notify_failures_24h: 3 });
    expect(d).toMatchObject({ armed: false, recipient_count: 0, notify_failures_24h: 3 });
  });
  it('server cũ không có các trường này: vắng mặt (KHÔNG mặc định thành số 0/true để khỏi báo sai)', () => {
    const d = parseDevice(device);
    expect('armed' in d).toBe(false);
    expect('recipient_count' in d).toBe(false);
    expect('notify_failures_24h' in d).toBe(false);
  });
  it('trường mới sai kiểu bị bỏ qua chứ không làm hỏng cả thiết bị', () => {
    const d = parseDevice({ ...device, armed: 'yes', recipient_count: -1, notify_failures_24h: 1.5 });
    expect(d.id).toBe('AUH-000001');
    expect('armed' in d).toBe(false);
    expect('recipient_count' in d).toBe(false);
    expect('notify_failures_24h' in d).toBe(false);
  });
  it('trường thừa không lường trước bị bỏ qua', () => {
    const d = parseDevice({ ...device, future_field: { a: 1 }, extra: [1, 2] });
    expect(d).toEqual(device);
  });
  it('parseServerTime chỉ nhận Unix giây hợp lý', () => {
    expect(parseServerTime({ server_time: 1_800_000_000 })).toBe(1_800_000_000);
    for (const v of [{ server_time: 0 }, { server_time: 1_800_000_000_000 }, { server_time: '1800000000' }, { server_time: NaN }, {}, null, 5]) {
      expect(parseServerTime(v)).toBeUndefined();
    }
  });
});

describe('chịu lỗi từng dòng, danh sách lớn', () => {
  it('một thiết bị hỏng không làm trắng cả danh sách', () => {
    const list = parseDeviceList({ devices: [device, { id: 5 }, { ...device, id: 'AUH-000002' }] });
    expect(list.map((d) => d.id)).toEqual(['AUH-000001', 'AUH-000002']);
  });
  it('nhưng nếu TẤT CẢ dòng đều hỏng thì là phản hồi sai dạng', () => {
    bad(() => parseDeviceList({ devices: [{ id: 5 }, null] }));
  });
  it('điểm đo hỏng / nhiệt độ vô lý bị loại, điểm tốt vẫn giữ', () => {
    const r = parseReadings({
      min_c: 2,
      max_c: 8,
      points: [
        { t: 1, avg: 4, min: 3, max: 5 },
        { t: 2, avg: 9999, min: 3, max: 5 }, // vô lý
        { t: 3, avg: null, min: 3, max: 5 },
        { t: 4, avg: 5, min: 4, max: 6 },
      ],
    });
    expect(r.points.map((p) => p.t)).toEqual([1, 4]);
  });
  it('danh sách khổng lồ được cắt (giữ phần MỚI nhất)', () => {
    const points = Array.from({ length: MAX_POINTS + 500 }, (_, i) => ({ t: i, avg: -20, min: -21, max: -19 }));
    const r = parseReadings({ min_c: -40, max_c: -18, points });
    expect(r.points).toHaveLength(MAX_POINTS);
    expect(r.points[r.points.length - 1]!.t).toBe(MAX_POINTS + 499);
    const many = Array.from({ length: 2000 }, (_, i) => ({ ...device, id: `AUH-${i}` }));
    expect(parseDeviceList({ devices: many }).length).toBeLessThanOrEqual(500);
  });
  it('tên thiết bị rất dài / có ký tự lạ vẫn là chuỗi thường (chỉ hiển thị dạng văn bản)', () => {
    const d = parseDevice({ ...device, name: '<img src=x onerror=alert(1)>'.repeat(50) });
    expect(typeof d.name).toBe('string');
  });
});

describe('trường mới: paused_until / acked_until / claimed_at', () => {
  it('đọc số và null', () => {
    const d = parseDevice({ ...device, paused_until: 1_800_100_000, acked_until: null, claimed_at: 1_799_000_000 });
    expect(d).toMatchObject({ paused_until: 1_800_100_000, acked_until: null, claimed_at: 1_799_000_000 });
  });
  it('server cũ: vắng mặt (KHÔNG mặc định thành null, để biết server có hỗ trợ hay không)', () => {
    const d = parseDevice(device);
    expect('paused_until' in d).toBe(false);
    expect('acked_until' in d).toBe(false);
    expect('claimed_at' in d).toBe(false);
  });
  it('sai kiểu (chuỗi, âm, NaN) bị bỏ qua, không làm hỏng thiết bị', () => {
    const d = parseDevice({ ...device, paused_until: '2027', acked_until: -5, claimed_at: NaN });
    expect(d.id).toBe('AUH-000001');
    expect('paused_until' in d).toBe(false);
    expect('acked_until' in d).toBe(false);
    expect('claimed_at' in d).toBe(false);
  });
  it('parseOkUntil: cần ok=true và mốc thời gian hợp lệ', () => {
    expect(parseOkUntil({ ok: true, acked_until: 1_800_000_000 }, 'acked_until')).toBe(1_800_000_000);
    expect(parseOkUntil({ ok: true, paused_until: 1_800_000_000 }, 'paused_until')).toBe(1_800_000_000);
    bad(() => parseOkUntil({ ok: true }, 'acked_until'));
    bad(() => parseOkUntil({ ok: true, acked_until: 'x' }, 'acked_until'));
    bad(() => parseOkUntil({ ok: false, acked_until: 1_800_000_000 }, 'acked_until'));
    bad(() => parseOkUntil({ ok: true, paused_until: 1_800_000_000 }, 'acked_until'));
    bad(() => parseOkUntil(null, 'acked_until'));
  });
});

describe('Telegram: người nhận và liên kết', () => {
  const rec = { id: 1, name: 'Vợ', phone: '84912345678' };
  it('đọc mode, telegram_linked, telegram_available', () => {
    const r = parseRecipientsResponse({
      telegram_available: true,
      recipients: [{ ...rec, mode: 'both', telegram_linked: true }, { id: 2, name: 'A', phone: '84987654321', mode: 'zns', telegram_linked: false }],
    });
    expect(r.telegram_available).toBe(true);
    expect(r.recipients[0]).toEqual({ ...rec, mode: 'both', telegram_linked: true });
    expect(r.recipients[1]).toMatchObject({ mode: 'zns', telegram_linked: false });
  });
  it('server cũ (vắng telegram_available và các trường): available = false, trường vắng mặt', () => {
    const r = parseRecipientsResponse({ recipients: [rec] });
    expect(r.telegram_available).toBe(false);
    expect('mode' in r.recipients[0]!).toBe(false);
    expect('telegram_linked' in r.recipients[0]!).toBe(false);
  });
  it('telegram_available chỉ true khi đúng boolean true ("true", 1 => false)', () => {
    for (const v of ['true', 1, null, 'yes']) expect(parseRecipientsResponse({ telegram_available: v, recipients: [] }).telegram_available).toBe(false);
  });
  it('mode lạ / telegram_linked sai kiểu bị bỏ qua, người nhận vẫn đọc được', () => {
    const r = parseRecipientsResponse({ recipients: [{ ...rec, mode: 'sms', telegram_linked: 'yes' }] }).recipients[0]!;
    expect(r).toEqual(rec);
  });
  it('parseTelegramLink: nhận đúng URL t.me, expires_at tùy chọn', () => {
    expect(parseTelegramLink({ url: 'https://t.me/AuhonoBot?start=abc_DEF-1', expires_at: 1_800_086_400 })).toEqual({
      url: 'https://t.me/AuhonoBot?start=abc_DEF-1',
      expires_at: 1_800_086_400,
    });
    expect(parseTelegramLink({ url: 'https://t.me/AuhonoBot?start=abc' }).expires_at).toBeUndefined();
  });
  it('parseTelegramLink: URL không phải t.me => bad_response (không bao giờ đưa URL lạ đi tiếp)', () => {
    for (const url of ['https://evil.example/x?start=abc', 'http://t.me/AuhonoBot?start=abc', 'javascript:alert(1)', 5, null, undefined]) {
      bad(() => parseTelegramLink({ url, expires_at: 1 }));
    }
    bad(() => parseTelegramLink(null));
  });
});

describe('lỗi cảm biến: last_reading_at / diag / alarm_since', () => {
  it('đọc đủ các trường mới', () => {
    const d = parseDevice({ ...device, phase: 'sensor_fault', last_reading_at: 1_799_990_000, diag_at: 1_800_000_000, alarm_since: null,
      diag: { sensor: 'fault', fault_s: 1200, rst: 'brownout', rssi: -71, heap: 84000, up: 86400 } });
    expect(d.phase).toBe('sensor_fault');
    expect(d).toMatchObject({ last_reading_at: 1_799_990_000, diag_at: 1_800_000_000, alarm_since: null });
    expect(d.diag).toEqual({ sensor: 'fault', fault_s: 1200, rst: 'brownout', rssi: -71, heap: 84000, up: 86400 });
  });
  it('server cũ: các trường vắng mặt', () => {
    const d = parseDevice(device);
    for (const k of ['last_reading_at', 'diag', 'diag_at', 'alarm_since']) expect(k in d).toBe(false);
  });
  it('phase lạ của server mới vẫn đọc được (giữ nguyên chuỗi)', () => {
    expect(parseDevice({ ...device, phase: 'quantum_flux' }).phase).toBe('quantum_flux');
  });
  it('parseDiag: bỏ trường sai kiểu/ngoài khoảng, rỗng => null, không phải object => undefined', () => {
    expect(parseDiag({ rssi: -60, up: 5, junk: 1 })).toEqual({ rssi: -60, up: 5 });
    expect(parseDiag({ rssi: 10, rst: 'a b', sensor: 'maybe', fault_s: -1, up: 1.5, heap: '1' })).toBeNull();
    expect(parseDiag({})).toBeNull();
    expect(parseDiag(null)).toBeNull();
    for (const v of ['x', 5, [], undefined]) expect(parseDiag(v)).toBeUndefined();
  });
  it('diag hỏng không làm hỏng thiết bị', () => {
    const d = parseDevice({ ...device, diag: 'garbage', last_reading_at: 'x' });
    expect(d.id).toBe('AUH-000001');
    expect('diag' in d).toBe(false);
    expect('last_reading_at' in d).toBe(false);
  });
});

describe('parseSetup (Wi-Fi cài đặt)', () => {
  it('đúng dạng', () => {
    expect(parseSetup({ ap_ssid: 'Auhono-0001', ap_password: 'XP1CZHP3Z0', wifi_qr: 'WIFI:T:WPA;S:Auhono-0001;P:XP1CZHP3Z0;H:false;;' })).toEqual({
      ap_ssid: 'Auhono-0001', ap_password: 'XP1CZHP3Z0', wifi_qr: 'WIFI:T:WPA;S:Auhono-0001;P:XP1CZHP3Z0;H:false;;',
    });
  });
  it('wifi_qr tùy chọn; giá trị lạ bị bỏ', () => {
    expect('wifi_qr' in parseSetup({ ap_ssid: 'Auhono-0001', ap_password: 'XP1CZHP3Z0' })).toBe(false);
    expect('wifi_qr' in parseSetup({ ap_ssid: 'Auhono-0001', ap_password: 'XP1CZHP3Z0', wifi_qr: 'http://evil' })).toBe(false);
  });
  it('sai dạng => bad_response', () => {
    bad(() => parseSetup(null));
    bad(() => parseSetup({ ap_ssid: 'A', ap_password: 'short' }));
    bad(() => parseSetup({ ap_ssid: '', ap_password: 'XP1CZHP3Z0' }));
    bad(() => parseSetup({ ap_ssid: 'x'.repeat(33), ap_password: 'XP1CZHP3Z0' }));
    bad(() => parseSetup({ ap_ssid: 'Auhono-0001', ap_password: 'has space 12' }));
    bad(() => parseSetup({ ap_ssid: 5, ap_password: 'XP1CZHP3Z0' }));
  });
});
