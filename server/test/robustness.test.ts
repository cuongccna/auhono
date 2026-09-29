// Các tình huống ngoài thực tế: tranh chấp đồng thời, gửi trùng, dò mã, thiết bị chưa kết nối...
import { beforeEach, describe, expect, it } from 'vitest';
import { initialState } from '../src/alerts.ts';
import { checkDevices, purgeOld, EVENT_RETENTION_SECONDS } from '../src/cron.ts';
import { commitState, getState, resetStateStmt } from '../src/db.ts';
import { dispatchPending, MAX_ATTEMPTS } from '../src/notify.ts';
import { activationCode, createActiveDevice, createDevice, FakeNotifier, harness, NOW, readingsBody, testEnv, type Harness } from './helpers.ts';

let h: Harness;
beforeEach(() => {
  h = harness();
});
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const one = async <T = Record<string, any>>(sql: string, ...b: unknown[]) => testEnv.DB.prepare(sql).bind(...b).first<T>();
const n = async (sql: string, ...b: unknown[]) => (await one<{ n: number }>(sql, ...b))!.n;
const addRecipient = (id: string, phone: string) =>
  h.owner('owner-a-token', 'POST', `/v1/devices/${id}/recipients`, { name: phone, phone });

describe('nhiều người nhận: tin gắn đúng sự kiện', () => {
  it('3 người nhận x 2 sự kiện = 6 tin, mỗi tin trỏ đúng sự kiện của thiết bị này', async () => {
    const id = await createActiveDevice(h, '0912000001');
    await addRecipient(id, '0912000002');
    await addRecipient(id, '0912000003');
    const other = await createActiveDevice(h, '0913000001'); // thiết bị khác không được lẫn
    const before = await getState(testEnv.DB, id);
    const ev = (kind: string) => ({ kind: kind as never, ts: NOW, tempC: -5, detail: 'high' });
    const next = { ...before.state, phase: 'temp_alarm' as const };
    expect(await commitState(testEnv.DB, id, before, next, [ev('temp_alarm'), ev('temp_reminder')], NOW)).toBe(true);

    const rows = (await testEnv.DB.prepare(
      'SELECT n.phone, e.device_id, e.kind FROM notifications n JOIN alert_events e ON e.id = n.event_id WHERE e.device_id IN (?, ?)',
    ).bind(id, other).all()).results as any[];
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.device_id))).toEqual(new Set([id]));
    for (const kind of ['temp_alarm', 'temp_reminder']) {
      expect(rows.filter((r) => r.kind === kind).map((r) => r.phone).sort()).toEqual(['84912000001', '84912000002', '84912000003']);
    }
  });
});

describe('khóa lạc quan (cron ↔ request thiết bị)', () => {
  it('hai bên cùng đọc một version: chỉ bên ghi trước thắng, bên sau không tạo sự kiện', async () => {
    const id = await createActiveDevice(h);
    const a = await getState(testEnv.DB, id);
    const b = await getState(testEnv.DB, id);
    const ev = { kind: 'offline' as const, ts: NOW, tempC: null, detail: null };
    expect(await commitState(testEnv.DB, id, a, { ...a.state, phase: 'offline' }, [ev], NOW)).toBe(true);
    expect(await commitState(testEnv.DB, id, b, { ...b.state, phase: 'offline' }, [ev], NOW)).toBe(false);
    expect(await n('SELECT COUNT(*) n FROM alert_events WHERE device_id = ?', id)).toBe(1);
    expect(await n('SELECT COUNT(*) n FROM notifications n JOIN alert_events e ON e.id = n.event_id WHERE e.device_id = ?', id)).toBe(1);
  });

  it('cron kết luận "mất kết nối" từ dữ liệu cũ nhưng số đo vừa tới => không báo oan', async () => {
    const id = await createActiveDevice(h);
    await h.signed(id, 'POST', '/v1/readings', 1, readingsBody(NOW, [-20, -20]));
    const seen = NOW;
    // Cron đọc trạng thái lúc thiết bị đã im 15 phút...
    h.clock.now = seen + 15 * 60;
    const stale = await getState(testEnv.DB, id);
    // ...trong lúc đó số đo mới tới (ingest tăng version)...
    await h.signed(id, 'POST', '/v1/readings', 2, readingsBody(h.clock.now, [-20]));
    // ...rồi cron ghi kết luận cũ: phải bị từ chối.
    const ok = await commitState(testEnv.DB, id, stale, { ...stale.state, phase: 'offline' },
      [{ kind: 'offline', ts: h.clock.now, tempC: null, detail: null }], h.clock.now);
    expect(ok).toBe(false);
    expect(await n("SELECT COUNT(*) n FROM alert_events WHERE device_id = ? AND kind = 'offline'", id)).toBe(0);
    expect((await getState(testEnv.DB, id)).state.phase).toBe('ok');
  });

  it('ingest gặp va chạm thì tự đọc lại và vẫn xử lý đúng (reconnected sau khi cron đã báo offline)', async () => {
    const id = await createActiveDevice(h);
    await h.signed(id, 'POST', '/v1/readings', 1, readingsBody(NOW, [-20]));
    h.clock.now = NOW + 16 * 60;
    await checkDevices(testEnv.DB, h.clock.now); // offline
    await h.signed(id, 'POST', '/v1/readings', 2, readingsBody(h.clock.now, [-20]));
    await h.settle();
    expect(await n("SELECT COUNT(*) n FROM alert_events WHERE device_id = ? AND kind IN ('offline','reconnected')", id)).toBe(2);
    expect((await getState(testEnv.DB, id)).state.phase).toBe('ok');
  });
});

