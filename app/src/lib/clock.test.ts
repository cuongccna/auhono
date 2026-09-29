import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clockOffsetSeconds, isClockSynced, resetClock, serverNow, syncClock } from './clock.ts';

const SERVER = 1_800_000_000;

beforeEach(() => {
  resetClock();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('đồng hồ theo giờ server', () => {
  it('chưa đồng bộ: dùng giờ điện thoại (server cũ không có server_time)', () => {
    vi.setSystemTime(SERVER * 1000);
    expect(isClockSynced()).toBe(false);
    expect(serverNow()).toBeCloseTo(SERVER, 3);
  });

  it('điện thoại chạy NHANH 1 giờ: serverNow vẫn ra giờ server', () => {
    const phoneMs = (SERVER + 3600) * 1000;
    vi.setSystemTime(phoneMs);
    expect(syncClock(SERVER, phoneMs - 200, phoneMs + 200)).toBe(true);
    expect(clockOffsetSeconds()).toBeCloseTo(-3600, 3);
    expect(serverNow()).toBeCloseTo(SERVER, 3);
    vi.advanceTimersByTime(90_000); // trôi 90 giây
    expect(serverNow()).toBeCloseTo(SERVER + 90, 3);
  });

  it('điện thoại chạy CHẬM 2 ngày cũng được bù', () => {
    const phoneMs = (SERVER - 2 * 86400) * 1000;
    vi.setSystemTime(phoneMs);
    syncClock(SERVER, phoneMs, phoneMs);
    expect(serverNow()).toBeCloseTo(SERVER, 3);
  });

  it('bù độ trễ mạng: server_time ứng với điểm GIỮA lúc gửi và lúc nhận', () => {
    const t0 = SERVER * 1000;
    vi.setSystemTime(t0 + 4000);
    syncClock(SERVER + 2, t0, t0 + 4000); // đi 2 giây, về 2 giây
    expect(serverNow()).toBeCloseTo(SERVER + 4, 3);
  });

  it('bỏ qua server_time rác: 0, âm, NaN, mili-giây, chuỗi, thiếu', () => {
    const now = SERVER * 1000;
    vi.setSystemTime(now);
    for (const bad of [0, -5, NaN, Infinity, SERVER * 1000, '1800000000', null, undefined]) {
      expect(syncClock(bad, now, now)).toBe(false);
    }
    expect(isClockSynced()).toBe(false);
    expect(clockOffsetSeconds()).toBe(0);
  });

  it('bỏ qua phản hồi mất > 60 giây hoặc giờ nhận < giờ gửi (đồng hồ điện thoại vừa nhảy)', () => {
    const now = SERVER * 1000;
    vi.setSystemTime(now);
    expect(syncClock(SERVER, now - 61_000, now)).toBe(false);
    expect(syncClock(SERVER, now, now - 1)).toBe(false);
  });

  it('phản hồi đến sau vẫn hiệu chỉnh lại độ lệch (điện thoại vừa tự chỉnh giờ)', () => {
    vi.setSystemTime((SERVER + 600) * 1000);
    syncClock(SERVER, (SERVER + 600) * 1000, (SERVER + 600) * 1000);
    expect(clockOffsetSeconds()).toBeCloseTo(-600, 3);
    vi.setSystemTime(SERVER * 1000 + 30_000); // mạng vừa chỉnh giờ đúng
    syncClock(SERVER + 30, SERVER * 1000 + 30_000, SERVER * 1000 + 30_000);
    expect(clockOffsetSeconds()).toBeCloseTo(0, 3);
  });
});
