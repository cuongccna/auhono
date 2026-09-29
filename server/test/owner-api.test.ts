import { beforeEach, describe, expect, it } from 'vitest';
import { rollupOldReadings, RETENTION_SECONDS } from '../src/cron.ts';
import { activationCode, createActiveDevice, createDevice, harness, NOW, readingsBody, testEnv, type Harness } from './helpers.ts';

let h: Harness;
beforeEach(() => {
  h = harness();
});
const json = async (r: Response) => (await r.json()) as Record<string, any>;

describe('xác thực chủ quán', () => {
  it('thiếu / sai token => 401', async () => {
    expect((await h.request('/v1/devices')).status).toBe(401);
    expect((await h.owner('token-la', 'GET', '/v1/devices')).status).toBe(401);
    expect((await h.request('/v1/devices', { headers: { Authorization: 'Basic abc' } })).status).toBe(401);
  });
});

describe('kích hoạt (claim)', () => {
  it('đúng mã: gắn thiết bị, áp ngưỡng theo loại tủ', async () => {
    const id = await createDevice();
    const res = await h.owner('owner-a-token', 'POST', '/v1/devices/claim', {
      device_id: id,
      code: (await activationCode(id)).toLowerCase(), // không phân biệt hoa thường
      kind: 'chiller',
      name: 'Tủ mát thuốc',
    });
    expect(res.status).toBe(200);
    const list = await json(await h.owner('owner-a-token', 'GET', '/v1/devices'));
    expect(list.server_time).toBe(NOW);
    const d = list.devices.find((x: any) => x.id === id);
    expect(d).toMatchObject({ name: 'Tủ mát thuốc', kind: 'chiller', min_c: 2, max_c: 8, phase: 'ok', latest: null });
  });

  it('sai mã, thiết bị không tồn tại: cùng một phản hồi 404', async () => {
    const id = await createDevice();
    const wrong = await h.owner('owner-a-token', 'POST', '/v1/devices/claim', { device_id: id, code: 'AAAAAAAAAA' });
    const missing = await h.owner('owner-a-token', 'POST', '/v1/devices/claim', { device_id: 'AUH-424242', code: 'AAAAAAAAAA' });
    for (const r of [wrong, missing]) {
      expect(r.status).toBe(404);
      expect(await json(r)).toEqual({ error: 'invalid_code' });
    }
  });

  it('thiết bị đã có chủ: người khác không chiếm được dù có đúng mã; chủ cũ gọi lại vẫn ok', async () => {
    const id = await createDevice();
    const body = { device_id: id, code: await activationCode(id) };
    expect((await h.owner('owner-a-token', 'POST', '/v1/devices/claim', body)).status).toBe(200);
    expect((await h.owner('owner-b-token', 'POST', '/v1/devices/claim', body)).status).toBe(404);
    expect((await h.owner('owner-a-token', 'POST', '/v1/devices/claim', body)).status).toBe(200);
  });
});

describe('cách ly giữa các chủ quán', () => {
  it('chủ B không thấy, không sửa, không xóa, không xem số đo/người nhận của thiết bị chủ A', async () => {
    const id = await createActiveDevice(h);
    const b = (m: string, p: string, body?: unknown) => h.owner('owner-b-token', m, p, body);
    expect((await json(await b('GET', '/v1/devices'))).devices.find((x: any) => x.id === id)).toBeUndefined();
    expect((await b('PATCH', `/v1/devices/${id}`, { name: 'hack' })).status).toBe(404);
    expect((await b('DELETE', `/v1/devices/${id}`)).status).toBe(404);
    expect((await b('GET', `/v1/devices/${id}/readings`)).status).toBe(404);
    expect((await b('GET', `/v1/devices/${id}/recipients`)).status).toBe(404);
    expect((await b('POST', `/v1/devices/${id}/recipients`, { name: 'x', phone: '0912345678' })).status).toBe(404);
  });
});

describe('cấu hình thiết bị', () => {
  it('đổi loại tủ áp ngưỡng có sẵn; tự đặt ngưỡng; chặn khoảng sai', async () => {
    const id = await createActiveDevice(h);
    const patch = (body: unknown) => h.owner('owner-a-token', 'PATCH', `/v1/devices/${id}`, body);
    expect((await patch({ kind: 'chiller' })).status).toBe(200);
    expect((await patch({ min_c: 0, max_c: 5, breach_minutes: 10 })).status).toBe(200);
    const d = (await json(await h.owner('owner-a-token', 'GET', '/v1/devices'))).devices.find((x: any) => x.id === id);
    expect(d).toMatchObject({ kind: 'chiller', min_c: 0, max_c: 5, breach_minutes: 10 });

    expect((await patch({ min_c: 9, max_c: 3 })).status).toBe(400);
    expect((await patch({ breach_minutes: 1 })).status).toBe(400);
    expect((await patch({ name: '' })).status).toBe(400);
  });

  it('gỡ thiết bị: xóa người nhận, chủ khác kích hoạt lại được', async () => {
    const id = await createActiveDevice(h);
    expect((await h.owner('owner-a-token', 'DELETE', `/v1/devices/${id}`)).status).toBe(200);
    const r = await testEnv.DB.prepare('SELECT COUNT(*) n FROM recipients WHERE device_id = ?').bind(id).first<{ n: number }>();
    expect(r!.n).toBe(0);
    const claim = await h.owner('owner-b-token', 'POST', '/v1/devices/claim', { device_id: id, code: await activationCode(id) });
    expect(claim.status).toBe(200);
  });
});

