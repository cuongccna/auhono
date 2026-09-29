import { describe, expect, it } from 'vitest';
import { commitState, getState } from '../src/db.ts';
import { dispatchPending, PermanentNotifyError, RouterNotifier, type NotificationMessage } from '../src/notify.ts';
import { notifyOperator, sendTelegram, telegramText, TelegramNotifier } from '../src/telegram.ts';
import type { Env } from '../src/types.ts';
import { createActiveDevice, FakeNotifier, harness, NOW, testEnv, type Harness } from './helpers.ts';

const TG: Partial<Env> = {
  TELEGRAM_BOT_TOKEN: 'bot-token',
  TELEGRAM_WEBHOOK_SECRET: 'webhook-secret-123',
  TELEGRAM_BOT_USERNAME: 'AuhonoBot',
};
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const one = async <T = Record<string, any>>(sql: string, ...b: unknown[]) => testEnv.DB.prepare(sql).bind(...b).first<T>();

/** fetch giả ghi lại các cuộc gọi tới Telegram. */
function fakeTelegram(reply: () => Response = () => Response.json({ ok: true })) {
  const calls: { url: string; body: any }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    return reply();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const msg: NotificationMessage = { channel: 'telegram', target: '555', kind: 'temp_alarm', deviceName: 'Tủ kem', tempC: -9.46, detail: 'high', ts: 1_800_000_000, minC: -40, maxC: -18 };

describe('nội dung tin Telegram', () => {
  it('đủ các loại sự kiện, tên tủ là văn bản thường (không diễn giải HTML/Markdown)', () => {
    for (const kind of ['temp_alarm', 'temp_reminder', 'offline', 'offline_reminder', 'recovered', 'reconnected'] as const) {
      const t = telegramText({ ...msg, kind, deviceName: '<b>*Tủ*</b>' });
      expect(t).toContain('<b>*Tủ*</b>');
      expect(t.length).toBeGreaterThan(20);
    }
    expect(telegramText(msg)).toContain('-9,5°C');
    expect(telegramText({ ...msg, kind: 'offline', tempC: null })).toContain('đứt dây đầu dò');
    expect(telegramText({ ...msg, detail: 'low' })).toContain('tối thiểu -40°C');
  });
});

describe('gửi Telegram', () => {
  it('thành công; gọi đúng URL/thân', async () => {
    const t = fakeTelegram();
    await new TelegramNotifier('tok', t.fn).send(msg);
    expect(t.calls[0]!.url).toBe('https://api.telegram.org/bottok/sendMessage');
    expect(t.calls[0]!.body).toMatchObject({ chat_id: '555', disable_web_page_preview: true });
  });
  it('403/400 là lỗi vĩnh viễn; 429/500/mạng là lỗi tạm', async () => {
    const mk = (code: number) => fakeTelegram(() => Response.json({ ok: false, error_code: code, description: 'x', parameters: { retry_after: 3 } }, { status: code })).fn;
    await expect(sendTelegram('t', 1, 'x', mk(403))).rejects.toBeInstanceOf(PermanentNotifyError);
    await expect(sendTelegram('t', 1, 'x', mk(400))).rejects.toBeInstanceOf(PermanentNotifyError);
    for (const code of [429, 500, 502]) {
      const err = await sendTelegram('t', 1, 'x', mk(code)).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(PermanentNotifyError);
    }
    const down = (async () => { throw new Error('net'); }) as unknown as typeof fetch;
    const err = await sendTelegram('t', 1, 'x', down).catch((e) => e);
    expect(err).not.toBeInstanceOf(PermanentNotifyError);
  });
  it('báo người vận hành: chỉ khi đã cấu hình; không bao giờ ném lỗi', async () => {
    const t = fakeTelegram();
    await notifyOperator({ ...testEnv } as Env, 'x', t.fn);
    expect(t.calls).toHaveLength(0);
    await notifyOperator({ ...testEnv, ...TG, OPERATOR_TELEGRAM_CHAT_ID: '42' } as Env, 'cron lỗi', t.fn);
    expect(t.calls[0]!.body).toMatchObject({ chat_id: '42', text: '[Auhono] cron lỗi' });
    const bad = fakeTelegram(() => Response.json({ ok: false, error_code: 500 }, { status: 500 }));
    await expect(notifyOperator({ ...testEnv, ...TG, OPERATOR_TELEGRAM_CHAT_ID: '42' } as Env, 'x', bad.fn)).resolves.toBeUndefined();
  });
});

describe('liên kết Telegram cho người nhận', () => {
  async function setup(over: Partial<Env> = TG, tg = fakeTelegram()) {
    const h = harness(over, tg.fn);
    const id = await createActiveDevice(h);
    const rid = ((await json(await h.owner('owner-a-token', 'GET', `/v1/devices/${id}/recipients`))).recipients[0] as any).id as number;
    return { h, id, rid, tg };
  }
  const webhook = (h: Harness, body: unknown, secret: string = TG.TELEGRAM_WEBHOOK_SECRET!) =>
    h.request('/telegram/webhook', { method: 'POST', body: JSON.stringify(body), headers: secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret, 'Content-Type': 'application/json' } : {} });
  const start = (token: string, chatId = 777, type = 'private') => ({ message: { text: `/start ${token}`, chat: { id: chatId, type } } });
  const tokenOf = (url: string) => new URL(url).searchParams.get('start')!;

  it('chưa cấu hình Telegram => 503; app biết qua telegram_available=false', async () => {
    const { h, id, rid } = await setup({});
    expect((await h.owner('owner-a-token', 'POST', `/v1/devices/${id}/recipients/${rid}/telegram-link`)).status).toBe(503);
    expect((await json(await h.owner('owner-a-token', 'GET', `/v1/devices/${id}/recipients`))).telegram_available).toBe(false);
    expect((await webhook(h, start('x'.repeat(22)))).status).toBe(404);
  });

  it('luồng đầy đủ: tạo liên kết → /start → liên kết, mode both, có tin trả lời; token dùng một lần', async () => {
    const { h, id, rid, tg } = await setup();
    const link = await json(await h.owner('owner-a-token', 'POST', `/v1/devices/${id}/recipients/${rid}/telegram-link`));
    expect(link.url).toMatch(/^https:\/\/t\.me\/AuhonoBot\?start=[A-Za-z0-9_-]{22}$/);
    expect(link.expires_at).toBe(NOW + 24 * 3600);
    const token = tokenOf(link.url);

    expect((await webhook(h, start(token, 777))).status).toBe(200);
    expect(await one('SELECT mode, telegram_chat_id FROM recipients WHERE id = ?', rid)).toEqual({ mode: 'both', telegram_chat_id: 777 });
    expect(tg.calls.at(-1)!.body).toMatchObject({ chat_id: 777 });
    expect(tg.calls.at(-1)!.body.text).toContain('Đã kết nối');
    const list = await json(await h.owner('owner-a-token', 'GET', `/v1/devices/${id}/recipients`));
    expect(list).toMatchObject({ telegram_available: true });
    expect(list.recipients[0]).toMatchObject({ mode: 'both', telegram_linked: true });

    // Dùng lại token (người khác nhặt được liên kết): không liên kết thêm.
    await webhook(h, start(token, 888));
    expect((await one<{ telegram_chat_id: number }>('SELECT telegram_chat_id FROM recipients WHERE id = ?', rid))!.telegram_chat_id).toBe(777);
    expect(tg.calls.at(-1)!.body.text).toContain('hết hạn');
  });

  it('bí mật webhook sai/thiếu => 401 và không đổi gì; token sai định dạng/hết hạn bị từ chối', async () => {
    const { h, id, rid } = await setup();
    const token = tokenOf((await json(await h.owner('owner-a-token', 'POST', `/v1/devices/${id}/recipients/${rid}/telegram-link`))).url);
    expect((await webhook(h, start(token), 'sai')).status).toBe(401);
    expect((await webhook(h, start(token), '')).status).toBe(401); // thiếu header
    expect((await one<{ telegram_chat_id: number | null }>('SELECT telegram_chat_id FROM recipients WHERE id = ?', rid))!.telegram_chat_id).toBeNull();

    await webhook(h, start("' OR 1=1 --"));
    await webhook(h, start('a'.repeat(200)));
    await testEnv.DB.prepare('UPDATE telegram_links SET expires_at = ? WHERE token = ?').bind(NOW - 1, token).run(); // hết hạn
    await webhook(h, start(token));
    expect((await one<{ telegram_chat_id: number | null }>('SELECT telegram_chat_id FROM recipients WHERE id = ?', rid))!.telegram_chat_id).toBeNull();
  });

  it('chat nhóm/kênh bị bỏ qua (không liên kết cảnh báo vào nhóm)', async () => {
    const { h, id, rid } = await setup();
    const token = tokenOf((await json(await h.owner('owner-a-token', 'POST', `/v1/devices/${id}/recipients/${rid}/telegram-link`))).url);
    await webhook(h, start(token, -1001234, 'supergroup'));
    expect((await one<{ telegram_chat_id: number | null }>('SELECT telegram_chat_id FROM recipients WHERE id = ?', rid))!.telegram_chat_id).toBeNull();
  });

  it('/stop và hủy liên kết từ app đều đưa người nhận về chỉ ZNS', async () => {
    const { h, id, rid } = await setup();
    const link = async () => tokenOf((await json(await h.owner('owner-a-token', 'POST', `/v1/devices/${id}/recipients/${rid}/telegram-link`))).url);
    await webhook(h, start(await link(), 777));
    await webhook(h, { message: { text: '/stop', chat: { id: 777, type: 'private' } } });
    expect(await one('SELECT mode, telegram_chat_id FROM recipients WHERE id = ?', rid)).toEqual({ mode: 'zns', telegram_chat_id: null });

    await webhook(h, start(await link(), 777));
    expect((await h.owner('owner-a-token', 'DELETE', `/v1/devices/${id}/recipients/${rid}/telegram`)).status).toBe(200);
    expect(await one('SELECT mode, telegram_chat_id FROM recipients WHERE id = ?', rid)).toEqual({ mode: 'zns', telegram_chat_id: null });
  });

  it('người khác không tạo/đổi/hủy được cho người nhận của mình', async () => {
    const { h, id, rid } = await setup();
    for (const [m, p, b] of [
      ['POST', `/v1/devices/${id}/recipients/${rid}/telegram-link`, undefined],
      ['PATCH', `/v1/devices/${id}/recipients/${rid}`, { mode: 'zns' }],
      ['DELETE', `/v1/devices/${id}/recipients/${rid}/telegram`, undefined],
    ] as const) expect((await h.owner('owner-b-token', m, p, b)).status).toBe(404);
  });

  it('đổi kênh: telegram/both cần đã liên kết; zns luôn được', async () => {
    const { h, id, rid } = await setup();
    const patch = (mode: string) => h.owner('owner-a-token', 'PATCH', `/v1/devices/${id}/recipients/${rid}`, { mode });
    expect((await patch('telegram')).status).toBe(409);
    expect((await patch('both')).status).toBe(409);
    expect((await patch('zns')).status).toBe(200);
    expect((await patch('sms')).status).toBe(400);
    const token = tokenOf((await json(await h.owner('owner-a-token', 'POST', `/v1/devices/${id}/recipients/${rid}/telegram-link`))).url);
    await webhook(h, start(token));
    expect((await patch('telegram')).status).toBe(200);
  });
});

