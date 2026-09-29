// Khách HTTP gọi API của Auhono (server/src/app.ts, nhóm "Chủ quán").
// Tách khỏi zmp-sdk (nhận `getToken`, `fetchImpl` từ ngoài) để test được không cần môi trường Zalo.
//
// Bảo mật:
//  - Token chỉ nằm trong header Authorization của từng request; KHÔNG log, KHÔNG lưu lại.
//  - Chỉ gọi HTTPS (trừ localhost khi phát triển) — kiểm tra ở `assertSafeBase`.
//  - Mọi phản hồi được kiểm tra dạng dữ liệu trước khi đưa vào giao diện.

import { AppError, mapHttpError } from './lib/errors.ts';
import {
  parseDeviceList,
  parseOk,
  parseReadings,
  parseRecipient,
  parseRecipientList,
  type Device,
  type Readings,
  type Recipient,
} from './lib/schemas.ts';
import type { Kind } from './lib/thresholds.ts';

export const REQUEST_TIMEOUT_MS = 15_000;

export interface ApiOptions {
  /** Địa chỉ gốc của server, ví dụ https://auhono.example.workers.dev (không có dấu / cuối). */
  baseUrl: string;
  /** Lấy Zalo access token; trả chuỗi rỗng/ném lỗi nếu người dùng chưa cấp quyền. */
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ClaimInput {
  device_id: string;
  code: string;
  name?: string;
  kind?: Kind;
}

export interface DevicePatch {
  name?: string;
  kind?: Kind;
  min_c?: number;
  max_c?: number;
  breach_minutes?: number;
}

/** Chỉ cho phép https (hoặc http://localhost để chạy thử ở máy dev). */
export function assertSafeBase(baseUrl: string): string {
  const url = baseUrl.trim().replace(/\/+$/, '');
  const ok = /^https:\/\/[^\s/]+$/i.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url);
  if (!ok) throw new Error('VITE_API_BASE phải là địa chỉ https:// (không kèm đường dẫn).');
  return url;
}

export function createApiClient(opts: ApiOptions) {
  const baseUrl = assertSafeBase(opts.baseUrl);
  const doFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;

  /** Một lần gọi (có hạn 15 giây). Ném AppError với mã rõ ràng. */
  async function attempt(method: string, path: string, token: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let res: Response;
      try {
        res = await doFetch(baseUrl + path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
          cache: 'no-store',
          credentials: 'omit', // không gửi cookie: xác thực chỉ bằng Bearer token
        });
      } catch {
        throw new AppError(timedOut ? 'timeout' : 'network');
      }
      // Đọc thân phản hồi cũng nằm trong hạn 15 giây (signal vẫn còn hiệu lực).
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        if (timedOut) throw new AppError('timeout');
        if (res.ok) throw new AppError('bad_response', res.status);
      }
      if (!res.ok) throw mapHttpError(res.status, json);
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET tự thử lại đúng 1 lần khi lỗi mạng (không thử lại POST/PATCH/DELETE để tránh làm 2 lần). */
  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    let token = '';
    try {
      token = (await opts.getToken()) || '';
    } catch {
      token = '';
    }
    if (!token) throw new AppError('auth_required');

    try {
      return await attempt(method, path, token, body);
    } catch (e) {
      if (method === 'GET' && e instanceof AppError && e.code === 'network') {
        return attempt(method, path, token, body);
      }
      throw e;
    }
  }

  const dev = (id: string) => `/v1/devices/${encodeURIComponent(id)}`;

  return {
    listDevices: async (): Promise<Device[]> => parseDeviceList(await request('GET', '/v1/devices')),

    claimDevice: async (input: ClaimInput): Promise<void> => {
      parseOk(await request('POST', '/v1/devices/claim', input));
    },

    updateDevice: async (id: string, patch: DevicePatch): Promise<void> => {
      parseOk(await request('PATCH', dev(id), patch));
    },

    removeDevice: async (id: string): Promise<void> => {
      parseOk(await request('DELETE', dev(id)));
    },

    getReadings: async (id: string, hours = 24): Promise<Readings> =>
      parseReadings(await request('GET', `${dev(id)}/readings?hours=${Math.min(168, Math.max(1, Math.trunc(hours) || 24))}`)),

    listRecipients: async (id: string): Promise<Recipient[]> =>
      parseRecipientList(await request('GET', `${dev(id)}/recipients`)),

    addRecipient: async (id: string, input: { name: string; phone: string }): Promise<Recipient> =>
      parseRecipient(await request('POST', `${dev(id)}/recipients`, input)),

    removeRecipient: async (id: string, recipientId: number): Promise<void> => {
      parseOk(await request('DELETE', `${dev(id)}/recipients/${Math.trunc(recipientId)}`));
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
