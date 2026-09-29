import { env } from 'cloudflare:workers';
import { createApp, type Deps } from '../src/app.ts';
import { canonicalString, deriveActivationCode, deriveDeviceKey, signCanonical } from '../src/crypto.ts';
import type { NotificationMessage, Notifier } from '../src/notify.ts';
import type { Env } from '../src/types.ts';

export const testEnv = env as unknown as Env;
export const NOW = 1_800_000_000;

export class FakeNotifier implements Notifier {
  sent: NotificationMessage[] = [];
  fail = false;
  async send(m: NotificationMessage) {
    if (this.fail) throw new Error('boom');
    this.sent.push(m);
  }
}

export interface Harness {
  clock: { now: number };
  notifier: FakeNotifier;
  pending: Promise<unknown>[];
  request(path: string, init?: RequestInit): Promise<Response>;
  /** Chờ các tác vụ waitUntil (gửi tin nền) xong. */
  settle(): Promise<void>;
  /** Yêu cầu có chữ ký HMAC như chip thật. */
  signed(deviceId: string, method: string, path: string, seq: number, body?: unknown, tsOverride?: number): Promise<Response>;
  owner(token: string, method: string, path: string, body?: unknown): Promise<Response>;
}

export function harness(over: Partial<Env> = {}, fetchFn?: typeof fetch): Harness {
  const clock = { now: NOW };
  const notifier = new FakeNotifier();
  const pending: Promise<unknown>[] = [];
  const owners: Record<string, { id: string; name: string }> = {
    'owner-a-token': { id: 'zalo-a', name: 'Chủ A' },
    'owner-b-token': { id: 'zalo-b', name: 'Chủ B' },
  };
  const deps: Deps = {
    now: () => clock.now,
    verifyOwner: async (t) => owners[t] ?? null,
    notifier: () => notifier,
    fetchFn,
  };
  const app = createApp(deps);
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
  const request = (path: string, init?: RequestInit) => Promise.resolve(app.request(path, init, { ...testEnv, ...over }, ctx));

  return {
    clock,
    notifier,
    pending,
    request,
    async settle() {
      await Promise.all(pending.splice(0));
    },
    async signed(deviceId, method, path, seq, body, tsOverride) {
      const raw = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
      const ts = tsOverride ?? clock.now;
      const key = await deriveDeviceKey(testEnv.MASTER_SECRET, deviceId);
      const sig = await signCanonical(key, await canonicalString({ method, path, deviceId, timestamp: ts, seq, body: raw }));
      return request(path, {
        method,
        body: method === 'GET' ? undefined : raw,
        headers: { 'X-Device-Id': deviceId, 'X-Timestamp': String(ts), 'X-Seq': String(seq), 'X-Signature': sig },
      });
    },
    owner(token, method, path, body) {
      return request(path, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    },
  };
}

let counter = 0;
/** Tạo thiết bị mới với id duy nhất (các test chia sẻ DB trong cùng file). */
export async function createDevice(over: { claimedBy?: string } = {}): Promise<string> {
  const id = `AUH-${String(++counter + Math.floor(Math.random() * 1e6) * 10).padStart(6, '0').slice(-6)}`;
  await testEnv.DB.prepare('INSERT INTO devices (id, created_at) VALUES (?, ?)').bind(id, NOW).run();
  return id;
}

export const activationCode = (id: string) => deriveActivationCode(testEnv.MASTER_SECRET, id);

/** Tạo thiết bị đã gắn chủ (zalo-a) + 1 người nhận, sẵn sàng đo/cảnh báo. */
export async function createActiveDevice(h: Harness, phone = '0912345678'): Promise<string> {
  const id = await createDevice();
  const res = await h.owner('owner-a-token', 'POST', '/v1/devices/claim', {
    device_id: id,
    code: await activationCode(id),
    kind: 'freezer',
    name: 'Tủ kem',
  });
  if (res.status !== 200) throw new Error(`claim failed ${res.status}`);
  const r = await h.owner('owner-a-token', 'POST', `/v1/devices/${id}/recipients`, { name: 'Vợ', phone });
  if (r.status !== 201) throw new Error(`recipient failed ${r.status}`);
  return id;
}

export const readingsBody = (now: number, temps: number[], fw?: string) => ({
  ...(fw ? { fw } : {}),
  // Số đo cách nhau 1 phút, số cuối cùng = `now`.
  readings: temps.map((c, i) => ({ t: now - (temps.length - 1 - i) * 60, c })),
});