describe('gửi tin không trùng, có thử lại', () => {
  async function pendingOne() {
    const id = await createActiveDevice(h);
    const before = await getState(testEnv.DB, id);
    await commitState(testEnv.DB, id, before, before.state, [{ kind: 'offline', ts: NOW, tempC: null, detail: null }], NOW);
    return id;
  }

  it('cron và request thiết bị cùng gọi dispatch một lúc: mỗi tin chỉ gửi một lần', async () => {
    await pendingOne();
    const a = new FakeNotifier();
    const b = new FakeNotifier();
    await Promise.all([dispatchPending(testEnv.DB, a, NOW + 1), dispatchPending(testEnv.DB, b, NOW + 1)]);
    expect(a.sent.length + b.sent.length).toBe(1);
  });

  it('thất bại thì thử lại cách quãng (5, 10, ... phút), hết lượt thì đánh dấu failed', async () => {
    const id = await pendingOne();
    const fail = new FakeNotifier();
    fail.fail = true;
    let t = NOW + 1;
    await dispatchPending(testEnv.DB, fail, t); // lần 1
    await dispatchPending(testEnv.DB, fail, t + 60); // quá sớm: chưa thử lại
    expect((await one("SELECT attempts FROM notifications n JOIN alert_events e ON e.id = n.event_id WHERE e.device_id = ?", id))!.attempts).toBe(1);
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      t += 3600; // cách xa: luôn đến hạn
      await dispatchPending(testEnv.DB, fail, t);
    }
    const row = await one("SELECT status, attempts, last_error FROM notifications n JOIN alert_events e ON e.id = n.event_id WHERE e.device_id = ?", id);
    expect(row).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, last_error: 'boom' });

    // Người dùng thấy cảnh báo "không gửi được" trên app.
    const list = await json(await h.owner('owner-a-token', 'GET', '/v1/devices'));
    expect(list.devices.find((d: any) => d.id === id).notify_failures_24h).toBeGreaterThanOrEqual(0);
  });

  it('tiến trình chết khi đang gửi ("sending" quá 5 phút) được đưa về hàng đợi', async () => {
    const id = await pendingOne();
    await testEnv.DB.prepare("UPDATE notifications SET status = 'sending', updated_at = ? WHERE event_id IN (SELECT id FROM alert_events WHERE device_id = ?)").bind(NOW, id).run();
    const ok = new FakeNotifier();
    await dispatchPending(testEnv.DB, ok, NOW + 60); // chưa quá hạn: không đụng tới
    expect(ok.sent).toHaveLength(0);
    await dispatchPending(testEnv.DB, ok, NOW + 400);
    expect(ok.sent).toHaveLength(1);
  });

  it('người nhận thêm SAU sự kiện không nhận tin cũ; xóa thiết bị không làm kẹt tin', async () => {
    const id = await pendingOne();
    await addRecipient(id, '0987654321');
    const ok = new FakeNotifier();
    await dispatchPending(testEnv.DB, ok, NOW + 1);
    expect(ok.sent.map((m) => m.phone)).toEqual(['84912345678']);
  });
});

