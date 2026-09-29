// Nhịp tim (readings rỗng + diag), lỗi cảm biến và Wi-Fi cấu hình của thiết bị.
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULTS, initialState, step, tick, type AlertConfig, type AlertState } from '../src/alerts.ts';
import { checkDevices } from '../src/cron.ts';
import { getState } from '../src/db.ts';
import { dispatchPending } from '../src/notify.ts';
import { activationCode, createActiveDevice, createDevice, harness, NOW, readingsBody, testEnv, type Harness } from './helpers.ts';

const cfg: AlertConfig = { minC: -40, maxC: -18, breachSeconds: 15 * 60, ...DEFAULTS };
const min = (n: number) => n * 60;
const kinds = (e: { kind: string }[]) => e.map((x) => x.kind);
const armed = (): AlertState => ({ ...initialState(), armed: true });

describe('máy trạng thái: lỗi cảm biến', () => {
  const T0 = 1_000_000;
  it('còn liên lạc (nhịp tim) nhưng không có số đo > 15 phút => sensor_fault một lần', () => {
    expect(tick(armed(), T0 + min(14), T0 + min(14), cfg, T0 - 999, T0).events).toEqual([]);
    const r = tick(armed(), T0 + min(15), T0 + min(15), cfg, T0 - 999, T0);
    expect(kinds(r.events)).toEqual(['sensor_fault']);
    expect(r.state.phase).toBe('sensor_fault');
    expect(tick(r.state, T0 + min(20), T0 + min(20), cfg, T0 - 999, T0).events).toEqual([]);
  });

  it('thiết bị cũ không gửi nhịp tim (im lặng hẳn) vẫn báo "offline", không phải lỗi cảm biến', () => {
    const r = tick(armed(), T0 + min(15), T0, cfg, T0 - 999, T0); // last_seen = last_reading_at = T0
    expect(kinds(r.events)).toEqual(['offline']);
  });

  it('mất liên lạc ưu tiên hơn lỗi cảm biến: đang sensor_fault rồi im hẳn => offline', () => {
    const fault = tick(armed(), T0 + min(15), T0 + min(15), cfg, null, T0).state;
    const r = tick(fault, T0 + min(15) + min(20), T0 + min(15), cfg, null, T0);
    expect(kinds(r.events)).toEqual(['offline']);
  });

  it('đang offline mà nhịp tim trở lại (chưa có số đo) => chuyển sang sensor_fault', () => {
    const off = tick(armed(), T0 + min(15), T0, cfg, null, T0).state;
    expect(off.phase).toBe('offline');
    const r = tick(off, T0 + min(40), T0 + min(39), cfg, null, T0);
    expect(kinds(r.events)).toEqual(['sensor_fault']);
  });

  it('nhắc lại thưa như mất kết nối (+2 giờ, +6 giờ, +12 giờ) rồi dừng', () => {
    let s = tick(armed(), T0 + min(15), T0 + min(15), cfg, null, T0).state;
    const at = T0 + min(15);
    const times: number[] = [];
    for (let now = at; now < at + 48 * 3600; now += min(5)) {
      const r = tick(s, now, now, cfg, null, T0); // nhịp tim đều đặn, đầu dò vẫn hỏng
      s = r.state;
      if (r.events.length) times.push(now - at);
    }
    expect(times).toEqual([7200, 7200 + 21600, 7200 + 21600 + 43200]);
  });

  it('có số đo hợp lệ trở lại => sensor_recovered (không phải reconnected); armed', () => {
    const fault = tick(armed(), T0 + min(15), T0 + min(15), cfg, null, T0).state;
    const r = step(fault, { ts: T0 + min(30), c: -20 }, cfg);
    expect(kinds(r.events)).toEqual(['sensor_recovered']);
    expect(r.state).toMatchObject({ phase: 'ok', armed: true });
  });

  it('số đo trở lại nhưng đang nóng: không báo ổn, bắt đầu đếm vượt ngưỡng', () => {
    const fault = tick(armed(), T0 + min(15), T0 + min(15), cfg, null, T0).state;
    const r = step(fault, { ts: T0 + min(30), c: -5 }, cfg);
    expect(r.events).toEqual([]);
    expect(r.state.breachSince).toBe(T0 + min(30));
  });

  it('đang báo động nhiệt độ mà đầu dò hỏng: chuyển sang lỗi cảm biến, hủy "đã biết"', () => {
    const alarm: AlertState = { ...armed(), phase: 'temp_alarm', lastNotifiedAt: T0, ackedUntil: T0 + 99999, breachSince: T0 - 900, breachKind: 'high' };
    const r = tick(alarm, T0 + min(20), T0 + min(20), cfg, null, T0);
    expect(kinds(r.events)).toEqual(['sensor_fault']);
    expect(r.state).toMatchObject({ phase: 'sensor_fault', ackedUntil: null, breachSince: null });
  });

  it('chưa từng có số đo nào từ lúc gắn chủ: dùng mốc claimedAt', () => {
    const claimed = T0;
    expect(kinds(tick(initialState(), claimed + min(15), claimed + min(14), cfg, claimed, null).events)).toEqual(['sensor_fault']);
  });
});

