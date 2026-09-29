import { describe, expect, it } from 'vitest';
import { deviceStatus, OFFLINE_AFTER_SECONDS, STATUS_LABEL } from './status.ts';

const NOW = 1_800_000_000;

describe('deviceStatus', () => {
  it('chưa từng gửi số đo', () => {
    expect(deviceStatus({ phase: 'ok', lastSeen: null, nowSeconds: NOW })).toBe('no_data');
  });
  it('bình thường', () => {
    expect(deviceStatus({ phase: 'ok', lastSeen: NOW - 60, nowSeconds: NOW })).toBe('ok');
  });
  it('đang báo động', () => {
    expect(deviceStatus({ phase: 'temp_alarm', lastSeen: NOW - 60, nowSeconds: NOW })).toBe('alarm');
  });
  it('server đã đánh dấu offline', () => {
    expect(deviceStatus({ phase: 'offline', lastSeen: NOW - 60, nowSeconds: NOW })).toBe('offline');
  });
  it('im lặng quá 15 phút là mất kết nối dù phase còn "ok" (cron chưa kịp chạy); đúng 15 phút chưa tính', () => {
    expect(deviceStatus({ phase: 'ok', lastSeen: NOW - OFFLINE_AFTER_SECONDS, nowSeconds: NOW })).toBe('ok');
    expect(deviceStatus({ phase: 'ok', lastSeen: NOW - OFFLINE_AFTER_SECONDS - 1, nowSeconds: NOW })).toBe('offline');
  });
  it('mất kết nối đứng trên báo động (không biết nhiệt độ thật)', () => {
    expect(deviceStatus({ phase: 'temp_alarm', lastSeen: NOW - 3600, nowSeconds: NOW })).toBe('offline');
  });
  it('phase lạ không giả vờ là bình thường', () => {
    expect(deviceStatus({ phase: 'maintenance', lastSeen: NOW - 60, nowSeconds: NOW })).toBe('unknown');
  });
  it('đang tạm dừng: trạng thái "Tạm dừng", KHÔNG hiện "Mất kết nối" như sự cố dù thiết bị im lặng (cố ý rút điện)', () => {
    const pausedUntil = NOW + 86400;
    expect(deviceStatus({ phase: 'ok', lastSeen: NOW - 5 * 3600, nowSeconds: NOW, pausedUntil })).toBe('paused');
    expect(deviceStatus({ phase: 'offline', lastSeen: NOW - 5 * 3600, nowSeconds: NOW, pausedUntil })).toBe('paused');
    expect(deviceStatus({ phase: 'temp_alarm', lastSeen: NOW - 60, nowSeconds: NOW, pausedUntil })).toBe('paused');
    expect(deviceStatus({ phase: 'ok', lastSeen: null, nowSeconds: NOW, pausedUntil })).toBe('paused');
  });
  it('tạm dừng đã hết hạn / null / vắng (server cũ) => tính như bình thường', () => {
    expect(deviceStatus({ phase: 'ok', lastSeen: NOW - 5 * 3600, nowSeconds: NOW, pausedUntil: NOW - 1 })).toBe('offline');
    expect(deviceStatus({ phase: 'ok', lastSeen: NOW - 5 * 3600, nowSeconds: NOW, pausedUntil: NOW })).toBe('offline');
    expect(deviceStatus({ phase: 'ok', lastSeen: NOW - 5 * 3600, nowSeconds: NOW, pausedUntil: null })).toBe('offline');
    expect(deviceStatus({ phase: 'ok', lastSeen: NOW - 60, nowSeconds: NOW })).toBe('ok');
  });
  it('nhãn tiếng Việt', () => {
    expect(STATUS_LABEL.paused).toBe('Tạm dừng cảnh báo');
    expect(STATUS_LABEL.ok).toBe('Bình thường');
    expect(STATUS_LABEL.alarm).toBe('Đang báo động');
    expect(STATUS_LABEL.offline).toBe('Mất kết nối');
  });
});
