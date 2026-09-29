// Lớp mỏng bọc zmp-sdk: gom mọi chỗ gọi vào Zalo ở một nơi để dễ đổi/mô phỏng.
// Lưu ý: các API này chỉ chạy thật trong ứng dụng Zalo; trên trình duyệt (zmp start) một số trả rỗng.

import {
  authorize,
  checkZaloCameraPermission,
  getAccessToken,
  getSystemInfo,
  openOutApp,
  openPermissionSetting,
  openShareSheet,
  requestCameraPermission,
  scanQRCode,
} from 'zmp-sdk';
import { AppError } from './lib/errors.ts';
import { isTelegramUrl } from './lib/telegram.ts';

/**
 * Zalo access token của người dùng hiện tại. Chuỗi rỗng nếu chưa có (vd. chạy trên trình duyệt).
 * Được gọi MỚI cho từng request (api-client), không giữ lại ở đâu cả: token không bao giờ được lưu hay ghi log.
 */
export async function getToken(): Promise<string> {
  return (await getAccessToken()) || '';
}

/**
 * Xin quyền dùng tài khoản Zalo (hộp thoại của Zalo). Ném AppError('auth_required') nếu người dùng từ chối
 * hoặc Zalo bản cũ không hỗ trợ. Sau khi thành công, gọi lại request là lấy được token.
 * Kết quả của `authorize` KHÔNG quyết định: từ SDK 2.35 token lấy được không cần hộp thoại, còn nếu người dùng
 * đã bật quyền trong Cài đặt thì `authorize` có thể báo lỗi dù token đã có. Chỉ việc có token hay không mới đúng/sai.
 */
export async function requestAccess(): Promise<void> {
  try {
    await authorize({});
  } catch {
    /* xem chú thích ở trên */
  }
  let token = '';
  try {
    token = await getToken();
  } catch {
    token = '';
  }
  if (!token) throw new AppError('auth_required');
}

/** Mở màn hình cài đặt quyền của Mini App (khi người dùng đã từ chối trước đó nên hộp thoại không hiện lại). */
export async function openPermissions(): Promise<void> {
  try {
    await openPermissionSetting();
  } catch {
    /* không mở được thì thôi: người dùng vẫn có thể vào Cài đặt của Zalo thủ công */
  }
}

export type ScanResult =
  | { status: 'ok'; content: string }
  /** Người dùng đóng camera hoặc không quét được. */
  | { status: 'cancelled' }
  /** Mini App chưa được phép dùng camera. */
  | { status: 'camera_denied' };

/**
 * Mở camera quét QR. Chỉ lấy NỘI DUNG chữ; SDK không tự mở đường dẫn ở chế độ này.
 * Khi quét thất bại, kiểm tra riêng quyền camera để phân biệt "từ chối quyền" với "đóng camera giữa chừng".
 */
export async function scanQr(): Promise<ScanResult> {
  try {
    const { content } = await scanQRCode();
    return typeof content === 'string' ? { status: 'ok', content } : { status: 'cancelled' };
  } catch {
    try {
      const permission = await checkZaloCameraPermission();
      if (permission && permission.userAllow === false) return { status: 'camera_denied' };
    } catch {
      /* không kiểm tra được thì coi như người dùng tự đóng */
    }
    return { status: 'cancelled' };
  }
}

/** Xin quyền camera (hộp thoại của Zalo). true nếu được phép. */
export async function askCameraPermission(): Promise<boolean> {
  try {
    const r = await requestCameraPermission();
    return r?.userAllow === true;
  } catch {
    return false;
  }
}

/** Zalo đang ở chế độ tối? (SDK >= 2.17.3). Lỗi/không hỗ trợ => false. */
export function isZaloDarkTheme(): boolean {
  try {
    return getSystemInfo().zaloTheme === 'dark';
  } catch {
    return false;
  }
}

/**
 * Mở liên kết Telegram ở ứng dụng NGOÀI (Telegram/trình duyệt) bằng `openOutApp` của SDK — không bao giờ điều hướng webview
 * của Mini App tới URL bên ngoài. CHỈ mở khi đúng https://t.me/<bot>?start=<mã>; URL lạ trả false mà không gọi SDK.
 * Trả false nếu không mở được (Zalo bản cũ, bị chặn...): giao diện sẽ hiện liên kết + nút sao chép để làm tay.
 */
export async function openTelegramLink(url: string): Promise<boolean> {
  if (!isTelegramUrl(url)) return false;
  try {
    await openOutApp({ url });
    return true;
  } catch {
    return false;
  }
}

/** Mở bảng chia sẻ của Zalo với một đoạn chữ (đã chứa liên kết). false nếu không chia sẻ được/người dùng huỷ. */
export async function shareText(text: string): Promise<boolean> {
  try {
    await openShareSheet({ type: 'text', data: { text } });
    return true;
  } catch {
    return false;
  }
}

/** Sao chép vào bộ nhớ tạm: Clipboard API, hoặc cách cũ bằng ô nhập ẩn. false nếu cả hai đều không được. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* thử cách cũ */
  }
  try {
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(box);
    box.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(box);
    return ok;
  } catch {
    return false;
  }
}