describe('nhịp tim qua API', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  const json = async (r: Response) => (await r.json()) as Record<string, any>;
  const one = async <T = Record<string, any>>(sql: string, ...b: unknown[]) => testEnv.DB.prepare(sql).bind(...b).first<T>();
  const count = async (sql: string, ...b: unknown[]) => (await one<{ n: number }>(sql, ...b))!.n;
  const heartbeat = (id: string, seq: number, diag?: unknown) =>
    h.signed(id, 'POST', '/v1/readings', seq, { fw: '1.0.0', readings: [], ...(diag === undefined ? {} : { diag }) });

  it('gói nhịp tim: 200, accepted 0, cập nhật last_seen nhưng KHÔNG cập nhật last_reading_at; lưu diag', async () => {
    const id = await createActiveDevice(h);
    await h.signed(id, 'POST', '/v1/readings', 1, readingsBody(NOW, [-20]));
    h.clock.now = NOW + 300;
    const res = await heartbeat(id, 2, { sensor: 'fault', fault_s: 300, rst: 'brownout', rssi: -71, heap: 84000, up: 3600 });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, accepted: 0, server_time: NOW + 300 });
    const d = await one('SELECT last_seen, last_reading_at, diag_json, diag_at FROM devices WHERE id = ?', id);
    expect(d).toMatchObject({ last_seen: NOW + 300, last_reading_at: NOW, diag_at: NOW + 300 });
    expect(JSON.parse(d!.diag_json)).toEqual({ sensor: 'fault', fault_s: 300, rst: 'brownout', rssi: -71, heap: 84000, up: 3600 });
    const api = (await json(await h.owner('owner-a-token', 'GET', `/v1/devices/${id}`))).device;
    expect(api).toMatchObject({ last_reading_at: NOW, diag: { rst: 'brownout', rssi: -71 } });
  });

  it('diag sai định dạng KHÔNG làm mất số đo và không bị lưu; trường lạ bị bỏ', async () => {
    const id = await createActiveDevice(h);
    const bad = await h.signed(id, 'POST', '/v1/readings', 1, { readings: [{ t: NOW, c: -20 }], diag: { rssi: 999, rst: 'x y', heap: 'nhiều' } });
    expect(bad.status).toBe(200);
    expect((await json(bad)).accepted).toBe(1);
    expect((await one('SELECT diag_json FROM devices WHERE id = ?', id))!.diag_json).toBeNull();
    const weird = await h.signed(id, 'POST', '/v1/readings', 2, { readings: [{ t: NOW, c: -20 }], diag: 'chuỗi lạ' });
    expect(weird.status).toBe(200);
    await h.signed(id, 'POST', '/v1/readings', 3, { readings: [], diag: { rssi: -60, evil: '<script>' } });
    expect(JSON.parse((await one('SELECT diag_json FROM devices WHERE id = ?', id))!.diag_json)).toEqual({ rssi: -60 });
  });

  it('đầu dò đứt: nhịp tim đều nhưng không số đo => sensor_fault (không phải offline), rồi sensor_recovered', async () => {
    const id = await createActiveDevice(h);
    await h.signed(id, 'POST', '/v1/readings', 1, readingsBody(NOW, [-20, -20]));
    let seq = 2;
    for (let m = 5; m <= 20; m += 5) {
      h.clock.now = NOW + m * 60;
      await heartbeat(id, seq++, { sensor: 'fault', fault_s: m * 60 });
      await checkDevices(testEnv.DB, h.clock.now);
    }
    await h.settle();
    expect(await count("SELECT COUNT(*) n FROM alert_events WHERE device_id = ? AND kind = 'sensor_fault'", id)).toBe(1);
    expect(await count("SELECT COUNT(*) n FROM alert_events WHERE device_id = ? AND kind = 'offline'", id)).toBe(0);
    expect((await getState(testEnv.DB, id)).state.phase).toBe('sensor_fault');
    expect((await json(await h.owner('owner-a-token', 'GET', `/v1/devices/${id}`))).device.phase).toBe('sensor_fault');
    // Tin gửi tới người nhận (dùng mẫu OFFLINE) qua hàng đợi.
    await dispatchPending(testEnv.DB, h.notifier, h.clock.now); // cron thật gọi bước này sau checkDevices
    expect(await count("SELECT COUNT(*) n FROM notifications n JOIN alert_events e ON e.id = n.event_id WHERE e.device_id = ? AND e.kind = 'sensor_fault' AND n.status = 'sent'", id)).toBe(1);

    h.clock.now = NOW + 25 * 60;
    await h.signed(id, 'POST', '/v1/readings', seq, readingsBody(h.clock.now, [-20]));
    await h.settle();
    expect(await count("SELECT COUNT(*) n FROM alert_events WHERE device_id = ? AND kind = 'sensor_recovered'", id)).toBe(1);
    expect((await getState(testEnv.DB, id)).state.phase).toBe('ok');
  });

  it('thiết bị cũ (không có nhịp tim) đứt dây: vẫn báo "mất kết nối" như trước', async () => {
    const id = await createActiveDevice(h);
    await h.signed(id, 'POST', '/v1/readings', 1, readingsBody(NOW, [-20]));
    await checkDevices(testEnv.DB, NOW + 16 * 60);
    expect(await count("SELECT COUNT(*) n FROM alert_events WHERE device_id = ? AND kind = 'offline'", id)).toBe(1);
    expect(await count("SELECT COUNT(*) n FROM alert_events WHERE device_id = ? AND kind = 'sensor_fault'", id)).toBe(0);
  });

  it('nhịp tim không có chữ ký / sai chữ ký bị từ chối như mọi gói khác', async () => {
    const id = await createActiveDevice(h);
    const res = await h.request('/v1/readings', {
      method: 'POST',
      body: JSON.stringify({ readings: [] }),
      headers: { 'X-Device-Id': id, 'X-Timestamp': String(NOW), 'X-Seq': '1', 'X-Signature': 'ab'.repeat(32) },
    });
    expect(res.status).toBe(401);
  });

  it('số đo cũ hơn 24 giờ bị bỏ hết => vẫn tính là nhịp tim, không cập nhật last_reading_at', async () => {
    const id = await createActiveDevice(h);
    const res = await h.signed(id, 'POST', '/v1/readings', 1, { readings: [{ t: NOW - 30 * 3600, c: -20 }] });
    expect(await json(res)).toMatchObject({ accepted: 0 });
    expect((await one('SELECT last_seen, last_reading_at FROM devices WHERE id = ?', id))).toEqual({ last_seen: NOW, last_reading_at: null });
  });
});

