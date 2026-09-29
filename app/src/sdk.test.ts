// @vitest-environment jsdom
// Lớp bọc SDK cho Telegram: chỉ mở URL t.me, chia sẻ dạng chữ, sao chép có phương án dự phòng. zmp-sdk được giả lập.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  openOutApp: vi.fn(async (_a: { url: string }) => undefined),
  openShareSheet: vi.fn(async (_a: unknown) => ({})),
}));
vi.mock('zmp-sdk', () => ({
  authorize: vi.fn(),
  checkZaloCameraPermission: vi.fn(),
  getAccessToken: vi.fn(),
  getSystemInfo: vi.fn(),
  openOutApp: (a: { url: string }) => sdk.openOutApp(a),
  openPermissionSetting: vi.fn(),
  openShareSheet: (a: unknown) => sdk.openShareSheet(a),
  requestCameraPermission: vi.fn(),
  scanQRCode: vi.fn(),
}));

import { copyText, openTelegramLink, shareText } from './sdk.ts';

const OK = 'https://t.me/AuhonoBot?start=abc_DEF-1';

beforeEach(() => {
  sdk.openOutApp.mockReset().mockResolvedValue(undefined);
  sdk.openShareSheet.mockReset().mockResolvedValue({});
});
afterEach(() => vi.restoreAllMocks());

describe('openTelegramLink', () => {
  it('URL t.me hợp lệ: gọi openOutApp đúng URL đó và trả true', async () => {
    expect(await openTelegramLink(OK)).toBe(true);
    expect(sdk.openOutApp).toHaveBeenCalledTimes(1);
    expect(sdk.openOutApp).toHaveBeenCalledWith({ url: OK });
  });
  it.each(['https://evil.example/?start=abc', 'http://t.me/AuhonoBot?start=abc', 'javascript:alert(1)', 'tg://resolve?domain=x', '', 'https://t.me.evil.example/AuhonoBot?start=abc'])(
    'URL không phải t.me (%s): KHÔNG gọi SDK, trả false',
    async (url) => {
      expect(await openTelegramLink(url)).toBe(false);
      expect(sdk.openOutApp).not.toHaveBeenCalled();
    },
  );
  it('SDK báo lỗi (Zalo cũ, bị chặn): trả false chứ không ném', async () => {
    sdk.openOutApp.mockRejectedValueOnce(new Error('not supported'));
    expect(await openTelegramLink(OK)).toBe(false);
  });
  it('không điều hướng webview của Mini App', async () => {
    const before = window.location.href;
    await openTelegramLink(OK);
    expect(window.location.href).toBe(before);
  });
});

describe('shareText', () => {
  it('mở bảng chia sẻ dạng chữ', async () => {
    expect(await shareText('xin chào ' + OK)).toBe(true);
    expect(sdk.openShareSheet).toHaveBeenCalledWith({ type: 'text', data: { text: 'xin chào ' + OK } });
  });
  it('lỗi/huỷ => false', async () => {
    sdk.openShareSheet.mockRejectedValueOnce(new Error('cancel'));
    expect(await shareText('x')).toBe(false);
  });
});

describe('copyText', () => {
  it('dùng Clipboard API khi có', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    expect(await copyText(OK)).toBe(true);
    expect(writeText).toHaveBeenCalledWith(OK);
    vi.unstubAllGlobals();
  });
  it('Clipboard API lỗi => thử cách cũ (execCommand)', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error('denied'); }) } });
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    expect(await copyText(OK)).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull(); // ô ẩn đã được dọn
    vi.unstubAllGlobals();
  });
  it('cả hai đều thất bại => false', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    (document as unknown as { execCommand: unknown }).execCommand = () => {
      throw new Error('no');
    };
    expect(await copyText(OK)).toBe(false);
    vi.unstubAllGlobals();
  });
});
