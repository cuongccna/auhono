import { describe, expect, it, vi } from 'vitest';
import { addRecipient, claimDevice, removeDevice } from './actions.ts';
import { AppError } from './lib/errors.ts';
import type { Device, Recipient } from './lib/schemas.ts';

const dev = (id: string): Device => ({
  id, name: 'Tủ', kind: 'freezer', min_c: -40, max_c: -18, breach_minutes: 15, last_seen: null, firmware: null, phase: 'ok', latest: null,
});
const input = { device_id: 'AUH-000001', code: 'ABCDEFGHJK', name: 'Tủ kem', kind: 'freezer' as const };

function fakeApi(over: Record<string, unknown> = {}) {
  return {
    claimDevice: vi.fn(async () => undefined),
    listDevices: vi.fn(async () => [] as Device[]),
    listRecipients: vi.fn(async () => [] as Recipient[]),
    addRecipient: vi.fn(async (_id: string, r: { name: string; phone: string }) => ({ id: 1, ...r })),
    removeDevice: vi.fn(async () => undefined),
    ...over,
  } as unknown as Parameters<typeof claimDevice>[0] & Record<string, ReturnType<typeof vi.fn>>;
}

describe('claimDevice: đã kích hoạt xong ở server nhưng mất phản hồi', () => {
  it('bình thường: gọi 1 lần, không cần kiểm tra thêm', async () => {
    const api = fakeApi();
    await claimDevice(api, input);
    expect(api.claimDevice).toHaveBeenCalledTimes(1);
    expect(api.listDevices).not.toHaveBeenCalled();
  });

  it.each(['network', 'timeout'] as const)('%s nhưng thiết bị đã có trong danh sách => coi là THÀNH CÔNG', async (code) => {
    const api = fakeApi({
      claimDevice: vi.fn(async () => { throw new AppError(code); }),
      listDevices: vi.fn(async () => [dev('AUH-000001')]),
    });
    await expect(claimDevice(api, input)).resolves.toBeUndefined();
  });

  it('502 (Cloudflare) rồi thiết bị đã có trong danh sách => thành công', async () => {
    const api = fakeApi({
      claimDevice: vi.fn(async () => { throw new AppError('internal', 502); }),
      listDevices: vi.fn(async () => [dev('AUH-000001')]),
    });
    await expect(claimDevice(api, input)).resolves.toBeUndefined();
  });

  it('lỗi mạng và thiết bị KHÔNG có trong danh sách => báo lỗi gốc để người dùng bấm lại', async () => {
    const api = fakeApi({ claimDevice: vi.fn(async () => { throw new AppError('network'); }), listDevices: vi.fn(async () => [dev('AUH-000002')]) });
    await expect(claimDevice(api, input)).rejects.toMatchObject({ code: 'network' });
  });

  it('lỗi mạng và cũng không kiểm tra được danh sách => báo lỗi gốc', async () => {
    const api = fakeApi({
      claimDevice: vi.fn(async () => { throw new AppError('timeout'); }),
      listDevices: vi.fn(async () => { throw new AppError('network'); }),
    });
    await expect(claimDevice(api, input)).rejects.toMatchObject({ code: 'timeout' });
  });

  it.each(['invalid_code', 'too_many_attempts', 'bad_request', 'auth_unavailable', 'unauthorized'] as const)(
    'lỗi rõ ràng %s: báo ngay, KHÔNG kiểm tra danh sách (server chắc chắn chưa làm gì)',
    async (code) => {
      const api = fakeApi({ claimDevice: vi.fn(async () => { throw new AppError(code, code === 'invalid_code' ? 404 : 400); }) });
      await expect(claimDevice(api, input)).rejects.toMatchObject({ code });
      expect(api.listDevices).not.toHaveBeenCalled();
    },
  );
});

describe('addRecipient: mất phản hồi / đã đủ 5 người', () => {
  const rec = { name: 'Vợ', phone: '84912345678' };

  it('bình thường', async () => {
    const api = fakeApi();
    expect(await addRecipient(api, 'AUH-000001', rec)).toMatchObject({ phone: '84912345678' });
  });

  it('người thứ 5 đã được thêm nhưng mất phản hồi; gửi lại bị 409 => nhận ra số đã có, coi là thành công', async () => {
    const api = fakeApi({
      addRecipient: vi.fn(async () => { throw new AppError('too_many_recipients', 409); }),
      listRecipients: vi.fn(async () => [{ id: 9, ...rec }]),
    });
    expect(await addRecipient(api, 'AUH-000001', rec)).toMatchObject({ id: 9 });
  });

  it('409 thật (đủ 5 người khác) => vẫn báo lỗi', async () => {
    const api = fakeApi({
      addRecipient: vi.fn(async () => { throw new AppError('too_many_recipients', 409); }),
      listRecipients: vi.fn(async () => [1, 2, 3, 4, 5].map((i) => ({ id: i, name: 'x', phone: `8491234567${i}` }))),
    });
    await expect(addRecipient(api, 'AUH-000001', rec)).rejects.toMatchObject({ code: 'too_many_recipients' });
  });

  it('lỗi mạng rồi số đã có trong danh sách => thành công; chưa có => báo lỗi', async () => {
    const net = () => vi.fn(async () => { throw new AppError('network'); });
    expect(await addRecipient(fakeApi({ addRecipient: net(), listRecipients: vi.fn(async () => [{ id: 3, ...rec }]) }), 'AUH-000001', rec)).toMatchObject({ id: 3 });
    await expect(addRecipient(fakeApi({ addRecipient: net() }), 'AUH-000001', rec)).rejects.toMatchObject({ code: 'network' });
  });

  it('lỗi dữ liệu (400) báo ngay, không đọc lại danh sách', async () => {
    const api = fakeApi({ addRecipient: vi.fn(async () => { throw new AppError('bad_request', 400); }) });
    await expect(addRecipient(api, 'AUH-000001', rec)).rejects.toMatchObject({ code: 'bad_request' });
    expect(api.listRecipients).not.toHaveBeenCalled();
  });
});

describe('removeDevice: idempotent', () => {
  it('gỡ lần hai (lần đầu đã xong nhưng mất phản hồi) => server trả 404, coi là đã gỡ', async () => {
    const api = fakeApi({ removeDevice: vi.fn(async () => { throw new AppError('not_found', 404); }) });
    await expect(removeDevice(api, 'AUH-000001')).resolves.toBeUndefined();
  });
  it('lỗi khác vẫn báo', async () => {
    const api = fakeApi({ removeDevice: vi.fn(async () => { throw new AppError('network'); }) });
    await expect(removeDevice(api, 'AUH-000001')).rejects.toMatchObject({ code: 'network' });
  });
});
