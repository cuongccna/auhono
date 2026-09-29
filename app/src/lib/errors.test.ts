import { describe, expect, it } from 'vitest';
import { AppError, ERROR_MESSAGE, errorMessage, isAborted, isAmbiguous, mapHttpError, needsAuth, type ErrorCode } from './errors.ts';

describe('mapHttpError', () => {
  it.each([
    ['bad_request', 400],
    ['bad_range', 400],
    ['too_many_recipients', 409],
    ['not_found', 404],
    ['invalid_code', 404],
    ['unauthorized', 401],
    ['too_large', 413],
    ['internal', 500],
  ] as const)('dùng mã `error` của server: %s', (code, status) => {
    const e = mapHttpError(status, { error: code });
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe(code);
    expect(e.status).toBe(status);
  });

  it('mã `error` của server thắng HTTP status (invalid_code là 404 nhưng không phải not_found)', () => {
    expect(mapHttpError(404, { error: 'invalid_code' }).code).toBe('invalid_code');
  });

  it('không có/khác dạng => suy từ HTTP status', () => {
    expect(mapHttpError(400, null).code).toBe('bad_request');
    expect(mapHttpError(401, {}).code).toBe('unauthorized');
    expect(mapHttpError(403, 'html').code).toBe('unauthorized');
    expect(mapHttpError(404, undefined).code).toBe('not_found');
    expect(mapHttpError(413, null).code).toBe('too_large');
    expect(mapHttpError(429, null).code).toBe('rate_limited');
    expect(mapHttpError(502, null).code).toBe('internal');
    expect(mapHttpError(418, null).code).toBe('unknown');
  });

  it('mã lạ (kể cả cố ý gài như __proto__) không lọt qua thành ErrorCode', () => {
    expect(mapHttpError(400, { error: 'evil' }).code).toBe('bad_request');
    expect(mapHttpError(500, { error: '__proto__' }).code).toBe('internal');
    expect(mapHttpError(400, { error: 42 }).code).toBe('bad_request');
  });

  it('thông điệp lỗi không chứa dữ liệu nhạy cảm', () => {
    expect(new AppError('unauthorized').message).toBe('unauthorized');
  });
});

describe('thông điệp tiếng Việt', () => {
  it('có thông điệp cho mọi mã lỗi, không rỗng', () => {
    for (const code of Object.keys(ERROR_MESSAGE) as ErrorCode[]) expect(ERROR_MESSAGE[code].length).toBeGreaterThan(10);
  });
  it('các mã người dùng hay gặp', () => {
    expect(errorMessage(new AppError('too_many_recipients'))).toContain('tối đa 5');
    expect(errorMessage(new AppError('invalid_code'))).toContain('Mã không đúng');
    expect(errorMessage(new AppError('network'))).toContain('mạng');
    expect(errorMessage(new AppError('unauthorized'))).toContain('Cho phép');
    expect(errorMessage(new AppError('not_found'))).toContain('Không tìm thấy');
    expect(errorMessage(new AppError('bad_request'))).toContain('kiểm tra lại');
  });
  it('lỗi không phải AppError => câu chung', () => {
    expect(errorMessage(new Error('boom'))).toBe(ERROR_MESSAGE.unknown);
    expect(errorMessage('x')).toBe(ERROR_MESSAGE.unknown);
  });
});

describe('needsAuth', () => {
  it('chỉ true cho lỗi liên quan quyền/đăng nhập', () => {
    expect(needsAuth(new AppError('auth_required'))).toBe(true);
    expect(needsAuth(new AppError('unauthorized'))).toBe(true);
    expect(needsAuth(new AppError('network'))).toBe(false);
    expect(needsAuth(new Error('x'))).toBe(false);
  });
});

