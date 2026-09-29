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
  parseOkUntil,
  parseReadings,
  parseRecipient,
  parseRecipientList,
  parseServerTime,
  type Device,
  type Readings,
  type Recipient,
} from './lib/schemas.ts';
import type { Kind } from './lib/thresholds.ts';

export const REQUEST_TIMEOUT_MS = 15_000;
/** Chờ Zalo trả token tối đa ngần này (hộp thoại cấp quyền treo/cầu nối SDK không trả lời). */
export const TOKEN_TIMEOUT_MS = 30_000;
/** Bỏ phản hồi lớn bất thường (trang lỗi/độc hại) thay vì nạp vào bộ nhớ điện thoại. */
export const MAX_RESPONSE_CHARS = 2_000_000;
/** Chờ ngắn trước khi thử lại GET gặp lỗi tạm thời 502/503/504 (Cloudflare) hoặc mất mạng thoáng qua. */
export const RETRY_DELAY_MS = 800;

export interface ApiOptions {
  /** Địa chỉ gốc của server, ví dụ https://auhono.example.workers.dev (không có dấu / cuối). */
  baseUrl: string;
  /** Lấy Zalo access token; trả chuỗi rỗng/ném lỗi nếu người dùng chưa cấp quyền. */
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  tokenTimeoutMs?: number;
  retryDelayMs?: number;
  /** Gọi mỗi khi phản hồi có `server_time` hợp lệ: (server_time, giờ gửi, giờ nhận) để hiệu chỉnh đồng hồ. */
  onServerTime?: (serverTime: number, sentAtMs: number, receivedAtMs: number) => void;
}

/** Tuỳ chọn cho từng lệnh gọi. `signal` để huỷ khi rời màn hình (chỉ dùng cho lệnh ĐỌC, không dùng cho lệnh ghi). */
export interface CallOptions {
  signal?: AbortSignal;
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
  const tokenTimeoutMs = opts.tokenTimeoutMs ?? TOKEN_TIMEOUT_MS;
  const retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;

  interface Raw {
    json: unknown;
    sentAt: number;
    receivedAt: number;
  }