describe('Wi-Fi cấu hình của thiết bị (AP WPA2)', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  const json = async (r: Response) => (await r.json()) as Record<string, any>;

  it('chủ thiết bị xem được SSID/mật khẩu/mã QR Wi-Fi (khi mất tem); không đổi giữa các lần gọi', async () => {
    const id = await createActiveDevice(h);
    const a = await json(await h.owner('owner-a-token', 'GET', `/v1/devices/${id}/setup`));
    const b = await json(await h.owner('owner-a-token', 'GET', `/v1/devices/${id}/setup`));
    expect(a).toEqual(b);
    expect(a.ap_ssid).toBe(`Auhono-${id.slice(-4)}`);
    expect(a.ap_password).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(a.wifi_qr).toBe(`WIFI:T:WPA;S:${a.ap_ssid};P:${a.ap_password};H:false;;`);
  });

  it('người khác / chưa đăng nhập / thiết bị không tồn tại: không lấy được', async () => {
    const id = await createActiveDevice(h);
    expect((await h.owner('owner-b-token', 'GET', `/v1/devices/${id}/setup`)).status).toBe(404);
    expect((await h.request(`/v1/devices/${id}/setup`)).status).toBe(401);
    expect((await h.owner('owner-a-token', 'GET', '/v1/devices/AUH-424242/setup')).status).toBe(404);
  });

  it('thiết bị chưa có chủ: không lộ mật khẩu qua API (chỉ có trên tem lúc ráp)', async () => {
    const id = await createDevice();
    expect((await h.owner('owner-a-token', 'GET', `/v1/devices/${id}/setup`)).status).toBe(404);
    await h.owner('owner-a-token', 'POST', '/v1/devices/claim', { device_id: id, code: await activationCode(id) });
    expect((await h.owner('owner-a-token', 'GET', `/v1/devices/${id}/setup`)).status).toBe(200);
    // Gỡ chủ thì không còn xem được nữa.
    await h.owner('owner-a-token', 'DELETE', `/v1/devices/${id}`);
    expect((await h.owner('owner-a-token', 'GET', `/v1/devices/${id}/setup`)).status).toBe(404);
  });
});