describe('hợp đồng server mới', () => {
  it('429 too_many_attempts (nhập sai mã nhiều lần) => thông điệp riêng, không nhầm với rate_limited', () => {
    const e = mapHttpError(429, { error: 'too_many_attempts' });
    expect(e.code).toBe('too_many_attempts');
    expect(errorMessage(e)).toContain('sai mã quá nhiều lần');
    expect(mapHttpError(429, null).code).toBe('rate_limited');
    expect(mapHttpError(429, { error: 'rate_limited' }).code).toBe('rate_limited');
  });

  it('503 auth_unavailable = Zalo đang bận: sự cố TẠM THỜI, KHÔNG phải token sai', () => {
    const e = mapHttpError(503, { error: 'auth_unavailable' });
    expect(e.code).toBe('auth_unavailable');
    expect(e.status).toBe(503);
    expect(needsAuth(e)).toBe(false); // không hiện nút "Cho phép", không chạy luồng xin quyền lại
    expect(errorMessage(e)).toBe('Zalo đang bận, chưa kiểm tra được tài khoản của bạn. Bạn thử lại sau ít phút nhé.');
    // 401 unauthorized thật vẫn cần cấp quyền
    expect(needsAuth(mapHttpError(401, { error: 'unauthorized' }))).toBe(true);
    // 503 không kèm mã (proxy) chỉ là lỗi hệ thống chung, cũng không phải lỗi token
    expect(needsAuth(mapHttpError(503, null))).toBe(false);
  });

  it('isAmbiguous: lỗi mà thao tác GHI có thể đã thành công phía server', () => {
    expect(isAmbiguous(new AppError('network'))).toBe(true);
    expect(isAmbiguous(new AppError('timeout'))).toBe(true);
    expect(isAmbiguous(new AppError('bad_response', 200))).toBe(true);
    expect(isAmbiguous(new AppError('internal', 502))).toBe(true);
    expect(isAmbiguous(new AppError('invalid_code', 404))).toBe(false);
    expect(isAmbiguous(new AppError('bad_request', 400))).toBe(false);
    expect(isAmbiguous(new AppError('auth_unavailable', 503))).toBe(false); // server chưa xử lý gì
    expect(isAmbiguous(new Error('x'))).toBe(false);
  });

  it('isAborted; server không thể "tiêm" mã aborted', () => {
    expect(isAborted(new AppError('aborted'))).toBe(true);
    expect(isAborted(new AppError('network'))).toBe(false);
    expect(mapHttpError(400, { error: 'aborted' }).code).toBe('bad_request');
  });
});

describe('ack / pause', () => {
  it('409 no_active_alert (bấm "Đã biết" khi sự cố đã hết) => thông điệp riêng dễ hiểu', () => {
    const err = mapHttpError(409, { error: 'no_active_alert' });
    expect(err.code).toBe('no_active_alert');
    expect(errorMessage(err)).toContain('không có sự cố nào');
    expect(needsAuth(err)).toBe(false);
  });
  it('429 too_many_attempts nói rõ có thể bị khóa tới ~1 giờ', () => {
    expect(errorMessage(new AppError('too_many_attempts'))).toContain('1 giờ');
  });
});

describe('Telegram', () => {
  it('503 telegram_not_configured: mã riêng, không phải lỗi token, không xin quyền lại', () => {
    const err = mapHttpError(503, { error: 'telegram_not_configured' });
    expect(err.code).toBe('telegram_not_configured');
    expect(needsAuth(err)).toBe(false);
    expect(errorMessage(err)).toContain('Telegram chưa được bật');
  });
  it('409 telegram_not_linked: thông điệp bảo kết nối lại', () => {
    const err = mapHttpError(409, { error: 'telegram_not_linked' });
    expect(err.code).toBe('telegram_not_linked');
    expect(errorMessage(err)).toContain('chưa kết nối Telegram');
    expect(isAmbiguous(err)).toBe(false);
  });
  it('400 (mode sai) => bad_request chung', () => {
    expect(mapHttpError(400, { error: 'bad_request' }).code).toBe('bad_request');
  });
});
