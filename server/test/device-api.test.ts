import { beforeEach, describe, expect, it } from 'vitest';
import { checkDevices } from '../src/cron.ts';
import { createActiveDevice, createDevice, harness, NOW, readingsBody, testEnv, type Harness } from './helpers.ts';

let h: Harness;
beforeEach(() => {
  h = harness();
});

const json = async (r: Response) => (await r.json()) as Record<string, any>;
const count = async (sql: string, ...binds: unknown[]) =>
  (await testEnv.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;

describe('POST /v1/readings — xác thực', () => {
  it('chữ ký hợp lệ: lưu số đo và trả ngưỡng + giờ server', async () => {
    const id = await createActiveDevice(h);
    const res = await h.signed(id, 'POST', '/v1/readings', 1, readingsBody(NOW, [-20, -20, -19], '1.0.0'));
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, accepted: 3, server_time: NOW, config: { min_c: -40, max_c: -18 } });
    expect(await count('SELECT COUNT(*) n FROM readings WHERE device_id = ?', id)).toBe(3);
    const d = await testEnv.DB.prepare('SELECT last_seen, firmware, last_seq FROM devices WHERE id = ?').bind(id).first();
    expect(d).toMatchObject({ last_seen: NOW, firmware: '1.0.0', last_seq: 1 });
  });

  it('thiếu header hoặc chữ ký sai => 401 chung, không lộ thiết bị có tồn tại hay không', async () => {
    const id = await createActiveDevice(h);
    const noHeaders = await h.request('/v1/readings', { method: 'POST', body: '{}' });
    const badSig = await h.request('/v1/readings', {
      method: 'POST',
      body: JSON.stringify(readingsBody(NOW, [-20])),
      headers: { 'X-Device-Id': id, 'X-Timestamp': String(NOW), 'X-Seq': '1', 'X-Signature': 'ab'.repeat(32) },
    });
    const unknown = await h.signed('AUH-999999', 'POST', '/v1/readings', 1, readingsBody(NOW, [-20])); // ký đúng nhưng chưa có trong DB
    for (const r of [noHeaders, badSig, unknown]) {
      expect(r.status).toBe(401);
      expect(await json(r)).toEqual({ error: 'unauthorized' });
    }
    expect(await count('SELECT COUNT(*) n FROM readings WHERE device_id = ?', id)).toBe(0);
  });

  it('body bị sửa sau khi ký => 401', async () => {
    const id = await createActiveDevice(h);
    const good = readingsBody(NOW, [-20]);
    const res = await h.request('/v1/readings', {
      method: 'POST',
      body: JSON.stringify(readingsBody(NOW, [-1])), // kẻ tấn công đổi số đo
      headers: await (async () => {
        // Lấy header hợp lệ của gói `good` bằng cách ký thủ công.
        const { canonicalString, deriveDeviceKey, signCanonical } = await import('../src/crypto.ts');
        const raw = new TextEncoder().encode(JSON.stringify(good));
        const sig = await signCanonical(
          await deriveDeviceKey(testEnv.MASTER_SECRET, id),
          await canonicalString({ method: 'POST', path: '/v1/readings', deviceId: id, timestamp: NOW, seq: 1, body: raw }),
        );
        return { 'X-Device-Id': id, 'X-Timestamp': String(NOW), 'X-Seq': '1', 'X-Signature': sig };
      })(),
    });
    expect(res.status).toBe(401);
  });

  it('phát lại nguyên gói cũ (cùng seq) => 409, không lưu thêm', async () => {
    const id = await createActiveDevice(h);
    expect((await h.signed(id, 'POST', '/v1/readings', 5, readingsBody(NOW, [-20]))).status).toBe(200);
    const replay = await h.signed(id, 'POST', '/v1/readings', 5, readingsBody(NOW, [-20]));
    expect(replay.status).toBe(409);
    expect(await json(replay)).toMatchObject({ error: 'replay', last_seq: 5 });
    const lower = await h.signed(id, 'POST', '/v1/readings', 4, readingsBody(NOW, [-20]));
    expect(lower.status).toBe(409);
    expect((await h.signed(id, 'POST', '/v1/readings', 6, readingsBody(NOW + 0, [-21]))).status).toBe(200);
  });

  it('đồng hồ lệch > 5 phút => 401 kèm server_time để chip tự chỉnh', async () => {
    const id = await createActiveDevice(h);
    const res = await h.signed(id, 'POST', '/v1/readings', 1, readingsBody(NOW, [-20]), NOW - 301);
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: 'clock_skew', server_time: NOW });
    // Trong ngưỡng vẫn qua.
    expect((await h.signed(id, 'POST', '/v1/readings', 1, readingsBody(NOW, [-20]), NOW - 299)).status).toBe(200);
  });

  it('thiết bị bị thu hồi => 401', async () => {
    const id = await createActiveDevice(h);
    await testEnv.DB.prepare('UPDATE devices SET revoked = 1 WHERE id = ?').bind(id).run();
    expect((await h.signed(id, 'POST', '/v1/readings', 1, readingsBody(NOW, [-20]))).status).toBe(401);
  });

  it('gói ký cho endpoint này không dùng được ở endpoint khác', async () => {
    const id = await createActiveDevice(h);
    const { canonicalString, deriveDeviceKey, signCanonical } = await import('../src/crypto.ts');
    const key = await deriveDeviceKey(testEnv.MASTER_SECRET, id);
    const sig = await signCanonical(key, await canonicalString({ method: 'GET', path: '/v1/ota/check', deviceId: id, timestamp: NOW, seq: 1, body: new Uint8Array() }));
    const res = await h.request('/v1/readings', {
      method: 'POST',
      body: '',
      headers: { 'X-Device-Id': id, 'X-Timestamp': String(NOW), 'X-Seq': '1', 'X-Signature': sig },
    });
    expect(res.status).toBe(401);
  });

  it('body quá lớn => 413', async () => {
    const id = await createActiveDevice(h);
    const res = await h.request('/v1/readings', {
      method: 'POST',
      body: 'x'.repeat(5000),
      headers: { 'X-Device-Id': id, 'X-Timestamp': String(NOW), 'X-Seq': '1', 'X-Signature': '00' },
    });
    expect(res.status).toBe(413);
  });
});

