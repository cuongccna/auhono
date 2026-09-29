// @vitest-environment jsdom
// Kịch bản thực tế ở mức màn hình (jsdom, zmp-sdk và fetch giả lập). KHÔNG phải chạy trong Zalo thật.
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  token: 'tok-0123456789',
  requestAccess: vi.fn(async () => undefined),
  openPermissions: vi.fn(async () => undefined),
  scanQr: vi.fn(async () => ({ status: 'cancelled' }) as unknown),
  askCameraPermission: vi.fn(async () => true),
  dark: false,
  openTelegramLink: vi.fn(async (_u: string) => true),
  shareText: vi.fn(async (_t: string) => true),
  copyText: vi.fn(async (_t: string) => true),
}));
vi.mock('./sdk.ts', () => ({
  getToken: async () => sdk.token,
  requestAccess: (...a: unknown[]) => (sdk.requestAccess as (...x: unknown[]) => Promise<void>)(...a),
  openPermissions: () => sdk.openPermissions(),
  scanQr: () => sdk.scanQr(),
  askCameraPermission: () => sdk.askCameraPermission(),
  isZaloDarkTheme: () => sdk.dark,
  openTelegramLink: (u: string) => sdk.openTelegramLink(u),
  shareText: (t: string) => sdk.shareText(t),
  copyText: (t: string) => sdk.copyText(t),
}));

import Root from './components/app.tsx';
import { ErrorBoundary } from './components/error-boundary.tsx';
import { resetClock } from './lib/clock.ts';
import { formatVnTime } from './lib/format.ts';

Element.prototype.scrollTo = () => undefined;
// GET lỗi mạng tự thử lại sau 0,8 giây (api-client): nới hạn chờ để test không phụ thuộc tốc độ máy chạy.
configure({ asyncUtilTimeout: 5000 });

type Call = { url: string; method: string; body: any };
type Json = Record<string, unknown>;

const ID = 'AUH-000001';
let skew = 0; // giây: server - điện thoại
const phoneNow = () => Math.floor(Date.now() / 1000);
const serverNow = () => phoneNow() + skew;

const SETUP = { ap_ssid: 'Auhono-0001', ap_password: 'XP1CZHP3Z0', wifi_qr: 'WIFI:T:WPA;S:Auhono-0001;P:XP1CZHP3Z0;H:false;;' };
let telegramAvailable: boolean | undefined; // undefined = server cũ (không có trường)
const TG_URL = 'https://t.me/AuhonoBot?start=tok_ABC-123';
let devices: Json[];
let recipients: Json[];
let readings: () => Json;
let calls: Call[];
/** Ghi đè từng request (trả undefined = dùng xử lý mặc định). */
let override: ((c: Call) => Response | undefined | Promise<Response | undefined>) | null;

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function makeDevice(over: Json = {}): Json {
  const t = serverNow();
  return {
    id: ID, name: 'Tủ kem', kind: 'freezer', min_c: -40, max_c: -18, breach_minutes: 15,
    last_seen: t - 60, firmware: '1.0.0', phase: 'ok', latest: { ts: t - 60, temp_c: -20.5 },
    armed: true, recipient_count: 2, notify_failures_24h: 0, paused_until: null, acked_until: null, claimed_at: t - 86400,
    ...over,
  };
}
const makeReadings = (temps: number[] = Array.from({ length: 12 }, () => -20)) => (): Json => {
  const t = serverNow();
  return { server_time: t, min_c: -40, max_c: -18, points: temps.map((c, i) => ({ t: t - 3600 + i * 300, avg: c, min: c - 0.5, max: c + 0.5 })) };
};

function defaultHandler(c: Call): Response {
  if (c.url === '/v1/devices' && c.method === 'GET') return jsonRes({ server_time: serverNow(), devices });
  if (c.url.startsWith(`/v1/devices/${ID}/readings`)) return jsonRes(readings());
  if (c.url === `/v1/devices/${ID}/recipients` && c.method === 'GET') {
    return jsonRes(telegramAvailable === undefined ? { recipients } : { telegram_available: telegramAvailable, recipients });
  }
  if (/\/recipients\/\d+\/telegram-link$/.test(c.url) && c.method === 'POST') return jsonRes({ url: TG_URL, expires_at: serverNow() + 86400 });
  if (/\/recipients\/\d+\/telegram$/.test(c.url) && c.method === 'DELETE') {
    const rid = Number(c.url.split('/').slice(-2)[0]);
    recipients = recipients.map((r) => (r.id === rid ? { ...r, telegram_linked: false, mode: 'zns' } : r));
    return jsonRes({ ok: true });
  }
  if (/\/recipients\/\d+$/.test(c.url) && c.method === 'PATCH') {
    const rid = Number(c.url.split('/').pop());
    recipients = recipients.map((r) => (r.id === rid ? { ...r, mode: c.body.mode } : r));
    return jsonRes({ ok: true });
  }
  if (c.url === `/v1/devices/${ID}/recipients` && c.method === 'POST') {
    recipients.push({ id: recipients.length + 1, ...c.body });
    return jsonRes({ id: recipients.length, ...c.body }, 201);
  }
  if (c.url.startsWith(`/v1/devices/${ID}/recipients/`) && c.method === 'DELETE') {
    const rid = Number(c.url.split('/').pop());
    recipients = recipients.filter((r) => r.id !== rid);
    return jsonRes({ ok: true });
  }
  if (c.url === `/v1/devices/${ID}/setup` && c.method === 'GET') return jsonRes(SETUP);
  if (c.url === `/v1/devices/${ID}/ack` && c.method === 'POST') {
    const until = serverNow() + (c.body?.hours ?? 4) * 3600;
    devices = devices.map((d) => ({ ...d, acked_until: until }));
    return jsonRes({ ok: true, acked_until: until });
  }
  if (c.url === `/v1/devices/${ID}/pause` && c.method === 'POST') {
    const until = serverNow() + c.body.days * 86400;
    devices = devices.map((d) => ({ ...d, paused_until: until, phase: 'ok' }));
    return jsonRes({ ok: true, paused_until: until });
  }
  if (c.url === `/v1/devices/${ID}/pause` && c.method === 'DELETE') {
    devices = devices.map((d) => ({ ...d, paused_until: null }));
    return jsonRes({ ok: true });
  }
  if (c.url === `/v1/devices/${ID}` && (c.method === 'PATCH' || c.method === 'DELETE')) return jsonRes({ ok: true });
  if (c.url === '/v1/devices/claim') return jsonRes({ ok: true, device_id: c.body?.device_id });
  return jsonRes({ error: 'not_found' }, 404);
}

