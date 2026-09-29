// Lớp mỏng bọc zmp-sdk: gom mọi chỗ gọi vào Zalo ở một nơi để dễ đổi/mô phỏng.
// Lưu ý: các API này chỉ chạy thật trong ứng dụng Zalo; trên trình duyệt (zmp start) một số trả rỗng.

import { authorize, getAccessToken, openPermissionSetting, scanQRCode } from 'zmp-sdk';
import { AppError } from './lib/errors.ts';

/** Zalo access token của người dùng hiện tại. Chuỗi rỗng nếu chưa có (vd. chạy trên trình duyệt). */
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

/**
 * Mở camera quét QR. Chỉ lấy NỘI DUNG chữ; SDK được yêu cầu KHÔNG tự mở đường dẫn (skipOpenLink).
 * Trả null nếu người dùng đóng camera hoặc không quét được.
 */
export async function scanQr(): Promise<string | null> {
  try {
    const { content } = await scanQRCode();
    return typeof content === 'string' ? content : null;
  } catch {
    return null;
  }
}