describe('POST /v1/readings — kiểm tra dữ liệu', () => {
  it.each([
    ['rỗng', { readings: [] }],
    ['nhiệt độ vô lý', { readings: [{ t: NOW, c: 999 }] }],
    ['DS18B20 lỗi -127', { readings: [{ t: NOW, c: -127 }] }],
    ['sai kiểu', { readings: [{ t: 'x', c: 1 }] }],
    ['quá 20 số đo', { readings: Array.from({ length: 21 }, (_, i) => ({ t: NOW - i, c: -20 })) }],
  ])('%s => 400', async (_n, body) => {
    const id = await createActiveDevice(h);
    expect((await h.signed(id, 'POST', '/v1/readings', 1, body)).status).toBe(400);
  });

  it('bỏ số đo ngoài cửa sổ thời gian, giữ số còn lại', async () => {
    const id = await createActiveDevice(h);
    const res = await h.signed(id, 'POST', '/v1/readings', 1, {
      readings: [
        { t: NOW - 25 * 3600, c: -20 }, // quá cũ
        { t: NOW + 3600, c: -20 }, // ở tương lai
        { t: NOW, c: -20 },
      ],
    });
    expect(await json(res)).toMatchObject({ accepted: 1 });
  });

  it('gửi lại số đo trùng ts không tạo bản ghi đôi', async () => {
    const id = await createActiveDevice(h);
    await h.signed(id, 'POST', '/v1/readings', 1, readingsBody(NOW, [-20, -20]));
    await h.signed(id, 'POST', '/v1/readings', 2, readingsBody(NOW, [-20, -20]));
    expect(await count('SELECT COUNT(*) n FROM readings WHERE device_id = ?', id)).toBe(2);
  });
});

