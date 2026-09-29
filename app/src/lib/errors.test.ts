import { describe, expect, it } from 'vitest';
import { AppError, ERROR_MESSAGE, errorMessage, mapHttpError, needsAuth, type ErrorCode } from './errors.ts';

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