describe('người nhận cảnh báo', () => {
  it('chuẩn hóa số VN về 84…, chặn số sai, chặn trùng, tối đa 5 người', async () => {
    const id = await createActiveDevice(h, '0900000001'); // người 1
    const add = (phone: string, name = 'X') => h.owner('owner-a-token', 'POST', `/v1/devices/${id}/recipients`, { name, phone });

    expect(await json(await add('+84 912 345 679'))).toMatchObject({ phone: '84912345679' });
    expect((await add('0912-345-679', 'Trùng')).status).toBe(201); // trùng số: cập nhật tên, không thêm
    expect((await add('123')).status).toBe(400);
    expect((await add('0212345678')).status).toBe(400); // đầu số không phải di động
    expect((await add('abc')).status).toBe(400);

    for (const p of ['0912345670', '0912345671', '0912345672']) expect((await add(p)).status).toBe(201);
    expect((await add('0912345673')).status).toBe(409); // đã đủ 5

    const list = await json(await h.owner('owner-a-token', 'GET', `/v1/devices/${id}/recipients`));
    expect(list.recipients).toHaveLength(5);
    const victim = list.recipients[0];
    expect((await h.owner('owner-a-token', 'DELETE', `/v1/devices/${id}/recipients/${victim.id}`)).status).toBe(200);
    expect((await json(await h.owner('owner-a-token', 'GET', `/v1/devices/${id}/recipients`))).recipients).toHaveLength(4);
  });
});

describe('biểu đồ', () => {
  it('gộp theo 5 phút, chỉ lấy trong khoảng giờ yêu cầu', async () => {
    const id = await createActiveDevice(h);
    // 10 số đo trong 10 phút gần nhất + 1 số đo cách đây 30 giờ.
    await h.signed(id, 'POST', '/v1/readings', 1, readingsBody(NOW, Array(10).fill(-20)));
    await testEnv.DB.prepare('INSERT INTO readings (device_id, ts, temp_c) VALUES (?, ?, ?)').bind(id, NOW - 30 * 3600, -5).run();

    const day = await json(await h.owner('owner-a-token', 'GET', `/v1/devices/${id}/readings?hours=24`));
    expect(day).toMatchObject({ server_time: NOW, min_c: -40, max_c: -18 });
    expect(day.points.length).toBeGreaterThanOrEqual(2);
    expect(day.points.length).toBeLessThanOrEqual(3);
    expect(day.points.every((p: any) => p.avg === -20)).toBe(true);

    const week = await json(await h.owner('owner-a-token', 'GET', `/v1/devices/${id}/readings?hours=48`));
    expect(week.points.some((p: any) => p.avg === -5)).toBe(true);
  });
});

describe('gộp dữ liệu sau 7 ngày', () => {
  it('số đo cũ thành trung bình theo giờ và bị xóa; số đo mới giữ nguyên; chạy lại không đổi kết quả', async () => {
    const id = await createDevice();
    const hourStart = Math.floor((NOW - RETENTION_SECONDS) / 3600) * 3600 - 3600 * 5; // 5 giờ trước mốc cắt
    const ins = testEnv.DB.prepare('INSERT INTO readings (device_id, ts, temp_c) VALUES (?, ?, ?)');
    await testEnv.DB.batch([
      ins.bind(id, hourStart + 10, -20),
      ins.bind(id, hourStart + 700, -18),
      ins.bind(id, hourStart + 3600 + 5, -10), // giờ kế tiếp
      ins.bind(id, NOW - 3600, -19), // mới: giữ nguyên
    ]);
    await rollupOldReadings(testEnv.DB, NOW);
    await rollupOldReadings(testEnv.DB, NOW);

    const hourly = (await testEnv.DB.prepare('SELECT hour_ts, avg_c, min_c, max_c, n FROM readings_hourly WHERE device_id = ? ORDER BY hour_ts').bind(id).all()).results;
    expect(hourly).toEqual([
      { hour_ts: hourStart, avg_c: -19, min_c: -20, max_c: -18, n: 2 },
      { hour_ts: hourStart + 3600, avg_c: -10, min_c: -10, max_c: -10, n: 1 },
    ]);
    const raw = await testEnv.DB.prepare('SELECT COUNT(*) n FROM readings WHERE device_id = ?').bind(id).first<{ n: number }>();
    expect(raw!.n).toBe(1);
  });
});

describe('CORS', () => {
  it('chỉ cho origin của Zalo Mini App', async () => {
    const ok = await h.request('/v1/devices', { method: 'OPTIONS', headers: { Origin: 'https://h5.zdn.vn', 'Access-Control-Request-Method': 'GET' } });
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://h5.zdn.vn');
    const bad = await h.request('/v1/devices', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
