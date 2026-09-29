import { describe, expect, it } from 'vitest';
import { formatVnTime, templateData, templateFor, ZnsNotifier } from '../src/zns.ts';
import type { NotificationMessage } from '../src/notify.ts';
import { NOW, testEnv } from './helpers.ts';
import type { Env } from '../src/types.ts';

const msg: NotificationMessage = {
  channel: 'zns', target: '84912345678', kind: 'temp_alarm', deviceName: 'Tủ kem', tempC: -9.46, detail: 'high', ts: 1_800_000_000, minC: -40, maxC: -18,
};
const env = { ...testEnv, ZNS_TEMPLATE_ALERT: 'T1', ZNS_TEMPLATE_OFFLINE: 'T2', ZNS_TEMPLATE_RECOVERED: 'T3', ZALO_APP_ID: 'app', ZALO_APP_SECRET: 'sec', ZALO_OA_REFRESH_TOKEN: 'r0' } as Env;

describe('ZNS', () => {
  it('chọn template theo loại sự kiện', () => {
    expect(templateFor(env, 'temp_alarm')).toBe('T1');
    expect(templateFor(env, 'temp_reminder')).toBe('T1');
    expect(templateFor(env, 'offline')).toBe('T2');
    expect(templateFor(env, 'offline_reminder')).toBe('T2');
    expect(templateFor(env, 'recovered')).toBe('T3');
    expect(templateFor(env, 'reconnected')).toBe('T3');
  });

  it('giờ Việt Nam (UTC+7) và dữ liệu template', () => {
    expect(formatVnTime(Date.UTC(2026, 8, 29, 7, 5) / 1000)).toBe('14:05 29/09');
    expect(templateData(msg)).toEqual({ device_name: 'Tủ kem', temperature: '-9.5°C', threshold: 'tối đa -18°C', time: formatVnTime(msg.ts) });
    expect(templateData({ ...msg, detail: 'low', tempC: null })).toMatchObject({ temperature: '--', threshold: 'tối thiểu -40°C' });
  });

  it('làm mới token lần đầu, lưu token xoay vòng, gọi ZNS đúng định dạng', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('oauth')) return Response.json({ access_token: 'acc1', refresh_token: 'r1', expires_in: '90000' });
      return Response.json({ error: 0, message: 'Success' });
    }) as unknown as typeof fetch;
    await testEnv.DB.prepare("DELETE FROM kv WHERE key = 'zalo_oa_tokens'").run();

    const n = new ZnsNotifier(env, () => NOW, fetchFn);
    await n.send(msg);
    await n.send(msg); // lần 2 dùng lại token đã lưu, không refresh nữa

    expect(calls.filter((c) => c.url.includes('oauth'))).toHaveLength(1);
    const zns = calls.filter((c) => c.url.includes('business.openapi'));
    expect(zns).toHaveLength(2);
    expect((zns[0]!.init.headers as Record<string, string>).access_token).toBe('acc1');
    expect(JSON.parse(zns[0]!.init.body as string)).toMatchObject({ phone: '84912345678', template_id: 'T1' });
    const kv = await testEnv.DB.prepare("SELECT value FROM kv WHERE key = 'zalo_oa_tokens'").first<{ value: string }>();
    expect(JSON.parse(kv!.value)).toMatchObject({ refresh_token: 'r1', expires_at: NOW + 90000 });
  });

  it('token hết hạn (-216): làm mới rồi thử lại đúng một lần', async () => {
    let zns = 0;
    const fetchFn = (async (url: string) => {
      if (url.includes('oauth')) return Response.json({ access_token: 'acc-new', refresh_token: 'r2', expires_in: 90000 });
      return ++zns === 1 ? Response.json({ error: -216, message: 'expired' }) : Response.json({ error: 0 });
    }) as unknown as typeof fetch;
    await testEnv.DB.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('zalo_oa_tokens', ?, 0)")
      .bind(JSON.stringify({ access_token: 'old', refresh_token: 'r1', expires_at: NOW + 99999 })).run();
    await new ZnsNotifier(env, () => NOW, fetchFn).send(msg);
    expect(zns).toBe(2);
  });

  it('lỗi từ ZNS thì ném lỗi (để hàng đợi thử lại); thiếu template cũng vậy', async () => {
    const fetchFn = (async () => Response.json({ error: -118, message: 'phone invalid' })) as unknown as typeof fetch;
    await testEnv.DB.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('zalo_oa_tokens', ?, 0)")
      .bind(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: NOW + 99999 })).run();
    await expect(new ZnsNotifier(env, () => NOW, fetchFn).send(msg)).rejects.toThrow('-118');
    await expect(new ZnsNotifier({ ...env, ZNS_TEMPLATE_ALERT: '' } as Env, () => NOW, fetchFn).send(msg)).rejects.toThrow('template');
  });
});