describe('định tuyến kênh khi tạo tin', () => {
  async function twoRecipients() {
    const h = harness(TG);
    const id = await createActiveDevice(h, '0912000001'); // người nhận chính
    await h.owner('owner-a-token', 'POST', `/v1/devices/${id}/recipients`, { name: 'B', phone: '0912000002' });
    const recs = (await testEnv.DB.prepare('SELECT id FROM recipients WHERE device_id = ? ORDER BY id').bind(id).all()).results as { id: number }[];
    const link = (rid: number, chat: number, mode: string) =>
      testEnv.DB.prepare('UPDATE recipients SET telegram_chat_id = ?, mode = ? WHERE id = ?').bind(chat, mode, rid).run();
    return { h, id, recs, link };
  }
  const rows = async (id: string, kind: string) =>
    (await testEnv.DB.prepare(
      `SELECT n.channel, n.target, n.status FROM notifications n JOIN alert_events e ON e.id = n.event_id
       WHERE e.device_id = ? AND e.kind = ? ORDER BY n.channel, n.target`,
    ).bind(id, kind).all()).results as { channel: string; target: string; status: string }[];
  const emit = async (id: string, kind: string, paused: number | null = null) => {
    const b = await getState(testEnv.DB, id);
    await commitState(testEnv.DB, id, b, b.state, [{ kind: kind as never, ts: NOW, tempC: -5, detail: 'high' }], NOW, [], paused);
  };

  it('both => mỗi người có tin ZNS và tin Telegram độc lập; telegram-only => không có tin ZNS', async () => {
    const { id, recs, link } = await twoRecipients();
    await link(recs[0]!.id, 111, 'both');
    await link(recs[1]!.id, 222, 'telegram');
    await emit(id, 'temp_alarm');
    expect(await rows(id, 'temp_alarm')).toEqual([
      { channel: 'telegram', target: '111', status: 'pending' },
      { channel: 'telegram', target: '222', status: 'pending' },
      { channel: 'zns', target: '84912000001', status: 'pending' },
    ]);
  });

  it('nhắc lại: ZNS chỉ người nhận chính (tốn tiền), Telegram gửi mọi người đã liên kết (miễn phí)', async () => {
    const { id, recs, link } = await twoRecipients();
    await link(recs[0]!.id, 111, 'both');
    await link(recs[1]!.id, 222, 'both');
    await emit(id, 'temp_reminder');
    expect(await rows(id, 'temp_reminder')).toEqual([
      { channel: 'telegram', target: '111', status: 'pending' },
      { channel: 'telegram', target: '222', status: 'pending' },
      { channel: 'zns', target: '84912000001', status: 'pending' },
    ]);
  });

  it('đang tạm dừng: cả hai kênh bị chặn', async () => {
    const { id, recs, link } = await twoRecipients();
    await link(recs[0]!.id, 111, 'both');
    await emit(id, 'temp_alarm', NOW + 1000);
    expect((await rows(id, 'temp_alarm')).every((r) => r.status === 'suppressed')).toBe(true);
  });

  it('vượt trần chi phí: ZNS bị chặn nhưng Telegram (miễn phí) vẫn gửi', async () => {
    const { DAILY_MESSAGE_CAP } = await import('../src/db.ts');
    const { id, recs, link } = await twoRecipients();
    await link(recs[0]!.id, 111, 'both');
    for (let i = 0; i < DAILY_MESSAGE_CAP; i++) await emit(id, 'offline');
    await emit(id, 'temp_alarm'); // ZNS đã chạm trần
    expect(await rows(id, 'temp_alarm')).toEqual([
      { channel: 'telegram', target: '111', status: 'pending' },
      { channel: 'zns', target: '84912000001', status: 'suppressed' },
      { channel: 'zns', target: '84912000002', status: 'suppressed' },
    ]);
  });

  it('dispatch: định tuyến đúng kênh; lỗi vĩnh viễn của Telegram => failed ngay và báo người vận hành', async () => {
    const { id, recs, link } = await twoRecipients();
    await link(recs[0]!.id, 111, 'both');
    await emit(id, 'recovered');
    const zns = new FakeNotifier();
    const tg = fakeTelegram(() => Response.json({ ok: false, error_code: 403, description: 'bot was blocked' }, { status: 403 }));
    const failures: any[] = [];
    // Dọn hàng đợi của các test khác trước để kiểm tra chính xác.
    await testEnv.DB.prepare("UPDATE notifications SET status = 'sent'").run();
    await emit(id, 'offline');
    await dispatchPending(testEnv.DB, new RouterNotifier({ zns, telegram: new TelegramNotifier('t', tg.fn) }), NOW + 10, async (f) => void failures.push(...f));
    expect(zns.sent.map((m) => m.target).sort()).toEqual(['84912000001', '84912000002']); // cả hai người nhận ZNS
    expect(tg.calls).toHaveLength(1);
    expect(failures).toEqual([{ channel: 'telegram', target: '111', error: expect.stringContaining('403') }]);
    const row = await one("SELECT status, attempts FROM notifications WHERE channel = 'telegram' AND target = '111' AND status = 'failed'");
    expect(row).toMatchObject({ status: 'failed', attempts: 1 }); // không thử lại 8 lần
  });
});