  /** Một lần gọi (có hạn 15 giây). Ném AppError với mã rõ ràng. */
  async function attempt(method: string, path: string, token: string, body: unknown, external?: AbortSignal): Promise<Raw> {
    if (external?.aborted) throw new AppError('aborted');
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onExternalAbort = () => controller.abort();
    external?.addEventListener('abort', onExternalAbort, { once: true });
    const failure = (): AppError => new AppError(external?.aborted ? 'aborted' : timedOut ? 'timeout' : 'network');

    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let res: Response;
      const sentAt = Date.now();
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
        throw failure();
      }
      // Đọc thân phản hồi cũng nằm trong hạn 15 giây (signal vẫn còn hiệu lực).
      let json: unknown = null;
      let text = '';
      try {
        text = await res.text();
      } catch {
        throw failure();
      }
      if (text.length > MAX_RESPONSE_CHARS) throw new AppError('bad_response', res.status);
      try {
        json = text === '' ? null : JSON.parse(text);
      } catch {
        // Trang HTML của Cloudflare/portal Wi-Fi/proxy: không phải JSON.
        if (res.ok) throw new AppError('bad_response', res.status);
      }
      if (!res.ok) throw mapHttpError(res.status, json);
      const receivedAt = Date.now();
      return { json, sentAt, receivedAt };
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    }
  }

  /** Lấy token MỚI cho từng request (không cache): Zalo tự làm mới token nên token cũ có thể đã hết hạn. */
  async function freshToken(): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AppError('timeout')), tokenTimeoutMs);
      });
      return ((await Promise.race([opts.getToken(), timeout])) as string | undefined) || '';
    } catch (e) {
      if (e instanceof AppError && e.code === 'timeout') throw e;
      return '';
    } finally {
      clearTimeout(timer);
    }
  }

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /** Lỗi tạm thời đáng thử lại cho lệnh ĐỌC: mất mạng thoáng qua, hoặc 502/503/504 từ Cloudflare. */
  const transient = (e: unknown) =>
    e instanceof AppError && (e.code === 'network' || e.status === 502 || e.status === 503 || e.status === 504);

  /**
   * - GET tự thử lại đúng 1 lần khi lỗi tạm thời (POST/PATCH/DELETE không tự lặp để tránh làm hai lần).
   * - Gặp 401: lấy token mới; nếu khác token vừa dùng thì thử lại đúng 1 lần (401 = server chưa xử lý gì nên an toàn với mọi lệnh).
   */
  async function request(method: string, path: string, body?: unknown, call?: CallOptions): Promise<Raw> {
    let token = await freshToken();
    if (!token) throw new AppError('auth_required');

    const run = async (): Promise<Raw> => {
      try {
        return await attempt(method, path, token, body, call?.signal);
      } catch (e) {
        if (method === 'GET' && transient(e)) {
          await sleep(retryDelayMs);
          return attempt(method, path, token, body, call?.signal);
        }
        throw e;
      }
    };

    try {
      return await run();
    } catch (e) {
      if (e instanceof AppError && e.status === 401 && e.code === 'unauthorized') {
        const next = await freshToken();
        if (next && next !== token) {
          token = next;
          return run();
        }
      }
      throw e;
    }
  }

  /** Báo giờ server (nếu có) cho bộ hiệu chỉnh đồng hồ. */
  function noteServerTime(raw: Raw): void {
    const t = parseServerTime(raw.json);
    if (t !== undefined) opts.onServerTime?.(t, raw.sentAt, raw.receivedAt);
  }

  const dev = (id: string) => `/v1/devices/${encodeURIComponent(id)}`;

  return {
    listDevices: async (call?: CallOptions): Promise<Device[]> => {
      const raw = await request('GET', '/v1/devices', undefined, call);
      const devices = parseDeviceList(raw.json);
      noteServerTime(raw);
      return devices;
    },

    claimDevice: async (input: ClaimInput): Promise<void> => {
      parseOk((await request('POST', '/v1/devices/claim', input)).json);
    },

    updateDevice: async (id: string, patch: DevicePatch): Promise<void> => {
      parseOk((await request('PATCH', dev(id), patch)).json);
    },

    removeDevice: async (id: string): Promise<void> => {
      parseOk((await request('DELETE', dev(id))).json);
    },

    /** "Đã biết, đang xử lý": dừng tin nhắc lại `hours` giờ (1..24). Trả mốc `acked_until` (Unix giây). 409 no_active_alert nếu không có sự cố. Gọi lại an toàn. */
    ackDevice: async (id: string, hours = 4): Promise<number> =>
      parseOkUntil((await request('POST', `${dev(id)}/ack`, { hours: Math.min(24, Math.max(1, Math.trunc(hours) || 4)) })).json, 'acked_until'),

    /** Tạm dừng cảnh báo `days` ngày (1..60). Trả mốc `paused_until`. Gọi lại an toàn (chỉ dời mốc). */
    pauseDevice: async (id: string, days: number): Promise<number> =>
      parseOkUntil((await request('POST', `${dev(id)}/pause`, { days: Math.min(60, Math.max(1, Math.trunc(days) || 1)) })).json, 'paused_until'),

    /** Bật lại cảnh báo sớm. Gọi lại an toàn. */
    resumeDevice: async (id: string): Promise<void> => {
      parseOk((await request('DELETE', `${dev(id)}/pause`)).json);
    },

    getReadings: async (id: string, hours = 24, call?: CallOptions): Promise<Readings> => {
      const h = Math.min(168, Math.max(1, Math.trunc(hours) || 24));
      const raw = await request('GET', `${dev(id)}/readings?hours=${h}`, undefined, call);
      const readings = parseReadings(raw.json);
      noteServerTime(raw);
      return readings;
    },

    listRecipients: async (id: string, call?: CallOptions): Promise<Recipient[]> =>
      parseRecipientList((await request('GET', `${dev(id)}/recipients`, undefined, call)).json),

    addRecipient: async (id: string, input: { name: string; phone: string }): Promise<Recipient> =>
      parseRecipient((await request('POST', `${dev(id)}/recipients`, input)).json),

    removeRecipient: async (id: string, recipientId: number): Promise<void> => {
      parseOk((await request('DELETE', `${dev(id)}/recipients/${Math.trunc(recipientId)}`)).json);
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
