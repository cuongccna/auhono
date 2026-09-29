// @vitest-environment jsdom
// Kiểm tra khói toàn ứng dụng trong jsdom: zmp-sdk và fetch được giả lập.
// LƯU Ý: đây KHÔNG phải chạy trong Zalo; chỉ xác nhận các màn hình dựng được và luồng chính gọi đúng API.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../sdk.ts', () => ({
  getToken: async () => 'tok-0123456789',
  requestAccess: async () => undefined,
  openPermissions: async () => undefined,
  scanQr: async () => ({ status: 'ok', content: 'auhono://claim?d=AUH-000009&c=ABCDEFGHJK' }),
  askCameraPermission: async () => true,
  isZaloDarkTheme: () => false,
}));

import Root from './app.tsx';

// jsdom thiếu vài API của trình duyệt mà zmp-ui gọi.
Element.prototype.scrollTo = () => undefined;

const NOW = Math.floor(Date.now() / 1000);
const device = {
  id: 'AUH-000001', name: 'Tủ kem', kind: 'freezer', min_c: -40, max_c: -18, breach_minutes: 15,
  last_seen: NOW - 60, firmware: '1.0.0', phase: 'ok', latest: { ts: NOW - 60, temp_c: -20.5 },
};
const points = Array.from({ length: 12 }, (_, i) => ({ t: NOW - 3600 + i * 300, avg: -20, min: -20.5, max: -19.5 }));

let calls: { url: string; method: string; body: unknown }[] = [];
let recipients: { id: number; name: string; phone: string }[] = [];

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
  recipients = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = url.replace('https://api.auhono.invalid', '');
    const method = init.method ?? 'GET';
    calls.push({ url: path, method, body: init.body ? JSON.parse(init.body as string) : undefined });
    if (path === '/v1/devices' && method === 'GET') return jsonRes({ devices: [device] });
    if (path.startsWith('/v1/devices/AUH-000001/readings')) return jsonRes({ min_c: -40, max_c: -18, points });
    if (path === '/v1/devices/AUH-000001/recipients' && method === 'GET') return jsonRes({ recipients });
    if (path === '/v1/devices/AUH-000001/recipients' && method === 'POST') {
      const b = JSON.parse(init.body as string);
      recipients.push({ id: 1, name: b.name, phone: b.phone });
      return jsonRes({ id: 1, ...b }, 201);
    }
    if (path === '/v1/devices/AUH-000001' && method === 'DELETE') return jsonRes({ ok: true });
    if (path === '/v1/devices/claim') return jsonRes({ ok: true, device_id: 'AUH-000009' });
    return jsonRes({ error: 'not_found' }, 404);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function open(path: string) {
  window.history.pushState({}, '', path);
  render(<Root />);
}

describe('ứng dụng (jsdom, SDK giả lập)', () => {
  it('màn hình chính: liệt kê thiết bị với nhiệt độ và trạng thái', async () => {
    open('/');
    expect(await screen.findByText('Tủ kem')).toBeTruthy();
    expect(screen.getByText('-20,5°C')).toBeTruthy();
    expect(screen.getByText('Bình thường')).toBeTruthy();
    expect(calls[0]).toMatchObject({ url: '/v1/devices', method: 'GET' });
  });

  it('chi tiết thiết bị: có biểu đồ SVG và nút đặt ngưỡng / người nhận / gỡ', async () => {
    open('/device/AUH-000001');
    await waitFor(() => expect(document.querySelector('svg.auh-chart')).not.toBeNull());
    expect(screen.getByText('Đặt ngưỡng cảnh báo')).toBeTruthy();
    expect(screen.getByText('Người nhận cảnh báo')).toBeTruthy();
    expect(screen.getByText('Gỡ thiết bị')).toBeTruthy();
    expect(calls.some((c) => c.url === '/v1/devices/AUH-000001/readings?hours=24')).toBe(true);
  });

  it('gỡ thiết bị: phải qua bước xác nhận mới gọi DELETE', async () => {
    open('/device/AUH-000001');
    fireEvent.click(await screen.findByRole('button', { name: 'Gỡ thiết bị' }));
    expect(await screen.findByText('Gỡ thiết bị này?')).toBeTruthy();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    const buttons = screen.getAllByRole('button', { name: 'Gỡ thiết bị' });
    fireEvent.click(buttons[buttons.length - 1]!); // nút xác nhận trong hộp thoại
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/v1/devices/AUH-000001')).toBe(true));
  });

  it('người nhận: số sai bị chặn ngay trên máy, số đúng được chuẩn hóa rồi gửi', async () => {
    open('/device/AUH-000001/recipients');
    const name = await screen.findByLabelText('Tên');
    const phone = screen.getByLabelText('Số điện thoại Zalo');

    fireEvent.change(name, { target: { value: 'Vợ' } });
    fireEvent.change(phone, { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Thêm' }));
    expect(await screen.findByText(/Số điện thoại còn thiếu số/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    fireEvent.change(phone, { target: { value: '+84 912 345 678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Thêm' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'Vợ', phone: '84912345678' }));
    expect(await screen.findByText('0912 345 678')).toBeTruthy();
  });

  it('ngưỡng: kiểm tra Nâng cao trước khi gửi', async () => {
    open('/device/AUH-000001/thresholds');
    const max = await screen.findByLabelText('Cao nhất (°C)');
    fireEvent.change(max, { target: { value: '-50' } }); // nhỏ hơn mức thấp nhất -40
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(await screen.findByText(/lớn hơn nhiệt độ thấp nhất/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('kích hoạt: quét QR điền sẵn mã, nhập tay sai thì báo lỗi, đúng thì gọi claim', async () => {
    open('/activate');
    fireEvent.click(await screen.findByRole('button', { name: 'Quét mã QR' }));
    expect(await screen.findByText(/Đã quét thiết bị AUH-000009/)).toBeTruthy();
    expect((screen.getByLabelText('Mã thiết bị') as HTMLInputElement).value).toBe('AUH-000009');

    fireEvent.change(screen.getByLabelText('Mã kích hoạt'), { target: { value: 'xx' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kích hoạt' }));
    expect(await screen.findByText(/Mã kích hoạt gồm 10 ký tự/)).toBeTruthy();
    expect(calls.some((c) => c.url === '/v1/devices/claim')).toBe(false);

    fireEvent.change(screen.getByLabelText('Mã kích hoạt'), { target: { value: 'abcde-fghjk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kích hoạt' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/v1/devices/claim')?.body).toEqual({
        device_id: 'AUH-000009', code: 'ABCDEFGHJK', name: 'Tủ đông', kind: 'freezer',
      }),
    );
  });
});
