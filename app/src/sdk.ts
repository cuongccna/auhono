// Lớp mỏng bọc zmp-sdk: gom mọi chỗ gọi vào Zalo ở một nơi để dễ đổi/mô phỏng.
// Lưu ý: các API này chỉ chạy thật trong ứng dụng Zalo; trên trình duyệt (zmp start) một số trả rỗng.

import {
  authorize,
  checkZaloCameraPermission,
  getAccessToken,
  getSystemInfo,
  openPermissionSetting,
  requestCameraPermission,
  scanQRCode,
} from 'zmp-sdk';
import { AppError } from './lib/errors.ts';

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
 */
export async function requestAccess(): Promise<void> {
  try {
    await authorize({});
  } catch {
    throw new AppError('auth_required');
  }
  if (!(await getToken())) throw new AppError('auth_required');
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