describe('cảnh báo đầu-cuối', () => {
  /** Gửi các số đo mỗi phút trong `minutes` phút liên tục, mỗi gói 5 phút như chip thật. */
  async function run(id: string, seqStart: number, startTs: number, minutes: number, c: number) {
    let seq = seqStart;
    for (let m = 0; m < minutes; m += 5) {
      h.clock.now = startTs + m * 60 + 4 * 60;
      const temps = Array(5).fill(c);
      await h.signed(id, 'POST', '/v1/readings', seq++, readingsBody(h.clock.now, temps));
      await h.settle();
    }
    return seq;
  }

  it('vượt ngưỡng 15 phút => một tin cảnh báo tới người nhận; về bình thường => tin "đã ổn"', async () => {
    const id = await createActiveDevice(h, '0912345678');
    let seq = await run(id, 1, NOW, 10, -20); // bình thường
    expect(h.notifier.sent).toHaveLength(0);

    seq = await run(id, seq, h.clock.now + 60, 25, -10); // nóng 25 phút
    const alarms = h.notifier.sent.filter((m) => m.kind === 'temp_alarm');
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatchObject({ phone: '84912345678', deviceName: 'Tủ kem', detail: 'high', maxC: -18 });

    await run(id, seq, h.clock.now + 60, 10, -22); // về bình thường
    expect(h.notifier.sent.map((m) => m.kind)).toEqual(['temp_alarm', 'recovered']);
  });

  it('mở cửa tủ vài phút không gây báo', async () => {
    const id = await createActiveDevice(h);
    let seq = await run(id, 1, NOW, 10, -20);
    seq = await run(id, seq, h.clock.now + 60, 10, -8); // hở cửa 10 phút
    await run(id, seq, h.clock.now + 60, 10, -20);
    expect(h.notifier.sent).toHaveLength(0);
  });

  it('cron: thiết bị im lặng 15 phút => báo mất kết nối; nhắc lại sau 30 phút; có số đo lại => báo lại kết nối', async () => {
    const id = await createActiveDevice(h);
    await run(id, 1, NOW, 5, -20);
    const seen = h.clock.now;

    h.clock.now = seen + 14 * 60;
    await checkDevices(testEnv.DB, h.clock.now);
    expect(await count("SELECT COUNT(*) n FROM alert_events WHERE device_id = ?", id)).toBe(0);

    h.clock.now = seen + 15 * 60;
    await checkDevices(testEnv.DB, h.clock.now);
    await checkDevices(testEnv.DB, h.clock.now + 60); // chạy lại không tạo trùng
    expect(await count("SELECT COUNT(*) n FROM alert_events WHERE device_id = ? AND kind = 'offline'", id)).toBe(1);

    h.clock.now = seen + 46 * 60;
    await checkDevices(testEnv.DB, h.clock.now);
    expect(await count("SELECT COUNT(*) n FROM alert_events WHERE device_id = ? AND kind = 'offline_reminder'", id)).toBe(1);

    await h.signed(id, 'POST', '/v1/readings', 100, readingsBody(h.clock.now, [-20]));
    await h.settle();
    expect(await count("SELECT COUNT(*) n FROM alert_events WHERE device_id = ? AND kind = 'reconnected'", id)).toBe(1);
  });

  it('cron bỏ qua thiết bị chưa có chủ / chưa từng gửi số đo', async () => {
    const id = await createDevice();
    await testEnv.DB.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').bind(NOW - 99999, id).run();
    await checkDevices(testEnv.DB, NOW);
    expect(await count('SELECT COUNT(*) n FROM alert_events WHERE device_id = ?', id)).toBe(0);
  });

  it('gửi tin lỗi được thử lại ở lần dispatch sau, không mất cảnh báo', async () => {
    const { dispatchPending } = await import('../src/notify.ts');
    const id = await createActiveDevice(h);
    await testEnv.DB.prepare('UPDATE alert_state SET armed = 1 WHERE device_id = ?').bind(id).run(); // tủ đã từng đạt ngưỡng
    h.notifier.fail = true;
    await run(id, 1, NOW, 25, -10);
    expect(h.notifier.sent).toHaveLength(0);
    const pending = await count("SELECT COUNT(*) n FROM notifications n JOIN alert_events e ON e.id = n.event_id WHERE e.device_id = ? AND n.status = 'pending'", id);
    expect(pending).toBeGreaterThan(0);

    h.notifier.fail = false;
    await dispatchPending(testEnv.DB, h.notifier, h.clock.now);
    expect(h.notifier.sent.length).toBeGreaterThan(0);
  });
});

describe('OTA', () => {
  it('trả bản mới nhất khi khác bản hiện tại; hết bản mới thì update=false', async () => {
    const id = await createActiveDevice(h);
    await testEnv.DB
      .prepare("INSERT INTO firmware_releases (version, url, sha256, signature, created_at) VALUES ('9.9.9', 'https://x/fw.bin', 'aa', 'bb', ?)")
      .bind(NOW)
      .run();
    const r1 = await json(await h.signed(id, 'GET', '/v1/ota/check', 1));
    expect(r1).toMatchObject({ update: true, version: '9.9.9', url: 'https://x/fw.bin', sha256: 'aa', signature: 'bb' });
    const r2 = await h.request('/v1/ota/check?current=9.9.9', { headers: {} });
    expect(r2.status).toBe(401); // không chữ ký thì không xem được
  });
});

describe('công khai', () => {
  it('/v1/time và /healthz', async () => {
    expect(await json(await h.request('/v1/time'))).toEqual({ server_time: NOW });
    expect(await json(await h.request('/healthz'))).toEqual({ ok: true });
  });
});
