// Lỗi thống nhất của ứng dụng + câu báo lỗi thân thiện cho chủ quán (không thuật ngữ kỹ thuật).

/** Mã lỗi: của server (`error` trong JSON) cộng các mã phía máy khách. */
export type ErrorCode =
  | 'bad_request'
  | 'bad_range'
  | 'too_many_recipients'
  | 'not_found'
  | 'invalid_code'
  | 'unauthorized'
  | 'too_large'
  | 'rate_limited'
  | 'internal'
  // Phía máy khách:
  | 'auth_required' // chưa lấy được access token (chưa cấp quyền)
  | 'network' // mất mạng / không kết nối được
  | 'timeout' // quá 15 giây
  | 'bad_response' // server trả dữ liệu không đúng dạng
  | 'unknown';

const SERVER_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'bad_request',
  'bad_range',
  'too_many_recipients',
  'not_found',
  'invalid_code',
  'unauthorized',
  'too_large',
  'rate_limited',
  'internal',
]);

export class AppError extends Error {
  readonly code: ErrorCode;
  /** HTTP status nếu lỗi đến từ phản hồi của server. */
  readonly status?: number;

  constructor(code: ErrorCode, status?: number) {
    super(code); // message là mã, KHÔNG chứa dữ liệu nhạy cảm (token, số điện thoại...)
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/** Lỗi cần người dùng cấp quyền/đăng nhập lại (hiện nút "Cho phép"). */
export function needsAuth(e: unknown): boolean {
  return isAppError(e) && (e.code === 'auth_required' || e.code === 'unauthorized');
}

/**
 * Đổi phản hồi lỗi HTTP của server thành AppError. Ưu tiên mã `error` trong JSON;
 * nếu không có (vd. lỗi từ Cloudflare/proxy) thì suy ra từ HTTP status.
 */
export function mapHttpError(status: number, body: unknown): AppError {
  const raw = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  if (typeof raw === 'string' && SERVER_CODES.has(raw)) return new AppError(raw as ErrorCode, status);
  if (status === 400) return new AppError('bad_request', status);
  if (status === 401 || status === 403) return new AppError('unauthorized', status);
  if (status === 404) return new AppError('not_found', status);
  if (status === 413) return new AppError('too_large', status);
  if (status === 429) return new AppError('rate_limited', status);
  if (status >= 500) return new AppError('internal', status);
  return new AppError('unknown', status);
}

/** Thông điệp tiếng Việt đơn giản, nói rõ người dùng nên làm gì tiếp. */
export const ERROR_MESSAGE: Record<ErrorCode, string> = {
  bad_request: 'Thông tin chưa đúng. Bạn kiểm tra lại giúp nhé.',
  bad_range: 'Nhiệt độ cao nhất phải lớn hơn nhiệt độ thấp nhất.',
  too_many_recipients: 'Mỗi thiết bị chỉ có tối đa 5 người nhận cảnh báo. Hãy xóa bớt một người rồi thêm lại.',
  not_found: 'Không tìm thấy thiết bị này. Có thể thiết bị đã được gỡ khỏi tài khoản của bạn.',
  invalid_code:
    'Mã không đúng hoặc thiết bị đã có chủ khác. Bạn kiểm tra lại mã trên hộp, hoặc liên hệ nơi bán để được hỗ trợ.',
  unauthorized: 'Phiên đăng nhập Zalo đã hết hạn hoặc chưa được cho phép. Bạn bấm "Cho phép" rồi thử lại nhé.',
  too_large: 'Dữ liệu gửi đi quá lớn. Bạn thử rút gọn lại nhé.',
  rate_limited: 'Bạn thao tác hơi nhanh. Đợi một chút rồi thử lại nhé.',
  internal: 'Hệ thống đang gặp sự cố. Bạn thử lại sau ít phút nhé.',
  auth_required: 'Ứng dụng cần được phép dùng tài khoản Zalo của bạn. Bạn bấm "Cho phép" nhé.',
  network: 'Không kết nối được mạng. Bạn kiểm tra Wi-Fi hoặc 4G rồi thử lại nhé.',
  timeout: 'Mạng đang chậm, chưa nhận được phản hồi. Bạn thử lại nhé.',
  bad_response: 'Nhận được dữ liệu lạ từ hệ thống. Bạn thử lại sau, nếu vẫn lỗi hãy liên hệ hỗ trợ.',
  unknown: 'Có lỗi xảy ra. Bạn thử lại nhé.',
};

/** Câu báo lỗi cho mọi loại lỗi (kể cả lỗi không phải AppError). */
export function errorMessage(e: unknown): string {
  return ERROR_MESSAGE[isAppError(e) ? e.code : 'unknown'];
}