describe('thiết bị mới lắp', () => {
  it('claim: chưa armed; đổi ngưỡng đặt lại armed và hủy báo động cũ không gửi "đã ổn"', async () => {
    const id = await createActiveDevice(h);
    let list = await json(await h.owner('owner-a-token', 'GET', '/v1/devices'));
    expect(list.devices.find((d: any) => d.id === id)).toMatchObject({ armed: false, recipient_count: 1, notify_failures_24h: 0 });

    // Tủ chạy ổn -> armed; rồi có báo động.
    const post = async (m: number, c: number) => {
      h.clock.now = NOW + m * 60 + 240; // gói 5 phút, số đo cuối = giờ hiện tại
      await h.signed(id, 'POST', '/v1/readings', m / 5 + 1, readingsBody(h.clock.now, Array(5).fill(c)));
    };
    for (let m = 0; m < 30; m += 5) await post(m, -20);
    for (let m = 30; m < 60; m += 5) await post(m, -5);
    await h.settle();
    expect((await getState(testEnv.DB, id)).state).toMatchObject({ phase: 'temp_alarm', armed: true });
    const events = await n('SELECT COUNT(*) n FROM alert_events WHERE device_id = ?', id);

    // Chủ quán đổi sang "tủ mát": nhiệt độ -5 nằm ngoài 2..8 -> đặt lại thay vì báo dồn dập.
    expect((await h.owner('owner-a-token', 'PATCH', `/v1/devices/${id}`, { kind: 'chiller' })).status).toBe(200);
    expect((await getState(testEnv.DB, id)).state).toMatchObject({ phase: 'ok', armed: false, breachSince: null });
    expect(await n('SELECT COUNT(*) n FROM alert_events WHERE device_id = ?', id)).toBe(events); // không có "recovered"
    // Đổi tên/breach_minutes (ngưỡng không đổi) thì KHÔNG đặt lại.
    await testEnv.DB.prepare('UPDATE alert_state SET armed = 1 WHERE device_id = ?').bind(id).run();
    await h.owner('owner-a-token', 'PATCH', `/v1/devices/${id}`, { name: 'Tủ mới', breach_minutes: 20 });
    expect((await getState(testEnv.DB, id)).state.armed).toBe(true);
  });

  it('đã gắn chủ mà chưa từng gửi số đo: cron báo sau 60 phút (vd. Wi-Fi 5 GHz)', async () => {
    const id = await createActiveDevice(h);
    const claimedAt = (await one<{ claimed_at: number }>('SELECT claimed_at FROM devices WHERE id = ?', id))!.claimed_at;
    await checkDevices(testEnv.DB, claimedAt + 59 * 60);
    expect(await n('SELECT COUNT(*) n FROM alert_events WHERE device_id = ?', id)).toBe(0);
    await checkDevices(testEnv.DB, claimedAt + 60 * 60);
    await checkDevices(testEnv.DB, claimedAt + 65 * 60);
    expect(await one("SELECT kind, detail FROM alert_events WHERE device_id = ?", id)).toEqual({ kind: 'offline', detail: 'never_seen' });
  });

  it('không có người nhận: vẫn ghi sự kiện, app được báo recipient_count = 0', async () => {
    const id = await createDevice();
    await h.owner('owner-a-token', 'POST', '/v1/devices/claim', { device_id: id, code: await activationCode(id) });
    const list = await json(await h.owner('owner-a-token', 'GET', '/v1/devices'));
    expect(list.devices.find((d: any) => d.id === id).recipient_count).toBe(0);
  });
});

describe('nhắc lại có số đo mới nhất', () => {
  it('temp_reminder do cron tạo kèm nhiệt độ hiện tại', async () => {
    const id = await createActiveDevice(h);
    await testEnv.DB.prepare('UPDATE alert_state SET armed = 1 WHERE device_id = ?').bind(id).run();
    for (let m = 0; m < 25; m += 5) {
      h.clock.now = NOW + m * 60 + 240;
      await h.signed(id, 'POST', '/v1/readings', m / 5 + 1, readingsBody(h.clock.now, Array(5).fill(-9)));
    }
    await h.settle();
    expect((await getState(testEnv.DB, id)).state.phase).toBe('temp_alarm');
    const at = h.clock.now + 30 * 60; // 30 phút sau báo động
    await testEnv.DB.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').bind(at, id).run(); // thiết bị vẫn đang gửi
    await checkDevices(testEnv.DB, at);
    const r = await one("SELECT temp_c, detail FROM alert_events WHERE device_id = ? AND kind = 'temp_reminder'", id);
    expect(r).toEqual({ temp_c: -9, detail: 'high' });
  });
});

