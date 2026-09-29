// Cấu hình lúc build. Chỉ biến bắt đầu bằng VITE_ mới vào bundle: KHÔNG đặt bí mật ở đây.

/** Địa chỉ giả (TLD .invalid không bao giờ phân giải được) để quên cấu hình thì lỗi rõ ràng, không gửi token đi đâu cả. */
export const PLACEHOLDER_API_BASE = 'https://api.auhono.invalid';

export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined)?.trim() || PLACEHOLDER_API_BASE;

export const isApiConfigured = API_BASE !== PLACEHOLDER_API_BASE;
