import { describe, expect, it } from 'vitest';
import {
  ackedMessage,
  canAck,
  DEFAULT_ACK_HOURS,
  formatUntil,
  isAcked,
  isPaused,
  pausedBanner,
  PAUSE_DAY_CHOICES,
  pauseWarning,
  supportsAck,
  supportsPause,
} from './alert-actions.ts';

// 2026-09-29 12:00 giờ Việt Nam (05:00 UTC)
const NOW = Date.UTC(2026, 8, 29, 5, 0) / 1000;
const H = 3600;

describe('canAck: CHỈ hiện "Đã biết, đang xử lý" khi phase != ok và acked_until trống hoặc đã qua', () => {
  it('phase ok => không hiện (server sẽ trả 409 no_active_alert)', () => {
    expect(canAck({ phase: 'ok', acked_until: null }, NOW)).toBe(false);
  });
  it.each(['temp_alarm', 'offline'])('phase %s, chưa ack => hiện', (phase) => {
    expect(canAck({ phase, acked_until: null }, NOW)).toBe(true);
  });
  it('sensor_fault: nút "Đã biết" hiện (server chỉ chặn phase = ok), ẩn khi đã ack hoặc tạm dừng', () => {
    expect(canAck({ phase: 'sensor_fault', acked_until: null }, NOW)).toBe(true);
    expect(canAck({ phase: 'sensor_fault', acked_until: NOW + H }, NOW)).toBe(false);
    expect(canAck({ phase: 'sensor_fault', acked_until: null, paused_until: NOW + H }, NOW)).toBe(false);
  });
  it('phase lạ (server thêm trạng thái mới) cũng coi là có sự cố', () => {
    expect(canAck({ phase: 'something_new', acked_until: null }, NOW)).toBe(true);
  });
  it('đã ack và mốc chưa hết => ẩn; mốc đã qua (hoặc đúng lúc này) => hiện lại', () => {
    expect(canAck({ phase: 'temp_alarm', acked_until: NOW + H }, NOW)).toBe(false);
    expect(canAck({ phase: 'temp_alarm', acked_until: NOW }, NOW)).toBe(true);
    expect(canAck({ phase: 'temp_alarm', acked_until: NOW - 1 }, NOW)).toBe(true);
  });
  it('đang tạm dừng => ẩn (không có sự cố nào để ghi nhận)', () => {
    expect(canAck({ phase: 'temp_alarm', acked_until: null, paused_until: NOW + 86400 }, NOW)).toBe(false);
    expect(canAck({ phase: 'temp_alarm', acked_until: null, paused_until: NOW - 1 }, NOW)).toBe(true); // tạm dừng đã hết hạn
  });
  it('server cũ (không có trường acked_until) => KHÔNG hiện nút, tránh bấm ra 404 khó hiểu', () => {
    expect(supportsAck({})).toBe(false);
    expect(canAck({ phase: 'temp_alarm' }, NOW)).toBe(false);
    expect(supportsAck({ acked_until: null })).toBe(true);
  });
});

describe('tạm dừng', () => {
  it('isPaused theo giờ server; null/vắng/quá hạn => không tạm dừng', () => {
    expect(isPaused({ paused_until: NOW + 1 }, NOW)).toBe(true);
    expect(isPaused({ paused_until: NOW }, NOW)).toBe(false);
    expect(isPaused({ paused_until: null }, NOW)).toBe(false);
    expect(isPaused({}, NOW)).toBe(false);
  });
  it('isAcked', () => {
    expect(isAcked({ acked_until: NOW + 5 }, NOW)).toBe(true);
    expect(isAcked({ acked_until: null }, NOW)).toBe(false);
    expect(isAcked({}, NOW)).toBe(false);
  });
  it('server cũ không có paused_until => không hiện mục tạm dừng', () => {
    expect(supportsPause({})).toBe(false);
    expect(supportsPause({ paused_until: null })).toBe(true);
  });
  it('lựa chọn ngày đúng 1 / 3 / 7 / 14 / 30 (trong khoảng 1..60 của server)', () => {
    expect([...PAUSE_DAY_CHOICES]).toEqual([1, 3, 7, 14, 30]);
    expect(DEFAULT_ACK_HOURS).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_ACK_HOURS).toBeLessThanOrEqual(24);
  });
});

describe('thông điệp', () => {
  it('formatUntil: cùng ngày VN chỉ hiện giờ, khác ngày thêm dd/MM', () => {
    expect(formatUntil(NOW + 4 * H, NOW)).toBe('16:00');
    expect(formatUntil(NOW + 13 * H, NOW)).toBe('01:00 30/09'); // qua nửa đêm giờ VN
    // 23:30 giờ VN cùng ngày dù đã sang ngày khác theo UTC (VN = UTC+7)
    expect(formatUntil(Date.UTC(2026, 8, 29, 16, 30) / 1000, NOW)).toBe('23:30');
  });
  it('sau khi ack: "Đã ghi nhận, sẽ nhắc lại sau HH:mm nếu chưa xong"', () => {
    expect(ackedMessage(NOW + 4 * H, NOW)).toBe('Đã ghi nhận, sẽ nhắc lại sau 16:00 nếu chưa xong.');
  });
  it('biểu ngữ tạm dừng "Đang tạm dừng cảnh báo tới dd/MM"', () => {
    expect(pausedBanner(Date.UTC(2026, 9, 6, 5, 0) / 1000)).toBe('Đang tạm dừng cảnh báo tới 06/10');
  });
  it('cảnh báo trước khi tạm dừng nói rõ sẽ KHÔNG nhận cảnh báo và ngày kết thúc', () => {
    const w = pauseWarning(7, NOW);
    expect(w).toContain('KHÔNG nhận cảnh báo');
    expect(w).toContain('7 ngày');
    expect(w).toContain('06/10');
    expect(w).toContain('Bật lại');
  });
});
