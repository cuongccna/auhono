import { describe, expect, it, vi } from 'vitest';
import { assertSafeBase, createApiClient } from './api-client.ts';
import { AppError } from './lib/errors.ts';

const BASE = 'https://api.example.test';
const TOKEN = 'zalo-token-0123456789';

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function client(fetchImpl: typeof fetch, extra: Partial<Parameters<typeof createApiClient>[0]> = {}) {
  return createApiClient({ baseUrl: BASE, getToken: async () => TOKEN, fetchImpl, ...extra });
}

const device = { id: 'AUH-000001', name: 'Tủ', kind: 'freezer', min_c: -40, max_c: -18, breach_minutes: 15, last_seen: null, firmware: null, phase: 'ok', latest: null };

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return (e as AppError).code;
  }
  throw new Error('phải ném lỗi');
}

describe('gửi request', () => {
  it('gắn Bearer token, URL đúng, không gửi cookie, GET không có body', async () => {
    const f = vi.fn<typeof fetch>(async () => jsonRes({ devices: [device] }));
    const list = await client(f).listDevices();
    expect(list).toHaveLength(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/v1/devices`);
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init!.method).toBe('GET');
    expect(init!.body).toBeUndefined();
    expect(init!.credentials).toBe('omit');
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it('POST gửi JSON', async () => {
    const f = vi.fn<typeof fetch>(async () => jsonRes({ ok: true, device_id: 'AUH-000001' }));
    await client(f).claimDevice({ device_id: 'AUH-000001', code: 'ABCDEFGHJK', kind: 'chiller', name: 'Tủ mát' });
    const init = f.mock.calls[0]![1]!;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ device_id: 'AUH-000001', code: 'ABCDEFGHJK', kind: 'chiller', name: 'Tủ mát' });
  });

  it('mã thiết bị được mã hóa trong đường dẫn (không chèn được /)', async () => {
    const f = vi.fn<typeof fetch>(async () => jsonRes({ ok: true }));
    await client(f).removeDevice('a/../b?x=1');
    expect(f.mock.calls[0]![0]).toBe(`${BASE}/v1/devices/a%2F..%2Fb%3Fx%3D1`);
  });

  it('readings: giới hạn hours trong 1..168', async () => {
    const f = vi.fn<typeof fetch>(async () => jsonRes({ min_c: 1, max_c: 2, points: [] }));
    await client(f).getReadings('AUH-000001', 24);
    await client(f).getReadings('AUH-000001', 99999);
    await client(f).getReadings('AUH-000001', NaN);
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      `${BASE}/v1/devices/AUH-000001/readings?hours=24`,
      `${BASE}/v1/devices/AUH-000001/readings?hours=168`,
      `${BASE}/v1/devices/AUH-000001/readings?hours=24`,
    ]);
  });

  it('người nhận: thêm/xóa đúng đường dẫn', async () => {
    const f = vi.fn<typeof fetch>(async () => jsonRes({ id: 3, name: 'Vợ', phone: '84912345678' }, 201));
    const r = await client(f).addRecipient('AUH-000001', { name: 'Vợ', phone: '84912345678' });
    expect(r.id).toBe(3);
    expect(f.mock.calls[0]![0]).toBe(`${BASE}/v1/devices/AUH-000001/recipients`);
    f.mockResolvedValueOnce(jsonRes({ ok: true }));
    await client(f).removeRecipient('AUH-000001', 3);
    expect(f.mock.calls[1]![0]).toBe(`${BASE}/v1/devices/AUH-000001/recipients/3`);
    expect(f.mock.calls[1]![1]!.method).toBe('DELETE');
  });
});

describe('xác thực', () => {
  it('không lấy được token => auth_required, không gọi mạng', async () => {
    const f = vi.fn<typeof fetch>();
    expect(await codeOf(client(f, { getToken: async () => '' }).listDevices())).toBe('auth_required');
    expect(await codeOf(client(f, { getToken: async () => { throw new Error('denied'); } }).listDevices())).toBe('auth_required');
    expect(f).not.toHaveBeenCalled();
  });

  it('server trả 401 => unauthorized', async () => {
    const f = vi.fn<typeof fetch>(async () => jsonRes({ error: 'unauthorized' }, 401));
    expect(await codeOf(client(f).listDevices())).toBe('unauthorized');
  });

  it('token không bị rò vào thông điệp lỗi', async () => {
    const f = vi.fn<typeof fetch>(async () => jsonRes({ error: 'unauthorized' }, 401));
    try {
      await client(f).listDevices();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(TOKEN);
      expect(JSON.stringify(e)).not.toContain(TOKEN);
    }
  });
});

describe('ánh xạ lỗi server', () => {
  it.each([
    [409, 'too_many_recipients'],
    [404, 'not_found'],
    [404, 'invalid_code'],
    [400, 'bad_request'],
    [400, 'bad_range'],
  ])('HTTP %i + %s', async (status, error) => {
    const f = vi.fn<typeof fetch>(async () => jsonRes({ error }, status));
    expect(await codeOf(client(f).updateDevice('AUH-000001', { name: 'x' }))).toBe(error);
  });

  it('phản hồi lỗi không phải JSON (trang lỗi của proxy) => suy từ status', async () => {
    const f = vi.fn<typeof fetch>(async () => new Response('<html>502</html>', { status: 502 }));
    expect(await codeOf(client(f).claimDevice({ device_id: 'AUH-000001', code: 'X' }))).toBe('internal');
  });

  it('200 nhưng sai dạng => bad_response', async () => {
    const f = vi.fn<typeof fetch>(async () => jsonRes({ devices: 'no' }));
    expect(await codeOf(client(f).listDevices())).toBe('bad_response');
    const g = vi.fn<typeof fetch>(async () => new Response('', { status: 200 }));
    expect(await codeOf(client(g).listDevices())).toBe('bad_response');
  });
});

describe('mạng lỗi, thử lại, hết hạn', () => {
  it('GET thử lại đúng 1 lần khi lỗi mạng rồi thành công', async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonRes({ devices: [] }));
    expect(await client(f).listDevices()).toEqual([]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('GET lỗi mạng 2 lần => network (chỉ 2 lần gọi)', async () => {
    const f = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await codeOf(client(f).listDevices())).toBe('network');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('POST/PATCH/DELETE KHÔNG thử lại (tránh làm hai lần)', async () => {
    const f = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch');
    });
    const c = client(f);
    expect(await codeOf(c.claimDevice({ device_id: 'AUH-000001', code: 'X' }))).toBe('network');
    expect(await codeOf(c.updateDevice('AUH-000001', { name: 'x' }))).toBe('network');
    expect(await codeOf(c.removeDevice('AUH-000001'))).toBe('network');
    expect(await codeOf(c.addRecipient('AUH-000001', { name: 'a', phone: '84912345678' }))).toBe('network');
    expect(f).toHaveBeenCalledTimes(4);
  });

  it('lỗi HTTP (vd. 404) không được thử lại', async () => {
    const f = vi.fn<typeof fetch>(async () => jsonRes({ error: 'not_found' }, 404));
    expect(await codeOf(client(f).listRecipients('AUH-000001'))).toBe('not_found');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('quá hạn => timeout: huỷ request bằng AbortController, không thử lại', async () => {
    const f = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    expect(await codeOf(client(f, { timeoutMs: 20 }).listDevices())).toBe('timeout');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('mặc định hạn 15 giây', async () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      );
      const p = codeOf(client(f).listDevices());
      await vi.advanceTimersByTimeAsync(14_999);
      expect(f.mock.calls[0]![1]!.signal!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(await p).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('assertSafeBase', () => {
  it('chỉ cho https (hoặc localhost khi dev) và bỏ dấu / cuối', () => {
    expect(assertSafeBase('https://a.example.com/')).toBe('https://a.example.com');
    expect(assertSafeBase('http://localhost:8787')).toBe('http://localhost:8787');
    for (const bad of ['http://a.example.com', 'ftp://x', 'a.example.com', 'https://a.example.com/v1', 'javascript:alert(1)', '']) {
      expect(() => assertSafeBase(bad)).toThrow();
    }
  });
});