beforeEach(() => {
  resetClock();
  skew = 0;
  calls = [];
  override = null;
  devices = [makeDevice()];
  telegramAvailable = undefined;
  sdk.openTelegramLink.mockClear().mockResolvedValue(true);
  sdk.shareText.mockClear().mockResolvedValue(true);
  sdk.copyText.mockClear().mockResolvedValue(true);
  recipients = [{ id: 1, name: 'Vợ', phone: '84912345678' }];
  readings = makeReadings();
  sdk.token = 'tok-0123456789';
  sdk.requestAccess.mockClear();
  sdk.scanQr.mockReset();
  sdk.dark = false;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const call: Call = { url: url.replace('https://api.auhono.invalid', ''), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body as string) : undefined };
    calls.push(call);
    return (await override?.(call)) ?? defaultHandler(call);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function open(path: string) {
  window.history.pushState({}, '', path);
  return render(<Root />);
}
const t = (re: string | RegExp) => screen.findByText(re);
const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const callsTo = (method: string, url: string | RegExp) =>
  calls.filter((c) => c.method === method && (typeof url === 'string' ? c.url === url : url.test(c.url)));

// ───────────────────────────── Trạng thái & đồng hồ ─────────────────────────────

describe('đồng hồ điện thoại lệch (dùng server_time)', () => {
  it('điện thoại chạy NHANH 1 giờ: thiết bị vừa gửi số đo 1 phút trước vẫn hiện "Bình thường", không phải "Mất kết nối"', async () => {
    skew = -3600; // server chậm hơn điện thoại 1 giờ
    devices = [makeDevice()];
    open('/');
    expect(await t('Bình thường')).toBeTruthy();
    expect(screen.queryByText('Mất kết nối')).toBeNull();
    expect(screen.getByText(/Cập nhật 1 phút trước/)).toBeTruthy();
  });

  it('điện thoại chạy CHẬM 1 giờ: thiết bị im lặng 20 phút vẫn bị nhận ra là mất kết nối', async () => {
    skew = 3600;
    devices = [makeDevice({ last_seen: serverNow() - 20 * 60, latest: { ts: serverNow() - 20 * 60, temp_c: -20 } })];
    open('/');
    expect(await t('Mất kết nối')).toBeTruthy();
    expect(screen.getByText(/Số đo cuối 20 phút trước/)).toBeTruthy();
  });

  it('server cũ không có server_time: vẫn chạy bằng giờ điện thoại', async () => {
    override = (c) => (c.url === '/v1/devices' ? jsonRes({ devices }) : undefined);
    open('/');
    expect(await t('Bình thường')).toBeTruthy();
  });
});

describe('trạng thái thiết bị', () => {
  it('chưa có số đo: hướng dẫn cắm điện + Wi-Fi 2.4 GHz + cổng cấu hình Auhono-XXXX', async () => {
    devices = [makeDevice({ latest: null, last_seen: null })];
    open(`/device/${ID}`);
    expect(await t(/Chưa có dữ liệu — cắm điện và kết nối Wi-Fi cho thiết bị/)).toBeTruthy();
    expect(screen.getByText('2.4 GHz')).toBeTruthy();
    expect(screen.getAllByText('Auhono-0001').length).toBeGreaterThan(0);
    expect(screen.getByText('192.168.4.1')).toBeTruthy();
    expect(screen.getByText(/Giữ nút trên thiết bị khoảng 5 giây|Không thấy mạng Auhono-0001/)).toBeTruthy();
  });

  it('mất kết nối: nói giờ nhận số đo cuối và các nguyên nhân (mất điện, Wi-Fi, đứt dây đầu dò)', async () => {
    devices = [makeDevice({ last_seen: serverNow() - 3 * 3600, latest: { ts: serverNow() - 3 * 3600, temp_c: -19 }, phase: 'offline' })];
    open(`/device/${ID}`);
    expect(await t(/Lần cuối nhận số đo lúc/)).toBeTruthy();
    expect(screen.getAllByText(/3 giờ trước/).length).toBeGreaterThan(0);
    const banner = screen.getByText(/Lần cuối nhận số đo lúc/).closest('[role="alert"]')!;
    expect(banner.textContent).toContain('mất điện');
    expect(banner.textContent).toContain('dây đầu dò');
    expect(banner.textContent).toContain('chưa chắc');
  });

  it('đang báo động: nói tủ nóng hơn mức cao nhất, nhiệt độ hiện tại và từ khoảng mấy giờ', async () => {
    const t0 = serverNow();
    devices = [makeDevice({ phase: 'temp_alarm', latest: { ts: t0 - 60, temp_c: -12 }, last_seen: t0 - 60 })];
    readings = makeReadings([-20, -20, -19, -15, -14, -13, -12, -12, -12, -12, -12, -12]);
    open(`/device/${ID}`);
    expect(await t('Đang báo động')).toBeTruthy();
    expect(screen.getAllByText('-12,0°C').length).toBeGreaterThan(0);
    expect(await t(/Tủ đang nóng hơn mức cao nhất \(-18,0°C\), từ khoảng \d\d:\d\d/)).toBeTruthy();
  });

  it('armed = false: hiện "Đang chờ tủ đạt nhiệt độ, chưa cảnh báo"', async () => {
    devices = [makeDevice({ armed: false })];
    open(`/device/${ID}`);
    expect(await t('Đang chờ tủ đạt nhiệt độ, chưa cảnh báo.')).toBeTruthy();
  });

  it('recipient_count = 0: cảnh báo nổi bật + nút dẫn tới màn hình người nhận', async () => {
    devices = [makeDevice({ recipient_count: 0 })];
    recipients = [];
    open(`/device/${ID}`);
    expect(await t('Chưa có người nhận cảnh báo — sẽ không có tin nhắn nào được gửi.')).toBeTruthy();
    click('Thêm người nhận');
    expect(await t('Thêm người nhận', )).toBeTruthy();
    await waitFor(() => expect(callsTo('GET', `/v1/devices/${ID}/recipients`).length).toBe(1));
  });

  it('notify_failures_24h > 0: cảnh báo kiểm tra số điện thoại/Zalo', async () => {
    devices = [makeDevice({ notify_failures_24h: 3 })];
    open(`/device/${ID}`);
    expect(await t('Không gửi được tin cho một số người nhận, hãy kiểm tra số điện thoại/Zalo.')).toBeTruthy();
    expect(screen.getByText(/đã chặn tài khoản Auhono/)).toBeTruthy();
  });

  it('màn hình chính cũng nhắc chưa có người nhận', async () => {
    devices = [makeDevice({ recipient_count: 0 })];
    open('/');
    expect(await t(/Chưa có người nhận cảnh báo/)).toBeTruthy();
  });

  it('có giải thích độ trễ 15 phút và ý nghĩa "mất kết nối" trong phần trợ giúp', async () => {
    open(`/device/${ID}`);
    fireEvent.click(await t('Cảnh báo hoạt động thế nào?'));
    expect(screen.getByText(/chỉ báo khi tủ nóng hoặc lạnh quá ngưỡng/)).toBeTruthy();
    expect(screen.getByText(/không gửi số đo nào trong 15 phút/)).toBeTruthy();
  });
});

// ───────────────────────────── Mạng, lỗi, dữ liệu cũ ─────────────────────────────

describe('stale-while-error', () => {
  it('làm mới thất bại: vẫn hiện số liệu cũ + "Đang hiện số liệu lúc …" + nút Thử lại', async () => {
    open('/');
    expect(await t('Tủ kem')).toBeTruthy();
    override = () => { throw new TypeError('Failed to fetch'); };
    click('Làm mới');
    expect(await t(/Không kết nối được mạng/)).toBeTruthy();
    expect(screen.getByText(/Đang hiện số liệu lúc \d\d:\d\d/)).toBeTruthy();
    expect(screen.getByText('Tủ kem')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeTruthy();
    // Bấm thử lại khi mạng có lại
    override = null;
    click('Thử lại');
    await waitFor(() => expect(screen.queryByText(/Không kết nối được mạng/)).toBeNull());
  });

  it('điện thoại mất mạng lâu: KHÔNG kết luận thiết bị "Mất kết nối" chỉ vì số liệu cũ đi', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    devices = [makeDevice({ last_seen: serverNow() - 14 * 60, latest: { ts: serverNow() - 14 * 60, temp_c: -20 } })];
    open('/');
    expect(await t('Bình thường')).toBeTruthy();
    vi.setSystemTime(Date.now() + 10 * 60_000); // 10 phút trôi qua, điện thoại mất mạng
    override = () => { throw new TypeError('Failed to fetch'); };
    click('Làm mới');
    expect(await t(/Không kết nối được mạng/)).toBeTruthy();
    expect(screen.getByText('Bình thường')).toBeTruthy(); // tình trạng tính theo LÚC TẢI CUỐI
    expect(screen.queryByText('Mất kết nối')).toBeNull();
    expect(screen.getByText(/Tình trạng thật của tủ có thể đã khác/)).toBeTruthy();
  });

  it('biểu đồ lỗi riêng: vẫn thấy trạng thái thiết bị, có nút thử lại cho biểu đồ', async () => {
    override = (c) => (c.url.includes('/readings') ? jsonRes({ error: 'internal' }, 500) : undefined);
    open(`/device/${ID}`);
    expect(await t('Bình thường')).toBeTruthy();
    expect(await t(/Hệ thống đang gặp sự cố/)).toBeTruthy();
    expect(document.querySelector('svg.auh-chart')).toBeNull();
  });
});

describe('lỗi server / xác thực', () => {
  it('503 auth_unavailable (Zalo bận): "thử lại sau ít phút", có Thử lại, KHÔNG có nút Cho phép, giữ dữ liệu cũ', async () => {
    open('/');
    expect(await t('Tủ kem')).toBeTruthy();
    override = () => jsonRes({ error: 'auth_unavailable' }, 503);
    click('Làm mới');
    expect(await t(/Zalo đang bận/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Cho phép/ })).toBeNull();
    expect(screen.getByText('Tủ kem')).toBeTruthy();
    expect(sdk.requestAccess).not.toHaveBeenCalled();
  });

  it('401: hiện nút Cho phép; bấm xong tự tải lại', async () => {
    let unauthorized = true;
    override = () => (unauthorized ? jsonRes({ error: 'unauthorized' }, 401) : undefined);
    sdk.requestAccess.mockImplementation(async () => { unauthorized = false; });
    open('/');
    click(await screen.findByRole('button', { name: 'Cho phép' }).then((b) => b.textContent as string));
    expect(await t('Tủ kem')).toBeTruthy();
    expect(sdk.requestAccess).toHaveBeenCalledTimes(1);
  });

  it('người dùng từ chối quyền: hướng dẫn mở cài đặt, không mất dữ liệu đang gõ', async () => {
    let unauthorized = true;
    override = (c) => (c.method === 'PATCH' && unauthorized ? jsonRes({ error: 'unauthorized' }, 401) : undefined);
    sdk.requestAccess.mockImplementationOnce(async () => { throw new Error('denied'); });
    open(`/device/${ID}/rename`);
    await screen.findByDisplayValue('Tủ kem');
    type('Tên tủ', 'Tủ hải sản');
    click('Lưu');
    click(await screen.findByRole('button', { name: 'Cho phép' }).then((b) => b.textContent as string));
    expect(await t(/Bạn chưa cho phép/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mở cài đặt quyền' })).toBeTruthy();
    expect((screen.getByLabelText('Tên tủ') as HTMLInputElement).value).toBe('Tủ hải sản'); // chữ đã gõ còn nguyên
    // Sau đó bật quyền trong Cài đặt: bấm Cho phép lần nữa thành công, lỗi biến mất, chữ vẫn còn
    unauthorized = false;
    click('Cho phép');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect((screen.getByLabelText('Tên tủ') as HTMLInputElement).value).toBe('Tủ hải sản');
  });

  it('token rỗng (xem thử trên trình duyệt): báo cần cho phép, không gọi mạng', async () => {
    sdk.token = '';
    open('/');
    expect(await t(/Ứng dụng cần được phép dùng tài khoản Zalo/)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('phản hồi HTML (portal Wi-Fi) => thông báo dễ hiểu, không lỗi trắng', async () => {
    override = () => new Response('<html>Please sign in</html>', { status: 200 });
    open('/');
    expect(await t(/Wi-Fi đang đòi đăng nhập/)).toBeTruthy();
  });

  it('điện thoại mất mạng (navigator.onLine = false): có banner báo', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    try {
      open('/');
      expect(await t(/Điện thoại đang không có mạng/)).toBeTruthy();
    } finally {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    }
  });
});

// ───────────────────────────── Kích hoạt ─────────────────────────────

describe('kích hoạt', () => {
  const fill = (id = ID, code = 'ABCDE-FGHJK') => {
    type('Mã thiết bị', id);
    type('Mã kích hoạt', code);
  };

  it('bấm đúp nút Kích hoạt chỉ gửi MỘT request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    override = async (c) => {
      if (c.url === '/v1/devices/claim') await gate;
      return undefined;
    };
    open('/activate');
    fill();
    const btn = screen.getByRole('button', { name: 'Kích hoạt' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    release();
    await t('Thêm người nhận');
    expect(callsTo('POST', '/v1/devices/claim')).toHaveLength(1);
  });

  it('server đã kích hoạt nhưng MẤT PHẢN HỒI: app kiểm tra danh sách và coi là thành công', async () => {
    override = (c) => {
      if (c.url === '/v1/devices/claim') throw new TypeError('Failed to fetch'); // mạng đứt sau khi server xử lý
      return undefined;
    };
    open('/activate');
    fill();
    click('Kích hoạt');
    expect(await t('Thêm người nhận')).toBeTruthy(); // sang màn hình người nhận
    expect(callsTo('POST', '/v1/devices/claim')).toHaveLength(1);
    expect(callsTo('GET', '/v1/devices').length).toBeGreaterThanOrEqual(1);
  });

  it('mất mạng thật (thiết bị chưa có trong danh sách): báo lỗi và bấm lại được', async () => {
    devices = [];
    let down = true;
    override = (c) => {
      if (down) throw new TypeError('Failed to fetch');
      return undefined;
    };
    open('/activate');
    fill();
    click('Kích hoạt');
    expect(await t(/Không kết nối được mạng/)).toBeTruthy();
    down = false;
    click('Kích hoạt');
    expect(await t('Thêm người nhận')).toBeTruthy();
  });

  it('mã sai / thiết bị của người khác: câu chung, không lộ thông tin, không kèm mã thiết bị', async () => {
    override = (c) => (c.url === '/v1/devices/claim' ? jsonRes({ error: 'invalid_code' }, 404) : undefined);
    open('/activate');
    fill();
    click('Kích hoạt');
    const box = await screen.findByRole('alert');
    expect(box.textContent).toContain('Mã không đúng, hoặc thiết bị này đang thuộc tài khoản khác');
    expect(box.textContent).toContain('Gỡ thiết bị');
    expect(box.textContent).not.toContain(ID);
  });

  it('429 too_many_attempts: thông báo thân thiện và nút tạm khóa để khỏi bấm dồn', async () => {
    override = (c) => (c.url === '/v1/devices/claim' ? jsonRes({ error: 'too_many_attempts' }, 429) : undefined);
    open('/activate');
    fill();
    click('Kích hoạt');
    expect(await t(/nhập sai mã quá nhiều lần/)).toBeTruthy();
    const btn = screen.getByRole('button', { name: /Đợi một chút/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(callsTo('POST', '/v1/devices/claim')).toHaveLength(1);
  });

  it('nhập chữ O thay số 0, chữ thường, có gạch: gửi đúng mã đã chuẩn hóa', async () => {
    open('/activate');
    fill('auh-OOOOO1', 'abcde-fghjk');
    click('Kích hoạt');
    await t('Thêm người nhận');
    expect(callsTo('POST', '/v1/devices/claim')[0]!.body).toMatchObject({ device_id: 'AUH-000001', code: 'ABCDEFGHJK' });
  });

  it('nhập sai: báo lỗi đúng ô và đưa focus vào ô lỗi đầu tiên; không gọi mạng', async () => {
    open('/activate');
    fill('xx', 'yy');
    click('Kích hoạt');
    expect(await t(/Mã thiết bị chưa đúng/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe('device-id'));
    expect(callsTo('POST', '/v1/devices/claim')).toHaveLength(0);
  });

  it('tên tủ: NFD được đổi sang NFC, khoảng trắng thừa bị cắt trước khi gửi', async () => {
    open('/activate');
    fill();
    type('Tên tủ', '  Tủ   đông  hải sản  '.normalize('NFD'));
    click('Kích hoạt');
    await t('Thêm người nhận');
    expect(callsTo('POST', '/v1/devices/claim')[0]!.body.name).toBe('Tủ đông hải sản');
  });

  it('tên tủ quá dài / rỗng bị chặn ngay trên máy', async () => {
    open('/activate');
    fill();
    type('Tên tủ', 'a'.repeat(61));
    click('Kích hoạt');
    expect(await t(/Tên tối đa 60 ký tự/)).toBeTruthy();
    type('Tên tủ', '   ');
    click('Kích hoạt');
    expect(await t(/Hãy đặt tên cho tủ/)).toBeTruthy();
    expect(callsTo('POST', '/v1/devices/claim')).toHaveLength(0);
  });

  it('quét QR thành công điền mã; QR lạ bị từ chối, không tác dụng phụ', async () => {
    sdk.scanQr.mockResolvedValueOnce({ status: 'ok', content: 'https://evil.example/?x=1' });
    open('/activate');
    click('Quét mã QR');
    expect(await t(/không phải mã QR của thiết bị Auhono/)).toBeTruthy();
    expect((screen.getByLabelText('Mã thiết bị') as HTMLInputElement).value).toBe('');
    sdk.scanQr.mockResolvedValueOnce({ status: 'ok', content: ' auhono://claim?d=auh-000009&c=abcdefghjk\n' });
    click('Quét mã QR');
    expect(await t(/Đã quét thiết bị AUH-000009/)).toBeTruthy();
    expect((screen.getByLabelText('Mã kích hoạt') as HTMLInputElement).value).toBe('ABCDEFGHJK');
  });

  it('người dùng đóng camera: thông báo nhẹ, không lỗi', async () => {
    sdk.scanQr.mockResolvedValueOnce({ status: 'cancelled' });
    open('/activate');
    click('Quét mã QR');
    expect(await t(/Chưa quét được mã/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('từ chối quyền camera: có nút Cho phép camera và Mở cài đặt quyền; cho phép xong quét lại', async () => {
    sdk.scanQr.mockResolvedValueOnce({ status: 'camera_denied' }).mockResolvedValueOnce({ status: 'ok', content: 'auhono://claim?d=AUH-000009&c=ABCDEFGHJK' });
    open('/activate');
    click('Quét mã QR');
    expect(await t(/chưa được phép dùng camera/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mở cài đặt quyền' })).toBeTruthy();
    click('Cho phép camera');
    expect(await t(/Đã quét thiết bị AUH-000009/)).toBeTruthy();
    expect(sdk.askCameraPermission).toHaveBeenCalled();
  });

  it('có hướng dẫn thiết bị bán lại và giới hạn một tài khoản mỗi thiết bị', async () => {
    open('/activate');
    fireEvent.click(await t('Thiết bị đã dùng ở tài khoản khác?'));
    expect(screen.getByText(/chỉ thuộc/)).toBeTruthy();
    expect(screen.getByText(/Gỡ thiết bị/, { exact: false })).toBeTruthy();
  });
});

// ───────────────────────────── Đổi tên ─────────────────────────────

describe('đổi tên thiết bị', () => {
  it('tên NFD → NFC, cắt khoảng trắng, gửi PATCH { name }', async () => {
    open(`/device/${ID}/rename`);
    await screen.findByLabelText('Tên tủ');
    type('Tên tủ', '  Tủ  hải sản 🍤  '.normalize('NFD'));
    click('Lưu');
    await waitFor(() => expect(callsTo('PATCH', `/v1/devices/${ID}`)).toHaveLength(1));
    expect(callsTo('PATCH', `/v1/devices/${ID}`)[0]!.body).toEqual({ name: 'Tủ hải sản 🍤' });
  });

  it('rỗng / quá dài bị chặn ngay; focus vào ô tên', async () => {
    open(`/device/${ID}/rename`);
    await screen.findByLabelText('Tên tủ');
    type('Tên tủ', '   ');
    click('Lưu');
    expect(await t(/Hãy đặt tên cho tủ/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe('rename'));
    type('Tên tủ', '🍦'.repeat(31)); // 62 đơn vị UTF-16: server sẽ từ chối
    click('Lưu');
    expect(await t(/Tên tối đa 60 ký tự/)).toBeTruthy();
    expect(callsTo('PATCH', `/v1/devices/${ID}`)).toHaveLength(0);
  });

  it('không đổi gì thì không gửi', async () => {
    open(`/device/${ID}/rename`);
    await screen.findByDisplayValue('Tủ kem');
    click('Lưu');
    await new Promise((r) => setTimeout(r, 30));
    expect(callsTo('PATCH', `/v1/devices/${ID}`)).toHaveLength(0);
  });

  it('tên có HTML được hiển thị như chữ, không chạy mã', async () => {
    devices = [makeDevice({ name: '<img src=x onerror="window.__pwned=1"><b>đậm</b>' })];
    open('/');
    expect(await t(/<img src=x/)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('.auh-device b')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('tên rất dài không chứa dấu cách vẫn được bọc dòng (CSS overflow-wrap) ở thẻ thiết bị', async () => {
    devices = [makeDevice({ name: 'Ư'.repeat(60) })];
    open('/');
    const el = await t('Ư'.repeat(60));
    expect(el.className).toContain('auh-name');
  });
});

// ───────────────────────────── Ngưỡng ─────────────────────────────

describe('đặt ngưỡng', () => {
  it('hiện nhiệt độ hiện tại cạnh form và cảnh báo khi tủ đang -12°C mà chọn Tủ đông (-18°C)', async () => {
    devices = [makeDevice({ latest: { ts: serverNow() - 60, temp_c: -12 }, min_c: 2, max_c: 8, kind: 'chiller' })];
    open(`/device/${ID}/thresholds`);
    expect(await t('Nhiệt độ tủ hiện tại')).toBeTruthy();
    expect(screen.getByText('-12,0°C')).toBeTruthy();
    // Khoảng hiện tại 2..8 cũng đã lệch (-12 < 2) => cảnh báo ngay
    expect(screen.getByText(/Nhiệt độ hiện tại -12,0°C đang vượt ngưỡng mới; báo động sẽ chỉ bật sau khi tủ đạt ngưỡng/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Tủ đông/ })); // -40..-18: -12 vẫn nóng hơn -18
    expect(screen.getByText(/đang vượt ngưỡng mới/)).toBeTruthy();
    expect(screen.getByText(/nâng "Cao nhất"/)).toBeTruthy();
    // Nâng "Cao nhất" lên -10: hết cảnh báo
    type('Cao nhất (°C)', '-10');
    expect(screen.queryByText(/đang vượt ngưỡng mới/)).toBeNull();
  });

  it('gõ dấu phẩy, dấu trừ Unicode, chữ số toàn chiều rộng: gửi SỐ đúng', async () => {
    open(`/device/${ID}/thresholds`);
    await screen.findByLabelText('Cao nhất (°C)');
    type('Thấp nhất (°C)', '−４０');
    type('Cao nhất (°C)', '-17,5');
    type('Báo sau bao nhiêu phút vượt ngưỡng', '20');
    click('Lưu');
    await waitFor(() => expect(callsTo('PATCH', `/v1/devices/${ID}`)).toHaveLength(1));
    expect(callsTo('PATCH', `/v1/devices/${ID}`)[0]!.body).toEqual({ kind: 'freezer', min_c: -40, max_c: -17.5, breach_minutes: 20 });
  });

  it('lưu xong đọc lại danh sách để biết trạng thái mới (armed) — PATCH rồi GET /v1/devices', async () => {
    open(`/device/${ID}/thresholds`);
    await screen.findByLabelText('Cao nhất (°C)');
    type('Cao nhất (°C)', '-10');
    const before = callsTo('GET', '/v1/devices').length;
    click('Lưu');
    await waitFor(() => expect(callsTo('PATCH', `/v1/devices/${ID}`)).toHaveLength(1));
    await waitFor(() => expect(callsTo('GET', '/v1/devices').length).toBeGreaterThan(before));
    const order = calls.map((c) => `${c.method} ${c.url}`);
    expect(order.lastIndexOf(`PATCH /v1/devices/${ID}`)).toBeLessThan(order.lastIndexOf('GET /v1/devices'));
  });

  it('không thay đổi gì thì KHÔNG gửi PATCH (tránh làm server đặt lại trạng thái báo động)', async () => {
    open(`/device/${ID}/thresholds`);
    await screen.findByLabelText('Cao nhất (°C)');
    click('Lưu');
    await new Promise((r) => setTimeout(r, 30));
    expect(callsTo('PATCH', `/v1/devices/${ID}`)).toHaveLength(0);
  });

  it('bấm Lưu hai lần liên tiếp chỉ gửi một PATCH', async () => {
    open(`/device/${ID}/thresholds`);
    await screen.findByLabelText('Cao nhất (°C)');
    type('Cao nhất (°C)', '-10');
    const btn = screen.getByRole('button', { name: 'Lưu' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(callsTo('PATCH', `/v1/devices/${ID}`)).toHaveLength(1));
  });

  it('nhập sai: lỗi đúng ô, focus vào ô lỗi, không gọi PATCH', async () => {
    open(`/device/${ID}/thresholds`);
    await screen.findByLabelText('Cao nhất (°C)');
    type('Cao nhất (°C)', 'abc');
    click('Lưu');
    expect(await t(/Hãy nhập một con số/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe('max'));
    expect(callsTo('PATCH', `/v1/devices/${ID}`)).toHaveLength(0);
  });

  it('giải thích ý nghĩa Cao nhất / Thấp nhất và tủ gia đình -12°C', async () => {
    open(`/device/${ID}/thresholds`);
    fireEvent.click(await t('Nâng cao'));
    expect(screen.getByText(/tủ nóng hơn mức này thì báo/)).toBeTruthy();
    expect(screen.getByText(/-12°C/)).toBeTruthy();
    expect(screen.getByText(/Sẽ báo khi nhiệt độ nóng hơn -18,0°C hoặc lạnh hơn -40,0°C liên tục 15 phút/)).toBeTruthy();
  });
});

// ───────────────────────────── Người nhận ─────────────────────────────

describe('người nhận', () => {
  it('số trùng: báo ngay, không gửi', async () => {
    open(`/device/${ID}/recipients`);
    await screen.findByLabelText('Tên');
    type('Tên', 'Vợ 2');
    type('Số điện thoại Zalo', '+84 (0) 912 345 678');
    click('Thêm');
    expect(await t(/Số này đã có trong danh sách \(Vợ\)/)).toBeTruthy();
    expect(callsTo('POST', `/v1/devices/${ID}/recipients`)).toHaveLength(0);
  });

  it('số bàn bị từ chối bằng lời giải thích rõ', async () => {
    open(`/device/${ID}/recipients`);
    await screen.findByLabelText('Tên');
    type('Tên', 'Cửa hàng');
    type('Số điện thoại Zalo', '028 1234 567');
    click('Thêm');
    expect(await t(/số điện thoại bàn/)).toBeTruthy();
  });

  it('bấm Thêm đúp chỉ tạo MỘT người nhận', async () => {
    open(`/device/${ID}/recipients`);
    await screen.findByLabelText('Tên');
    type('Tên', 'Quản lý');
    type('Số điện thoại Zalo', '0987654321');
    const btn = screen.getByRole('button', { name: 'Thêm' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(await t('0987 654 321')).toBeTruthy();
    expect(callsTo('POST', `/v1/devices/${ID}/recipients`)).toHaveLength(1);
  });

  it('đủ 5 người: ẩn form và giải thích', async () => {
    recipients = [1, 2, 3, 4, 5].map((i) => ({ id: i, name: `Người ${i}`, phone: `8491234567${i}` }));
    open(`/device/${ID}/recipients`);
    expect(await t(/Đã đủ 5 người/)).toBeTruthy();
    expect(screen.queryByLabelText('Tên')).toBeNull();
  });

  it('xóa người CUỐI CÙNG: hộp thoại cảnh báo sẽ không còn ai nhận tin; sau khi xóa hiện cảnh báo nổi bật', async () => {
    open(`/device/${ID}/recipients`);
    click(await screen.findByRole('button', { name: 'Xóa Vợ' }).then(() => 'Xóa Vợ'));
    expect(await t(/người nhận cuối cùng/)).toBeTruthy();
    const dialog = screen.getByRole('dialog', {}) ;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Xóa' }));
    expect(await t('Chưa có người nhận cảnh báo — sẽ không có tin nhắn nào được gửi.')).toBeTruthy();
    expect(callsTo('DELETE', `/v1/devices/${ID}/recipients/1`)).toHaveLength(1);
  });

  it('nhắc người nhận cần có Zalo và có thể không nhận nếu chặn OA; giới hạn 1 tài khoản/thiết bị', async () => {
    open(`/device/${ID}/recipients`);
    expect(await t(/cần có Zalo dùng đúng số đó/)).toBeTruthy();
    expect(screen.getByText(/đã chặn tài khoản Auhono/)).toBeTruthy();
    expect(screen.getByText(/chỉ thuộc một tài khoản Zalo/)).toBeTruthy();
  });

  it('gửi tin lỗi 24h: hiện cảnh báo ở màn hình người nhận', async () => {
    devices = [makeDevice({ notify_failures_24h: 2 })];
    open(`/device/${ID}/recipients`);
    expect(await t(/Không gửi được tin cho một số người nhận/)).toBeTruthy();
  });

  it('người thứ 5 đã thêm nhưng mất phản hồi, bấm lại bị 409: vẫn coi là thành công', async () => {
    recipients = [1, 2, 3, 4].map((i) => ({ id: i, name: `Người ${i}`, phone: `8491234567${i}` }));
    let first = true;
    override = (c) => {
      if (c.method === 'POST' && c.url.endsWith('/recipients')) {
        if (first) {
          first = false;
          recipients.push({ id: 5, ...c.body }); // server đã lưu…
          throw new TypeError('Failed to fetch'); // …nhưng phản hồi mất
        }
        return jsonRes({ error: 'too_many_recipients' }, 409);
      }
      return undefined;
    };
    open(`/device/${ID}/recipients`);
    await screen.findByLabelText('Tên');
    type('Tên', 'Người 5');
    type('Số điện thoại Zalo', '0987654321');
    click('Thêm');
    expect(await t('0987 654 321')).toBeTruthy();
    expect(screen.queryByText(/tối đa 5 người nhận/)).toBeNull();
  });
});

// ───────────────────────────── Gỡ thiết bị ─────────────────────────────

describe('gỡ thiết bị', () => {
  it('bấm xác nhận đúp chỉ gửi một DELETE', async () => {
    open(`/device/${ID}`);
    click(await screen.findByRole('button', { name: 'Gỡ thiết bị' }).then(() => 'Gỡ thiết bị'));
    await t('Gỡ thiết bị này?');
    const buttons = screen.getAllByRole('button', { name: 'Gỡ thiết bị' });
    const confirm = buttons[buttons.length - 1]!;
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(callsTo('DELETE', `/v1/devices/${ID}`)).toHaveLength(1));
  });

  it('server đã gỡ nhưng mất phản hồi, bấm lại nhận 404: vẫn thành công', async () => {
    override = (c) => (c.method === 'DELETE' && c.url === `/v1/devices/${ID}` ? jsonRes({ error: 'not_found' }, 404) : undefined);
    open(`/device/${ID}`);
    click(await screen.findByRole('button', { name: 'Gỡ thiết bị' }).then(() => 'Gỡ thiết bị'));
    await t('Gỡ thiết bị này?');
    const buttons = screen.getAllByRole('button', { name: 'Gỡ thiết bị' });
    fireEvent.click(buttons[buttons.length - 1]!);
    expect(await t('Thiết bị của tôi')).toBeTruthy(); // đã về màn hình chính
    expect(screen.queryByText(/Không tìm thấy thiết bị/)).toBeNull();
    expect(callsTo('DELETE', `/v1/devices/${ID}`)).toHaveLength(1);
  });
});

// ───────────────────────────── Biểu đồ, giao diện ─────────────────────────────

describe('giao diện', () => {
  it('màn hình 320 px: biểu đồ dùng bề rộng thật (viewBox khớp), không co chữ', async () => {
    const orig = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 288 });
    try {
      open(`/device/${ID}`);
      await waitFor(() => expect(document.querySelector('svg.auh-chart')).not.toBeNull());
      expect(document.querySelector('svg.auh-chart')!.getAttribute('viewBox')).toBe('0 0 288 210');
    } finally {
      if (orig) Object.defineProperty(HTMLElement.prototype, 'clientWidth', orig);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    }
  });

  it('biểu đồ có gạch chéo cho vùng mất kết nối (không chỉ dựa vào màu) và tóm tắt bằng chữ', async () => {
    const t0 = serverNow();
    readings = () => ({ server_time: t0, min_c: -40, max_c: -18, points: [{ t: t0 - 20000, avg: -20, min: -21, max: -19 }, { t: t0 - 19700, avg: -20, min: -21, max: -19 }] });
    devices = [makeDevice({ last_seen: t0 - 19700, latest: { ts: t0 - 19700, temp_c: -20 }, phase: 'offline' })];
    open(`/device/${ID}`);
    await waitFor(() => expect(document.querySelector('svg.auh-chart pattern')).not.toBeNull());
    expect(document.querySelector('svg.auh-chart rect.gap')!.getAttribute('fill')).toMatch(/^url\(#.+-hatch\)$/);
    expect(document.querySelector('svg.auh-chart desc')!.textContent).toContain('mất kết nối');
  });

  it('chế độ tối: đặt data-auh-theme="dark" khi Zalo ở chế độ tối', async () => {
    sdk.dark = true;
    open('/');
    await t('Tủ kem');
    expect(document.documentElement.getAttribute('data-auh-theme')).toBe('dark');
  });

  it('huy hiệu trạng thái có ký hiệu + chữ (không chỉ màu)', async () => {
    open('/');
    const badge = (await t('Bình thường')).closest('.auh-badge')!;
    expect(badge.textContent).toContain('✓');
  });
});

describe('ErrorBoundary', () => {
  it('lỗi lập trình bất ngờ: hiện thông báo + nút mở lại, không trắng màn hình', () => {
    const Boom = () => {
      throw new Error('boom');
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Ứng dụng gặp sự cố')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mở lại ứng dụng' })).toBeTruthy();
    errorSpy.mockRestore();
  });
});

describe('tự làm mới trong màn hình (fake timers)', () => {
  it('màn hình chính tải lại mỗi 60 giây và dừng khi rời màn hình', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const { unmount } = open('/');
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(callsTo('GET', '/v1/devices')).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    expect(callsTo('GET', '/v1/devices')).toHaveLength(2);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(callsTo('GET', '/v1/devices')).toHaveLength(2);
  });

  it('chi tiết thiết bị: biểu đồ được làm mới theo chu kỳ (số đo mới hiện ra khi đang xem sự cố)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    open(`/device/${ID}`);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(callsTo('GET', /readings/)).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    expect(callsTo('GET', /readings/)).toHaveLength(2);
  });
});

// ───────────────────────────── Đã biết (ack) / Tạm dừng / Người nhận chính ─────────────────────────────

const alarm = (over: Json = {}) => {
  const t0 = serverNow();
  return makeDevice({ phase: 'temp_alarm', latest: { ts: t0 - 60, temp_c: -12 }, last_seen: t0 - 60, ...over });
};
const ACK = 'Đã biết, đang xử lý';

describe('"Đã biết, đang xử lý" (ack)', () => {
  it('hiện khi phase khác ok và chưa ack; KHÔNG hiện khi phase = ok', async () => {
    devices = [alarm()];
    open(`/device/${ID}`);
    expect(await screen.findByRole('button', { name: ACK })).toBeTruthy();
    cleanup();
    devices = [makeDevice({ phase: 'ok' })];
    open(`/device/${ID}`);
    await t('Bình thường');
    expect(screen.queryByRole('button', { name: ACK })).toBeNull();
  });

  it('phase offline cũng hiện nút', async () => {
    devices = [makeDevice({ phase: 'offline', last_seen: serverNow() - 3 * 3600, latest: { ts: serverNow() - 3 * 3600, temp_c: -19 } })];
    open(`/device/${ID}`);
    expect(await screen.findByRole('button', { name: ACK })).toBeTruthy();
  });

  it('acked_until còn hiệu lực => ẩn nút và hiện "Đã ghi nhận, sẽ nhắc lại sau HH:mm nếu chưa xong"; đã qua => hiện lại nút', async () => {
    devices = [alarm({ acked_until: serverNow() + 3 * 3600 })];
    open(`/device/${ID}`);
    expect(await t(/Đã ghi nhận, sẽ nhắc lại sau \d\d:\d\d( \d\d\/\d\d)? nếu chưa xong\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: ACK })).toBeNull();
    cleanup();
    devices = [alarm({ acked_until: serverNow() - 10 })];
    open(`/device/${ID}`);
    expect(await screen.findByRole('button', { name: ACK })).toBeTruthy();
    expect(screen.queryByText(/Đã ghi nhận/)).toBeNull();
  });

  it('bấm: POST /ack {hours: 4}, rồi hiện lời xác nhận và nút biến mất', async () => {
    devices = [alarm()];
    open(`/device/${ID}`);
    fireEvent.click(await screen.findByRole('button', { name: ACK }));
    await waitFor(() => expect(callsTo('POST', `/v1/devices/${ID}/ack`)).toHaveLength(1));
    expect(callsTo('POST', `/v1/devices/${ID}/ack`)[0]!.body).toEqual({ hours: 4 });
    expect((await screen.findAllByText(/Đã ghi nhận, sẽ nhắc lại sau/)).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByRole('button', { name: ACK })).toBeNull());
  });

  it('bấm đúp chỉ gửi MỘT request', async () => {
    devices = [alarm()];
    open(`/device/${ID}`);
    const btn = await screen.findByRole('button', { name: ACK });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(callsTo('POST', `/v1/devices/${ID}/ack`)).toHaveLength(1));
  });

  it('409 no_active_alert (sự cố vừa hết): thông báo dễ hiểu và màn hình tự tải lại', async () => {
    devices = [alarm()];
    override = (c) => (c.url.endsWith('/ack') ? jsonRes({ error: 'no_active_alert' }, 409) : undefined);
    open(`/device/${ID}`);
    const before = callsTo('GET', '/v1/devices').length;
    fireEvent.click(await screen.findByRole('button', { name: ACK }));
    expect(await t(/không có sự cố nào cần ghi nhận/)).toBeTruthy();
    await waitFor(() => expect(callsTo('GET', '/v1/devices').length).toBeGreaterThan(before));
  });

  it('server cũ (không có acked_until): không hiện nút, không gọi endpoint không tồn tại', async () => {
    const d = alarm();
    delete d.acked_until;
    delete d.paused_until;
    devices = [d];
    open(`/device/${ID}`);
    await t('Đang báo động');
    expect(screen.queryByRole('button', { name: ACK })).toBeNull();
    expect(screen.queryByText('Tạm dừng cảnh báo')).toBeNull(); // cả mục tạm dừng cũng ẩn
  });
});

/** Chọn số ngày tạm dừng (chờ màn hình tải xong). */
async function pickDays(n: number) {
  const group = await screen.findByRole('group', { name: 'Số ngày tạm dừng' });
  fireEvent.click(within(group).getAllByRole('button').find((b) => b.textContent?.startsWith(String(n)))!);
}

describe('tạm dừng cảnh báo', () => {
  it('có các lựa chọn 1 / 3 / 7 / 14 / 30 ngày', async () => {
    open(`/device/${ID}`);
    const group = await screen.findByRole('group', { name: 'Số ngày tạm dừng' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent?.replace('ngày', ''))).toEqual(['1', '3', '7', '14', '30']);
  });

  it('phải qua hộp thoại cảnh báo "bạn sẽ KHÔNG nhận cảnh báo"; huỷ thì không gửi gì', async () => {
    open(`/device/${ID}`);
    await pickDays(7);
    fireEvent.click(screen.getByRole('button', { name: 'Tạm dừng cảnh báo' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('KHÔNG nhận cảnh báo');
    expect(dialog.textContent).toContain('7 ngày');
    expect(callsTo('POST', `/v1/devices/${ID}/pause`)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Không' }));
    await new Promise((r) => setTimeout(r, 30));
    expect(callsTo('POST', `/v1/devices/${ID}/pause`)).toHaveLength(0);
  });

  it('xác nhận: POST /pause {days: 7}; hiện "Đang tạm dừng cảnh báo tới dd/MM", huy hiệu Tạm dừng và nút Bật lại', async () => {
    open(`/device/${ID}`);
    await pickDays(7);
    fireEvent.click(screen.getByRole('button', { name: 'Tạm dừng cảnh báo' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Tạm dừng 7 ngày/ }));
    await waitFor(() => expect(callsTo('POST', `/v1/devices/${ID}/pause`)).toHaveLength(1));
    expect(callsTo('POST', `/v1/devices/${ID}/pause`)[0]!.body).toEqual({ days: 7 });
    expect(await t(/Đang tạm dừng cảnh báo tới \d\d\/\d\d/)).toBeTruthy();
    expect(screen.getAllByText('Tạm dừng cảnh báo').length).toBeGreaterThan(0); // huy hiệu
    expect(screen.getByRole('button', { name: 'Bật lại' })).toBeTruthy();
  });

  it('đang tạm dừng mà thiết bị im lặng (cố ý rút điện): KHÔNG hiện "Mất kết nối", không banner sự cố, không nút Đã biết', async () => {
    const t0 = serverNow();
    devices = [makeDevice({ phase: 'offline', last_seen: t0 - 5 * 3600, latest: { ts: t0 - 5 * 3600, temp_c: -19 }, paused_until: t0 + 3 * 86400 })];
    open(`/device/${ID}`);
    expect(await t(/Đang tạm dừng cảnh báo tới/)).toBeTruthy();
    expect(screen.queryByText('Mất kết nối')).toBeNull();
    expect(screen.queryByText(/Lần cuối nhận số đo lúc/)).toBeNull();
    expect(screen.queryByRole('button', { name: ACK })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tạm dừng cảnh báo' })).toBeNull(); // đang dừng rồi: chỉ có "Bật lại"
  });

  it('"Bật lại": DELETE /pause rồi quay về trạng thái bình thường', async () => {
    devices = [makeDevice({ paused_until: serverNow() + 86400 })];
    open(`/device/${ID}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Bật lại' }));
    await waitFor(() => expect(callsTo('DELETE', `/v1/devices/${ID}/pause`)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(/Đang tạm dừng cảnh báo tới/)).toBeNull());
    expect(await t('Bình thường')).toBeTruthy();
  });

  it('tạm dừng đã hết hạn (paused_until quá khứ): coi như không tạm dừng', async () => {
    devices = [makeDevice({ paused_until: serverNow() - 60 })];
    open(`/device/${ID}`);
    expect(await t('Bình thường')).toBeTruthy();
    expect(screen.queryByText(/Đang tạm dừng/)).toBeNull();
  });

  it('bấm xác nhận đúp chỉ gửi một POST /pause', async () => {
    open(`/device/${ID}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Tạm dừng cảnh báo' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: /Tạm dừng \d+ ngày/ });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(callsTo('POST', `/v1/devices/${ID}/pause`)).toHaveLength(1));
  });

  it('lỗi mạng khi tạm dừng: báo lỗi, không tưởng là đã dừng', async () => {
    override = (c) => {
      if (c.url.endsWith('/pause')) throw new TypeError('Failed to fetch');
      return undefined;
    };
    open(`/device/${ID}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Tạm dừng cảnh báo' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Tạm dừng \d+ ngày/ }));
    expect(await t(/Không kết nối được mạng/)).toBeTruthy();
    expect(screen.queryByText(/Đang tạm dừng cảnh báo tới/)).toBeNull();
  });

  it('màn hình chính: thiết bị tạm dừng hiện huy hiệu "Tạm dừng cảnh báo" + ngày, không phải "Mất kết nối"', async () => {
    const t0 = serverNow();
    devices = [makeDevice({ phase: 'offline', last_seen: t0 - 5 * 3600, latest: { ts: t0 - 5 * 3600, temp_c: -19 }, paused_until: t0 + 86400 })];
    open('/');
    expect(await t('Tạm dừng cảnh báo')).toBeTruthy();
    expect(screen.queryByText('Mất kết nối')).toBeNull();
    expect(screen.getByText(/Đang tạm dừng cảnh báo tới \d\d\/\d\d/)).toBeTruthy();
  });
});

describe('người nhận chính và lịch nhắc', () => {
  it('người đầu tiên có nhãn "Người nhận chính", những người sau thì không; có câu giải thích', async () => {
    recipients = [
      { id: 1, name: 'Chủ quán', phone: '84912345678' },
      { id: 2, name: 'Quản lý', phone: '84987654321' },
    ];
    open(`/device/${ID}/recipients`);
    expect(await t('Người nhận chính')).toBeTruthy();
    expect(screen.getAllByText('Người nhận chính')).toHaveLength(1);
    const first = screen.getByText('Chủ quán').parentElement!;
    const second = screen.getByText('Quản lý').parentElement!;
    expect(first.textContent).toContain('Người nhận chính');
    expect(second.textContent).not.toContain('Người nhận chính');
    expect(screen.getByText('Người đầu tiên trong danh sách nhận cả tin nhắc lại; những người khác chỉ nhận tin báo đầu và tin đã ổn.')).toBeTruthy();
  });

  it('danh sách rỗng: không có nhãn, không có câu giải thích người nhận chính', async () => {
    recipients = [];
    open(`/device/${ID}/recipients`);
    await t(/Chưa có người nhận cảnh báo/);
    expect(screen.queryByText('Người nhận chính')).toBeNull();
    expect(screen.queryByText(/Người đầu tiên trong danh sách/)).toBeNull();
  });

  it('phần trợ giúp nêu lịch nhắc thưa dần và nút "Đã biết"', async () => {
    open(`/device/${ID}`);
    fireEvent.click(await t('Cảnh báo hoạt động thế nào?'));
    const help = screen.getByText(/nhắc lại thưa dần/).closest('li')!;
    expect(help.textContent).toContain('sau 30 phút, rồi cách 2, 4, 8, 12 giờ');
    expect(help.textContent).toContain('sau 2 giờ, rồi cách 6, 12 giờ');
    expect(help.textContent).toContain('người nhận chính');
    expect(help.textContent).toContain('Đã biết, đang xử lý');
  });
});

// ───────────────────────────── Telegram ─────────────────────────────

const TG = 'Nhận thêm qua Telegram (miễn phí)';
const linkedRec = (mode: string, over: Json = {}) => ({ id: 1, name: 'Vợ', phone: '84912345678', mode, telegram_linked: true, ...over });
const unlinkedRec = (over: Json = {}) => ({ id: 1, name: 'Vợ', phone: '84912345678', mode: 'zns', telegram_linked: false, ...over });

describe('Telegram: hiện/ẩn', () => {
  it('telegram_available = false: ẩn mọi giao diện Telegram', async () => {
    telegramAvailable = false;
    recipients = [unlinkedRec()];
    open(`/device/${ID}/recipients`);
    await t('Vợ');
    expect(screen.queryByText(TG)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Kết nối Telegram' })).toBeNull();
    expect(screen.queryByText(/Telegram miễn phí/)).toBeNull();
  });

  it('server cũ (không có telegram_available): ẩn', async () => {
    telegramAvailable = undefined;
    open(`/device/${ID}/recipients`);
    await t('Vợ');
    expect(screen.queryByText(TG)).toBeNull();
  });

  it('có Telegram: hiện dòng cho MỖI người nhận + trợ giúp về lợi ích và người nhận chính', async () => {
    telegramAvailable = true;
    recipients = [unlinkedRec(), unlinkedRec({ id: 2, name: 'Quản lý', phone: '84987654321' })];
    open(`/device/${ID}/recipients`);
    await t('Quản lý');
    expect(screen.getAllByText(TG)).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Kết nối Telegram' })).toHaveLength(2);
    expect(screen.getByText(/Telegram miễn phí và là kênh dự phòng/)).toBeTruthy();
    expect(screen.getByText(/chỉ người nhận chính nhận tin nhắc lại qua Zalo/)).toBeTruthy();
  });
});

describe('Telegram: chưa kết nối', () => {
  beforeEach(() => {
    telegramAvailable = true;
    recipients = [unlinkedRec()];
  });

  it('bấm "Kết nối Telegram": POST telegram-link, hiện liên kết + ghi chú một lần/24 giờ + hướng dẫn; KHÔNG tự mở trên máy chủ quán', async () => {
    open(`/device/${ID}/recipients`);
    fireEvent.click(await screen.findByRole('button', { name: 'Kết nối Telegram' }));
    await waitFor(() => expect(callsTo('POST', `/v1/devices/${ID}/recipients/1/telegram-link`)).toHaveLength(1));
    expect((await screen.findByTestId('telegram-link')).textContent).toBe(TG_URL);
    expect(screen.getByText(/Liên kết chỉ dùng được một lần và có hiệu lực 24 giờ\./)).toBeTruthy();
    expect(screen.getByText(/phải được mở trên điện thoại của/)).toBeTruthy();
    expect(screen.getByText('Mở Telegram, bấm Start. Sau đó quay lại đây và làm mới.')).toBeTruthy();
    expect(sdk.openTelegramLink).not.toHaveBeenCalled(); // mở trên máy chủ quán sẽ nhầm người và tiêu hao liên kết dùng một lần
  });

  it('"Mở Telegram trên máy này" gọi hàm mở ngoài của SDK với đúng URL', async () => {
    open(`/device/${ID}/recipients`);
    fireEvent.click(await screen.findByRole('button', { name: 'Kết nối Telegram' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mở Telegram trên máy này' }));
    await waitFor(() => expect(sdk.openTelegramLink).toHaveBeenCalledWith(TG_URL));
    expect(await t(/Đã mở Telegram/)).toBeTruthy();
  });

  it('không mở được: hướng dẫn sao chép liên kết', async () => {
    sdk.openTelegramLink.mockResolvedValue(false);
    open(`/device/${ID}/recipients`);
    fireEvent.click(await screen.findByRole('button', { name: 'Kết nối Telegram' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mở Telegram trên máy này' }));
    expect(await t(/Không mở được Telegram tự động/)).toBeTruthy();
    expect(screen.getByTestId('telegram-link').textContent).toBe(TG_URL); // vẫn thấy liên kết để làm tay
  });

  it('"Sao chép liên kết" và "Chia sẻ liên kết"', async () => {
    open(`/device/${ID}/recipients`);
    fireEvent.click(await screen.findByRole('button', { name: 'Kết nối Telegram' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sao chép liên kết' }));
    await waitFor(() => expect(sdk.copyText).toHaveBeenCalledWith(TG_URL));
    expect(await t('Đã sao chép liên kết.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Chia sẻ liên kết' }));
    await waitFor(() => expect(sdk.shareText).toHaveBeenCalledTimes(1));
    const shared = sdk.shareText.mock.calls[0]![0];
    expect(shared).toContain(TG_URL);
    expect(shared).toContain('Vợ');
    expect(shared).toContain('24 giờ');
  });

  it('không có bảng chia sẻ: sao chép lời nhắn thay thế', async () => {
    sdk.shareText.mockResolvedValue(false);
    open(`/device/${ID}/recipients`);
    fireEvent.click(await screen.findByRole('button', { name: 'Kết nối Telegram' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Chia sẻ liên kết' }));
    await waitFor(() => expect(sdk.copyText).toHaveBeenCalled());
    expect(sdk.copyText.mock.calls[0]![0]).toContain(TG_URL);
    expect(await t(/Đã sao chép lời nhắn/)).toBeTruthy();
  });

  it('bấm "Kết nối Telegram" đúp chỉ tạo MỘT liên kết', async () => {
    open(`/device/${ID}/recipients`);
    const btn = await screen.findByRole('button', { name: 'Kết nối Telegram' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    await screen.findByTestId('telegram-link');
    expect(callsTo('POST', /telegram-link$/)).toHaveLength(1);
  });

  it('503 telegram_not_configured: thông báo dễ hiểu, không có bảng liên kết', async () => {
    override = (c) => (c.url.endsWith('/telegram-link') ? jsonRes({ error: 'telegram_not_configured' }, 503) : undefined);
    open(`/device/${ID}/recipients`);
    fireEvent.click(await screen.findByRole('button', { name: 'Kết nối Telegram' }));
    expect(await t(/Kênh Telegram chưa được bật/)).toBeTruthy();
    expect(screen.queryByTestId('telegram-link')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cho phép' })).toBeNull(); // không phải lỗi token
  });

  it('server trả URL KHÔNG phải t.me: bị từ chối (bad_response), không hiện, không mở', async () => {
    override = (c) => (c.url.endsWith('/telegram-link') ? jsonRes({ url: 'https://evil.example/?start=abc', expires_at: serverNow() + 86400 }) : undefined);
    open(`/device/${ID}/recipients`);
    fireEvent.click(await screen.findByRole('button', { name: 'Kết nối Telegram' }));
    expect(await t(/Nhận được dữ liệu lạ/)).toBeTruthy();
    expect(screen.queryByTestId('telegram-link')).toBeNull();
    expect(sdk.openTelegramLink).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('evil.example');
  });

  it('quay lại app (visibilitychange) khi đang có liên kết chờ: tự tải lại và thấy "Đã kết nối Telegram"', async () => {
    open(`/device/${ID}/recipients`);
    fireEvent.click(await screen.findByRole('button', { name: 'Kết nối Telegram' }));
    await screen.findByTestId('telegram-link');
    recipients = [linkedRec('both')]; // người nhận đã bấm Start
    document.dispatchEvent(new Event('visibilitychange'));
    expect(await t('Đã kết nối Telegram')).toBeTruthy();
    expect(screen.queryByTestId('telegram-link')).toBeNull(); // bảng liên kết tự đóng
  });

  it('nút Làm mới trong bảng liên kết tải lại danh sách', async () => {
    open(`/device/${ID}/recipients`);
    fireEvent.click(await screen.findByRole('button', { name: 'Kết nối Telegram' }));
    await screen.findByTestId('telegram-link');
    const before = callsTo('GET', `/v1/devices/${ID}/recipients`).length;
    fireEvent.click(screen.getByRole('button', { name: 'Làm mới' }));
    await waitFor(() => expect(callsTo('GET', `/v1/devices/${ID}/recipients`).length).toBeGreaterThan(before));
  });
});

describe('Telegram: đã kết nối', () => {
  beforeEach(() => {
    telegramAvailable = true;
  });
  const pressed = () => screen.getAllByRole('button', { pressed: true }).map((b) => b.textContent);

  it.each([
    ['both', 'Zalo + Telegram'],
    ['telegram', 'Chỉ Telegram'],
    ['zns', 'Chỉ Zalo'],
  ])('mode %s: huy hiệu "Đã kết nối Telegram" và lựa chọn "%s" được chọn', async (mode, label) => {
    recipients = [linkedRec(mode)];
    open(`/device/${ID}/recipients`);
    expect(await t('Đã kết nối Telegram')).toBeTruthy();
    const group = screen.getByRole('group', { name: /Kênh nhận tin của Vợ/ });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['Zalo + Telegram', 'Chỉ Telegram', 'Chỉ Zalo']);
    expect(pressed()).toEqual([label]);
    expect(screen.getByRole('button', { name: 'Ngắt kết nối' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Kết nối Telegram' })).toBeNull();
  });

  it('chọn "Chỉ Zalo" và "Zalo + Telegram": PATCH {mode} ngay, không hỏi', async () => {
    recipients = [linkedRec('telegram')];
    open(`/device/${ID}/recipients`);
    fireEvent.click(await screen.findByRole('button', { name: 'Chỉ Zalo' }));
    await waitFor(() => expect(callsTo('PATCH', `/v1/devices/${ID}/recipients/1`)).toHaveLength(1));
    expect(callsTo('PATCH', `/v1/devices/${ID}/recipients/1`)[0]!.body).toEqual({ mode: 'zns' });
    await waitFor(() => expect(pressed()).toEqual(['Chỉ Zalo']));
    fireEvent.click(screen.getByRole('button', { name: 'Zalo + Telegram' }));
    await waitFor(() => expect(callsTo('PATCH', `/v1/devices/${ID}/recipients/1`)).toHaveLength(2));
    expect(callsTo('PATCH', `/v1/devices/${ID}/recipients/1`)[1]!.body).toEqual({ mode: 'both' });
  });

  it('chọn "Chỉ Telegram": cảnh báo bắt buộc, chỉ gửi khi xác nhận', async () => {
    recipients = [linkedRec('both')];
    open(`/device/${ID}/recipients`);
    fireEvent.click(await screen.findByRole('button', { name: 'Chỉ Telegram' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Người này sẽ không nhận tin Zalo. Nếu tắt Telegram hoặc chặn bot, họ sẽ không nhận được gì.');
    expect(callsTo('PATCH', `/v1/devices/${ID}/recipients/1`)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Không' }));
    await new Promise((r) => setTimeout(r, 30));
    expect(callsTo('PATCH', `/v1/devices/${ID}/recipients/1`)).toHaveLength(0);
    fireEvent.click(within(screen.getByRole('group', { name: /Kênh nhận tin của Vợ/ })).getByRole('button', { name: 'Chỉ Telegram' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Chỉ Telegram' }));
    await waitFor(() => expect(callsTo('PATCH', `/v1/devices/${ID}/recipients/1`)).toHaveLength(1));
    expect(callsTo('PATCH', `/v1/devices/${ID}/recipients/1`)[0]!.body).toEqual({ mode: 'telegram' });
  });

  it('bấm lại lựa chọn đang chọn: không gửi gì', async () => {
    recipients = [linkedRec('both')];
    open(`/device/${ID}/recipients`);
    fireEvent.click(await screen.findByRole('button', { name: 'Zalo + Telegram' }));
    await new Promise((r) => setTimeout(r, 30));
    expect(callsTo('PATCH', `/v1/devices/${ID}/recipients/1`)).toHaveLength(0);
  });

  it('409 telegram_not_linked (người nhận vừa /stop): thông báo và tự tải lại trạng thái', async () => {
    recipients = [linkedRec('both')];
    override = (c) => {
      if (c.method === 'PATCH') {
        recipients = [unlinkedRec()]; // trong lúc đó họ đã ngắt kết nối
        return jsonRes({ error: 'telegram_not_linked' }, 409);
      }
      return undefined;
    };
    open(`/device/${ID}/recipients`);
    fireEvent.click(await screen.findByRole('button', { name: 'Chỉ Zalo' }));
    expect(await t(/chưa kết nối Telegram/)).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Kết nối Telegram' })).toBeTruthy(); // trạng thái đã cập nhật
  });

  it('"Ngắt kết nối": phải xác nhận; xác nhận thì DELETE .../telegram và về trạng thái chưa kết nối', async () => {
    recipients = [linkedRec('both')];
    open(`/device/${ID}/recipients`);
    fireEvent.click(await screen.findByRole('button', { name: 'Ngắt kết nối' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('chỉ nhận tin qua Zalo');
    expect(callsTo('DELETE', /telegram$/)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ngắt kết nối' }));
    await waitFor(() => expect(callsTo('DELETE', `/v1/devices/${ID}/recipients/1/telegram`)).toHaveLength(1));
    expect(await screen.findByRole('button', { name: 'Kết nối Telegram' })).toBeTruthy();
  });

  it('bấm xác nhận ngắt kết nối đúp chỉ gửi MỘT DELETE', async () => {
    recipients = [linkedRec('both')];
    open(`/device/${ID}/recipients`);
    fireEvent.click(await screen.findByRole('button', { name: 'Ngắt kết nối' }));
    const confirm = within(await screen.findByRole('dialog')).getByRole('button', { name: 'Ngắt kết nối' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(callsTo('DELETE', /telegram$/)).toHaveLength(1));
  });

  it('đổi kênh bấm đúp nhanh chỉ gửi MỘT PATCH', async () => {
    recipients = [linkedRec('both')];
    open(`/device/${ID}/recipients`);
    const btn = await screen.findByRole('button', { name: 'Chỉ Zalo' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(callsTo('PATCH', `/v1/devices/${ID}/recipients/1`)).toHaveLength(1));
  });
});

// ───────────────────────────── Lỗi cảm biến (sensor_fault) ─────────────────────────────

const sensorFault = (over: Json = {}) => {
  const t0 = serverNow();
  return makeDevice({ phase: 'sensor_fault', last_seen: t0 - 60, last_reading_at: t0 - 40 * 60, latest: { ts: t0 - 40 * 60, temp_c: -19 }, ...over });
};

describe('lỗi cảm biến', () => {
  it('huy hiệu riêng "Lỗi cảm biến" + câu giải thích + nguyên nhân + việc cần làm + giờ số đo hợp lệ cuối (giờ server)', async () => {
    skew = -3600; // điện thoại chạy nhanh 1 giờ: vẫn phải ra "40 phút trước"
    devices = [sensorFault()];
    open(`/device/${ID}`);
    expect((await t('Lỗi cảm biến')).closest('.auh-badge')!.textContent).toContain('\u26a0'); // có ký hiệu, không chỉ màu
    expect(await t(/Lỗi cảm biến — thiết bị vẫn kết nối nhưng không đọc được nhiệt độ\./)).toBeTruthy();
    const banner = screen.getByText(/Lỗi cảm biến — thiết bị vẫn kết nối/).closest('[role="alert"]')!;
    expect(banner.textContent).toContain('dây đầu dò bị đứt, rút ra hoặc kẹt ở gioăng cửa tủ');
    expect(banner.textContent).toContain('đầu cắm');
    expect(banner.textContent).toContain('đừng chỉ chờ');
    expect(banner.textContent).toMatch(/Số đo hợp lệ cuối lúc \d\d:\d\d \d\d\/\d\d \(40 phút trước\)/);
    expect(screen.queryByText('Mất kết nối')).toBeNull();
  });

  it('nút "Đã biết, đang xử lý" hiện cho sensor_fault và gọi POST /ack', async () => {
    devices = [sensorFault()];
    open(`/device/${ID}`);
    fireEvent.click(await screen.findByRole('button', { name: ACK }));
    await waitFor(() => expect(callsTo('POST', `/v1/devices/${ID}/ack`)).toHaveLength(1));
  });

  it('tạm dừng đè lên lỗi cảm biến', async () => {
    devices = [sensorFault({ paused_until: serverNow() + 86400 })];
    open(`/device/${ID}`);
    expect(await t(/Đang tạm dừng cảnh báo tới/)).toBeTruthy();
    expect(screen.queryByText(/Lỗi cảm biến — thiết bị vẫn kết nối/)).toBeNull();
    expect(screen.queryByRole('button', { name: ACK })).toBeNull();
  });

  it('mất liên lạc (last_seen quá 15 phút) thì là "Mất kết nối", không phải lỗi cảm biến', async () => {
    devices = [sensorFault({ last_seen: serverNow() - 3600 })];
    open(`/device/${ID}`);
    expect(await t('Mất kết nối')).toBeTruthy();
    expect(screen.queryByText(/Lỗi cảm biến — thiết bị vẫn kết nối/)).toBeNull();
  });

  it('phase LẠ của server mới: hiện "Cần kiểm tra", không lỗi, không ẩn thiết bị (màn hình chính và chi tiết)', async () => {
    devices = [makeDevice({ phase: 'quantum_flux' })];
    open('/');
    expect(await t('Cần kiểm tra')).toBeTruthy();
    expect(screen.getByText('Tủ kem')).toBeTruthy();
    cleanup();
    open(`/device/${ID}`);
    expect(await t(/Thiết bị đang ở một trạng thái mà ứng dụng chưa hiểu/)).toBeTruthy();
    expect(screen.getByRole('button', { name: ACK })).toBeTruthy(); // phase khác ok => vẫn cho "Đã biết"
  });

  it('màn hình chính: lỗi cảm biến và báo động lên đầu, bình thường và tạm dừng xuống cuối', async () => {
    const t0 = serverNow();
    const base = (id: string, name: string, over: Json) => makeDevice({ id, name, ...over });
    devices = [
      base('AUH-000002', 'Tủ B (bình thường)', {}),
      base('AUH-000003', 'Tủ C (tạm dừng)', { paused_until: t0 + 86400 }),
      base('AUH-000004', 'Tủ D (cảm biến)', { phase: 'sensor_fault', last_reading_at: t0 - 2400 }),
      base('AUH-000005', 'Tủ E (báo động)', { phase: 'temp_alarm', latest: { ts: t0 - 60, temp_c: -10 } }),
      base('AUH-000006', 'Tủ F (mất kết nối)', { phase: 'offline', last_seen: t0 - 7200, latest: { ts: t0 - 7200, temp_c: -19 } }),
    ];
    open('/');
    await t('Tủ B (bình thường)');
    const names = Array.from(document.querySelectorAll('.auh-device .auh-name')).map((e) => e.textContent);
    expect(names).toEqual(['Tủ D (cảm biến)', 'Tủ E (báo động)', 'Tủ F (mất kết nối)', 'Tủ B (bình thường)', 'Tủ C (tạm dừng)']);
    expect(screen.getByText(/Không đọc được nhiệt độ — kiểm tra dây đầu dò/)).toBeTruthy();
  });

  it('báo động: dùng alarm_since của server khi có (thay vì suy từ biểu đồ)', async () => {
    const t0 = serverNow();
    devices = [makeDevice({ phase: 'temp_alarm', latest: { ts: t0 - 60, temp_c: -12 }, alarm_since: t0 - 3 * 3600 })];
    open(`/device/${ID}`);
    expect(await t(new RegExp(`từ khoảng ${formatVnTime(t0 - 3 * 3600)}\\.`))).toBeTruthy();
  });

  it('trợ giúp nêu loại cảnh báo lỗi cảm biến: 15 phút, vẫn kết nối, nhắc sau 2 giờ rồi 6, 12 giờ, khác mất kết nối', async () => {
    open(`/device/${ID}`);
    fireEvent.click(await t('Cảnh báo hoạt động thế nào?'));
    const li = screen.getByText('Lỗi cảm biến:').closest('li')!;
    expect(li.textContent).toContain('VẪN kết nối');
    expect(li.textContent).toContain('15 phút');
    expect(li.textContent).toContain('Khác với "mất kết nối"');
    expect(li.textContent).toContain('Nhắc lại sau 2 giờ, rồi cách 6, 12 giờ');
  });
});

describe('Thông tin kỹ thuật (diag)', () => {
  it('gập lại; có sóng Wi-Fi (Tốt/Trung bình/Yếu + dBm), lý do khởi động lại tiếng Việt, thời gian chạy, phần mềm; kèm gợi ý', async () => {
    devices = [makeDevice({ firmware: '1.0.2', diag_at: serverNow() - 60, diag: { sensor: 'ok', rssi: -82, rst: 'brownout', up: 2 * 86400 + 3600, heap: 80000 } })];
    open(`/device/${ID}`);
    const summary = await t('Thông tin kỹ thuật');
    const details = summary.closest('details')!;
    expect(details.hasAttribute('open')).toBe(false);
    for (const [label, value] of [['Sóng Wi-Fi', 'Yếu (-82 dBm)'], ['Lần khởi động lại gần nhất do', 'Điện yếu/sụt áp'], ['Đã chạy liên tục', '2 ngày 1 giờ'], ['Phiên bản phần mềm', '1.0.2']]) {
      const dt = within(details).getByText(label);
      expect(dt.nextElementSibling!.textContent).toContain(value);
    }
    expect(details.textContent).toContain('củ sạc USB khác');
    expect(details.textContent).toContain('bộ kích sóng Wi-Fi');
  });

  it('thiếu diag và firmware (server cũ): không hiện mục này', async () => {
    devices = [makeDevice({ firmware: null, diag: null })];
    open(`/device/${ID}`);
    await t('Bình thường');
    expect(screen.queryByText('Thông tin kỹ thuật')).toBeNull();
  });

  it('sóng tốt và cắm điện: không có gợi ý sạc/kích sóng', async () => {
    devices = [makeDevice({ diag: { rssi: -50, rst: 'poweron' } })];
    open(`/device/${ID}`);
    const details = (await t('Thông tin kỹ thuật')).closest('details')!;
    expect(details.textContent).toContain('Tốt (-50 dBm)');
    expect(details.textContent).toContain('Cắm điện');
    expect(details.textContent).not.toContain('củ sạc');
    expect(details.textContent).not.toContain('kích sóng');
  });
});

// ───────────────────────────── Wi-Fi cài đặt thiết bị ─────────────────────────────

describe('Thông tin Wi-Fi cài đặt thiết bị', () => {
  it('chỉ tải khi mở màn hình: trang chi tiết không gọi /setup; bấm nút mới gọi', async () => {
    open(`/device/${ID}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Thông tin Wi-Fi cài đặt thiết bị' }));
    await t('Tên Wi-Fi của thiết bị');
    expect(callsTo('GET', `/v1/devices/${ID}/setup`)).toHaveLength(1);
  });

  it('không mở màn hình thì không có request /setup nào', async () => {
    open(`/device/${ID}`);
    await t('Bình thường');
    expect(calls.some((c) => c.url.endsWith('/setup'))).toBe(false);
  });

  it('hiện SSID và mật khẩu ký tự lớn tách rời, nút chép từng cái, lời nhắc bảo mật, các bước cài đặt', async () => {
    open(`/device/${ID}/setup`);
    const ssid = await screen.findByRole('img', { name: /Tên Wi-Fi: A u h o n o - 0 0 0 1/ });
    expect(ssid.querySelectorAll('.auh-cred-char')).toHaveLength('Auhono-0001'.length);
    const pw = screen.getByRole('img', { name: /Mật khẩu: X P 1 C Z H P 3 Z 0/ });
    expect(Array.from(pw.querySelectorAll('.auh-cred-char')).map((e) => e.textContent).join('')).toBe('XP1CZHP3Z0');
    fireEvent.click(screen.getByRole('button', { name: 'Sao chép mật khẩu' }));
    await waitFor(() => expect(sdk.copyText).toHaveBeenCalledWith('XP1CZHP3Z0'));
    expect(await t('Đã sao chép mật khẩu.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sao chép tên Wi-Fi' }));
    await waitFor(() => expect(sdk.copyText).toHaveBeenCalledWith('Auhono-0001'));
    expect(screen.getByText('Chỉ chia sẻ mật khẩu này với người cần cài đặt thiết bị.')).toBeTruthy();
    const steps = screen.getByText('Cách cài đặt Wi-Fi cho thiết bị').closest('section')!.textContent!;
    for (const part of ['5 giây', '20 phút', '192.168.4.1', '2.4 GHz', 'nhập mật khẩu ở trên']) expect(steps).toContain(part);
  });

  it('KHÔNG vẽ mã QR: không svg/canvas/img; chuỗi WIFI: chỉ nằm trong mục "Nâng cao" gập lại', async () => {
    open(`/device/${ID}/setup`);
    await t('Tên Wi-Fi của thiết bị');
    expect(document.querySelector('canvas, img, svg.auh-chart, svg')).toBeNull();
    const details = screen.getByText('Nâng cao').closest('details')!;
    expect(details.hasAttribute('open')).toBe(false);
    expect(within(details).getByText(SETUP.wifi_qr)).toBeTruthy();
    expect(document.body.textContent!.split(SETUP.wifi_qr).length - 1).toBe(1); // xuất hiện đúng một lần
  });

  it('thiết bị chưa có dữ liệu: bước cài đặt có nút dẫn tới màn hình này', async () => {
    devices = [makeDevice({ latest: null, last_seen: null })];
    open(`/device/${ID}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Xem tên và mật khẩu Wi-Fi của thiết bị' }));
    expect(await t('Tên Wi-Fi của thiết bị')).toBeTruthy();
  });

  it('404 (không phải chủ / chưa kích hoạt): báo không tìm thấy, không hiện gì nhạy cảm', async () => {
    override = (c) => (c.url.endsWith('/setup') ? jsonRes({ error: 'not_found' }, 404) : undefined);
    open(`/device/${ID}/setup`);
    expect(await t(/Không tìm thấy thiết bị/)).toBeTruthy();
    expect(screen.queryByText('Mật khẩu')).toBeNull();
  });

  it('BẢO MẬT: rời màn hình thì mật khẩu biến khỏi bộ nhớ trang; không lưu storage, không log, không vào URL/history', async () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    try {
      window.localStorage.clear();
      window.sessionStorage.clear();
      const view = open(`/device/${ID}/setup`);
      await screen.findByRole('img', { name: /Mật khẩu/ });
      // đang xem: có trên màn hình, nhưng không ở bất kỳ nơi nào khác
      expect(window.location.href).not.toContain(SETUP.ap_password);
      expect(JSON.stringify(window.history.state)).not.toContain(SETUP.ap_password);
      view.unmount();
      expect(document.body.innerHTML).not.toContain(SETUP.ap_password);
      expect(document.body.textContent).not.toContain('XP1CZHP3Z0');
      expect(document.body.innerHTML).not.toContain('P1CZ'); // cả dạng tách ký tự
      expect(setItem).not.toHaveBeenCalled();
      expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
      expect(window.location.href).not.toContain(SETUP.ap_password);
      expect(JSON.stringify(window.history.state)).not.toContain(SETUP.ap_password);
      for (const spy of logs) expect(spy).not.toHaveBeenCalled();
    } finally {
      logs.forEach((s) => s.mockRestore());
      setItem.mockRestore();
    }
  });

  it('mở lại màn hình thì tải lại (không dùng bản cũ đã giữ lại)', async () => {
    const first = open(`/device/${ID}/setup`);
    await screen.findByRole('img', { name: /Mật khẩu/ });
    first.unmount();
    open(`/device/${ID}/setup`);
    await screen.findByRole('img', { name: /Mật khẩu/ });
    expect(callsTo('GET', `/v1/devices/${ID}/setup`)).toHaveLength(2);
  });
});