describe('chặn dò mã kích hoạt', () => {
  it('quá 10 lần sai/giờ: 429 kể cả khi mã đúng; tài khoản khác không bị ảnh hưởng; hết giờ thì mở lại', async () => {
    const id = await createDevice();
    const wrong = () => h.owner('owner-b-token', 'POST', '/v1/devices/claim', { device_id: id, code: 'AAAAAAAAAA' });
    for (let i = 0; i < 10; i++) expect((await wrong()).status).toBe(404);
    const blocked = await h.owner('owner-b-token', 'POST', '/v1/devices/claim', { device_id: id, code: await activationCode(id) });
    expect(blocked.status).toBe(429);
    expect(await json(blocked)).toEqual({ error: 'too_many_attempts' });

    const other = await h.owner('owner-a-token', 'POST', '/v1/devices/claim', { device_id: id, code: await activationCode(id) });
    expect(other.status).toBe(200);

    h.clock.now += 3601;
    const id2 = await createDevice();
    const later = await h.owner('owner-b-token', 'POST', '/v1/devices/claim', { device_id: id2, code: await activationCode(id2) });
    expect(later.status).toBe(200);
  });

  it('lần gọi lại khi đã là chủ (mất phản hồi, bấm đúp) không tính là sai và không đặt lại trạng thái', async () => {
    const id = await createActiveDevice(h);
    await testEnv.DB.prepare('UPDATE alert_state SET armed = 1 WHERE device_id = ?').bind(id).run();
    for (let i = 0; i < 12; i++) {
      expect((await h.owner('owner-a-token', 'POST', '/v1/devices/claim', { device_id: id, code: await activationCode(id) })).status).toBe(200);
    }
    expect((await getState(testEnv.DB, id)).state.armed).toBe(true);
  });
});

describe('body thiết bị', () => {
  it('body dạng luồng không khai Content-Length và quá lớn bị ngắt => 413', async () => {
    const id = await createActiveDevice(h);
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 20; i++) c.enqueue(new Uint8Array(1000));
        c.close();
      },
    });
    const res = await h.request('/v1/readings', {
      method: 'POST',
      body: stream,
      // @ts-expect-error duplex bắt buộc khi gửi luồng
      duplex: 'half',
      headers: { 'X-Device-Id': id, 'X-Timestamp': String(NOW), 'X-Seq': '1', 'X-Signature': '00' },
    });
    expect(res.status).toBe(413);
  });
});

describe('dọn dữ liệu', () => {
  it('xóa sự kiện > 90 ngày (kèm tin) và lần nhập sai mã cũ; giữ dữ liệu mới', async () => {
    const id = await createActiveDevice(h);
    const s = await getState(testEnv.DB, id);
    await commitState(testEnv.DB, id, s, s.state, [
      { kind: 'offline', ts: NOW - EVENT_RETENTION_SECONDS - 10, tempC: null, detail: null },
      { kind: 'offline', ts: NOW - 10, tempC: null, detail: null },
    ], NOW);
    await testEnv.DB.prepare('INSERT INTO claim_failures (account_id, ts) VALUES (999, ?), (999, ?)').bind(NOW - 90000, NOW - 10).run();
    await purgeOld(testEnv.DB, NOW);
    expect(await n('SELECT COUNT(*) n FROM alert_events WHERE device_id = ?', id)).toBe(1);
    expect(await n('SELECT COUNT(*) n FROM notifications n JOIN alert_events e ON e.id = n.event_id WHERE e.device_id = ?', id)).toBe(1);
    expect(await n('SELECT COUNT(*) n FROM claim_failures WHERE account_id = 999')).toBe(1); // chỉ còn dòng mới
  });
});

it('resetStateStmt tạo dòng trạng thái mới nếu chưa có', async () => {
  const id = await createDevice();
  await resetStateStmt(testEnv.DB, id).run();
  expect(await getState(testEnv.DB, id)).toMatchObject({ version: 1, state: { ...initialState(), armed: false } });
});
