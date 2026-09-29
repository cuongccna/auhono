// @vitest-environment jsdom
// Hook tải dữ liệu: đua request, huỷ khi rời màn hình, tự làm mới (fake timers), giãn dần khi lỗi, không rò bộ đếm giờ.
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextPollDelay, POLL_MAX_BACKOFF_MS, POLL_MS, useAsync, useNow, useSingleFlight } from './hooks.ts';
import { resetClock } from './lib/clock.ts';
import { AppError } from './lib/errors.ts';

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** Promise mà test tự quyết định lúc nào hoàn thành. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  resetClock();
  setVisibility('visible');
});
afterEach(() => {
  cleanup(); // gỡ mọi hook còn treo, tránh lắng nghe sự kiện của test trước
  vi.useRealTimers();
  setVisibility('visible');
});

describe('nextPollDelay', () => {
  it('60 giây khi ổn; gấp đôi mỗi lần lỗi liên tiếp; trần 5 phút', () => {
    expect(nextPollDelay(60_000, 0)).toBe(60_000);
    expect(nextPollDelay(60_000, 1)).toBe(120_000);
    expect(nextPollDelay(60_000, 2)).toBe(240_000);
    expect(nextPollDelay(60_000, 3)).toBe(POLL_MAX_BACKOFF_MS);
    expect(nextPollDelay(60_000, 50)).toBe(POLL_MAX_BACKOFF_MS);
    expect(nextPollDelay(60_000, -3)).toBe(60_000);
  });
});

describe('useAsync: tải một lần', () => {
  it('tải xong: có dữ liệu, hết loading, ghi lại thời điểm (giờ server)', async () => {
    const { result } = renderHook(() => useAsync(async () => 42, []));
    expect(result.current.loading).toBe(true);
    await flush();
    expect(result.current.data).toBe(42);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeUndefined();
    expect(result.current.updatedAt).toBeCloseTo(1_800_000_000, 0);
  });

  it('lỗi khi tải lần đầu: có error, không có data', async () => {
    const { result } = renderHook(() => useAsync(async () => { throw new AppError('network'); }, []));
    await flush();
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeInstanceOf(AppError);
  });

  it('stale-while-error: làm mới lỗi thì GIỮ dữ liệu cũ + báo lỗi (không trắng màn hình)', async () => {
    let fail = false;
    const { result } = renderHook(() => useAsync(async () => { if (fail) throw new AppError('network'); return 'số cũ'; }, []));
    await flush();
    fail = true;
    act(() => result.current.reload());
    await flush();
    expect(result.current.data).toBe('số cũ');
    expect(result.current.error).toBeInstanceOf(AppError);
    expect(result.current.updatedAt).not.toBeNull();
    fail = false;
    act(() => result.current.reload());
    await flush();
    expect(result.current.error).toBeUndefined();
  });

  it('reload() khi đang có request bay thì bỏ qua (chống bấm liên tục)', async () => {
    const d = deferred<number>();
    const fn = vi.fn(() => d.promise);
    const { result } = renderHook(() => useAsync(fn, []));
    await flush();
    act(() => result.current.reload());
    act(() => result.current.reload());
    act(() => result.current.reload());
    expect(fn).toHaveBeenCalledTimes(1);
    d.resolve(1);
    await flush();
    act(() => result.current.reload());
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('useAsync: refresh() sau khi ghi', () => {
  it('đang có request bay: xếp hàng ĐÚNG MỘT lần tải mới ngay khi request đó xong (số liệu sau khi thêm/xóa không bị bỏ sót)', async () => {
    const first = deferred<string>();
    const fn = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue('mới');
    const { result } = renderHook(() => useAsync(fn, []));
    await flush();
    act(() => result.current.refresh());
    act(() => result.current.refresh());
    act(() => result.current.refresh());
    expect(fn).toHaveBeenCalledTimes(1); // chưa chạy chồng
    first.resolve('cũ');
    await flush();
    expect(fn).toHaveBeenCalledTimes(2); // 3 lần refresh gộp thành 1
    expect(result.current.data).toBe('mới');
  });

  it('không có request bay: tải ngay', async () => {
    const fn = vi.fn(async () => 1);
    const { result } = renderHook(() => useAsync(fn, []));
    await flush();
    act(() => result.current.refresh());
    await flush();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('useAsync: đua request, đổi thiết bị, rời màn hình', () => {
  it('đổi deps (sang thiết bị khác): dữ liệu của thiết bị trước BIẾN MẤT ngay, không lẫn sang màn hình mới', async () => {
    const d2 = deferred<string>();
    const { result, rerender } = renderHook(({ id }) => useAsync(() => (id === 'A' ? Promise.resolve('dữ liệu A') : d2.promise), [id]), {
      initialProps: { id: 'A' },
    });
    await flush();
    expect(result.current.data).toBe('dữ liệu A');
    rerender({ id: 'B' });
    expect(result.current.data).toBeUndefined(); // ngay lập tức, không chờ B tải xong
    expect(result.current.loading).toBe(true);
    d2.resolve('dữ liệu B');
    await flush();
    expect(result.current.data).toBe('dữ liệu B');
  });

  it('phản hồi VỀ MUỘN của thiết bị cũ không ghi đè trạng thái của thiết bị mới (out-of-order)', async () => {
    const dA = deferred<string>();
    const dB = deferred<string>();
    const { result, rerender } = renderHook(({ id }) => useAsync(() => (id === 'A' ? dA.promise : dB.promise), [id]), {
      initialProps: { id: 'A' },
    });
    await flush();
    rerender({ id: 'B' });
    await flush();
    dB.resolve('B mới');
    await flush();
    dA.resolve('A cũ về muộn');
    await flush();
    expect(result.current.data).toBe('B mới');
  });

  it('đổi thiết bị: huỷ (abort) request của thiết bị cũ', async () => {
    const signals: AbortSignal[] = [];
    const { rerender } = renderHook(({ id }) => useAsync((signal) => { signals.push(signal); return new Promise<string>(() => undefined); }, [id]), {
      initialProps: { id: 'A' },
    });
    await flush();
    rerender({ id: 'B' });
    await flush();
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  });

  it('rời màn hình: huỷ request, kết quả về muộn không cập nhật state, không còn bộ đếm giờ', async () => {
    const d = deferred<string>();
    let signal!: AbortSignal;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { unmount } = renderHook(() => useAsync((s) => { signal = s; return d.promise; }, [], { pollMs: POLL_MS }));
    await flush();
    unmount();
    expect(signal.aborted).toBe(true);
    d.resolve('muộn');
    await flush();
    expect(errorSpy).not.toHaveBeenCalled(); // không có cảnh báo "setState sau khi unmount"
    expect(vi.getTimerCount()).toBe(0);
    errorSpy.mockRestore();
  });

  it('lỗi aborted (do huỷ) không bị coi là lỗi của người dùng', async () => {
    const { result, rerender } = renderHook(({ id }) => useAsync(async () => { if (id === 'A') throw new AppError('aborted'); return 'ok'; }, [id]), {
      initialProps: { id: 'A' },
    });
    await flush();
    expect(result.current.error).toBeUndefined();
    rerender({ id: 'B' });
    await flush();
    expect(result.current.data).toBe('ok');
  });
});

describe('useAsync: tự làm mới khi đang xem (polling)', () => {
  it('làm mới mỗi 60 giây, không nhấp nháy "loading", giữ nguyên dữ liệu trong lúc tải', async () => {
    let n = 0;
    const { result } = renderHook(() => useAsync(async () => ++n, [], { pollMs: POLL_MS }));
    await flush();
    expect(result.current.data).toBe(1);
    await advance(59_999);
    expect(n).toBe(1);
    await advance(2);
    expect(n).toBe(2);
    expect(result.current.data).toBe(2);
    expect(result.current.loading).toBe(false);
    await advance(POLL_MS);
    expect(n).toBe(3);
  });

  it('không có pollMs thì không tự làm mới', async () => {
    const fn = vi.fn(async () => 1);
    renderHook(() => useAsync(fn, []));
    await flush();
    await advance(10 * 60_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('màn hình ẩn (khoá máy/sang app khác): dừng làm mới; hiện lại thì tải ngay nếu dữ liệu cũ', async () => {
    const fn = vi.fn(async () => 1);
    renderHook(() => useAsync(fn, [], { pollMs: POLL_MS }));
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    setVisibility('hidden');
    await advance(10 * 60_000); // 10 phút trong túi quần
    expect(fn).toHaveBeenCalledTimes(1); // không tốn pin/data 3G
    setVisibility('visible');
    await flush();
    expect(fn).toHaveBeenCalledTimes(2); // quay lại: cập nhật ngay
    await advance(POLL_MS + 1);
    expect(fn).toHaveBeenCalledTimes(3); // và tiếp tục theo chu kỳ
  });

  it('ẩn rồi hiện lại ngay (dữ liệu còn mới): không tải thừa, chỉ đặt lại hẹn giờ', async () => {
    const fn = vi.fn(async () => 1);
    renderHook(() => useAsync(fn, [], { pollMs: POLL_MS }));
    await flush();
    await advance(5_000);
    setVisibility('hidden');
    setVisibility('visible');
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    await advance(POLL_MS);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('có mạng lại (sự kiện online): tải ngay', async () => {
    const fn = vi.fn(async () => 1);
    renderHook(() => useAsync(fn, [], { pollMs: POLL_MS }));
    await flush();
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await flush();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('lỗi liên tiếp: giãn dần 60s -> 120s -> 240s -> 300s (trần), thành công thì về lại 60s', async () => {
    let fail = true;
    const fn = vi.fn(async () => {
      if (fail) throw new AppError('network');
      return 'ok';
    });
    const { result } = renderHook(() => useAsync(fn, [], { pollMs: POLL_MS }));
    await flush(); // lần 1 lỗi -> hẹn 120s
    expect(fn).toHaveBeenCalledTimes(1);
    await advance(119_000);
    expect(fn).toHaveBeenCalledTimes(1);
    await advance(1_001); // lần 2 lỗi -> hẹn 240s
    expect(fn).toHaveBeenCalledTimes(2);
    await advance(239_000);
    expect(fn).toHaveBeenCalledTimes(2);
    await advance(1_001); // lần 3 lỗi -> hẹn 300s (trần)
    expect(fn).toHaveBeenCalledTimes(3);
    await advance(299_000);
    expect(fn).toHaveBeenCalledTimes(3);
    fail = false;
    await advance(1_001); // lần 4 thành công -> hẹn lại 60s
    expect(fn).toHaveBeenCalledTimes(4);
    expect(result.current.data).toBe('ok');
    expect(result.current.error).toBeUndefined();
    await advance(POLL_MS + 1);
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('làm mới ngầm bị lỗi: giữ dữ liệu cũ, hiện lỗi, KHÔNG bật loading', async () => {
    let fail = false;
    const { result } = renderHook(() => useAsync(async () => { if (fail) throw new AppError('timeout'); return 'số liệu'; }, [], { pollMs: POLL_MS }));
    await flush();
    fail = true;
    await advance(POLL_MS + 1);
    expect(result.current.data).toBe('số liệu');
    expect(result.current.error).toBeInstanceOf(AppError);
    expect(result.current.loading).toBe(false);
  });

  it('lỗi cần cấp quyền (401): dừng tự làm mới thay vì gọi liên tục; người dùng bấm thử lại thì chạy tiếp', async () => {
    let denied = true;
    const fn = vi.fn(async () => {
      if (denied) throw new AppError('unauthorized', 401);
      return 'ok';
    });
    const { result } = renderHook(() => useAsync(fn, [], { pollMs: POLL_MS }));
    await flush();
    await advance(30 * 60_000);
    expect(fn).toHaveBeenCalledTimes(1);
    denied = false;
    act(() => result.current.reload());
    await flush();
    expect(result.current.data).toBe('ok');
    await advance(POLL_MS + 1);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('not_found (thiết bị đã bị gỡ ở nơi khác): dừng tự làm mới', async () => {
    const fn = vi.fn(async () => {
      throw new AppError('not_found', 404);
    });
    renderHook(() => useAsync(fn, [], { pollMs: POLL_MS }));
    await flush();
    await advance(30 * 60_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('503 auth_unavailable (Zalo bận): KHÔNG dừng — vẫn thử lại theo chu kỳ giãn dần, giữ dữ liệu cũ', async () => {
    let busy = false;
    const fn = vi.fn(async () => {
      if (busy) throw new AppError('auth_unavailable', 503);
      return 'ok';
    });
    const { result } = renderHook(() => useAsync(fn, [], { pollMs: POLL_MS }));
    await flush();
    busy = true;
    await advance(POLL_MS + 1); // lỗi -> hẹn 120s
    expect(result.current.data).toBe('ok');
    expect((result.current.error as AppError).code).toBe('auth_unavailable');
    busy = false;
    await advance(120_001);
    expect(result.current.error).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('gỡ màn hình: không còn bộ đếm giờ nào và không còn lắng nghe visibility/online', async () => {
    const fn = vi.fn(async () => 1);
    const { unmount } = renderHook(() => useAsync(fn, [], { pollMs: POLL_MS }));
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    setVisibility('hidden');
    setVisibility('visible');
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await advance(10 * 60_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('mount/unmount 50 lần liên tiếp không để lại bộ đếm giờ (không rò)', async () => {
    for (let i = 0; i < 50; i++) {
      const { unmount } = renderHook(() => useAsync(async () => i, [], { pollMs: POLL_MS }));
      await flush();
      unmount();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('useSingleFlight: chống bấm đúp', () => {
  it('hai lần gọi liên tiếp trong cùng một khung hình chỉ chạy MỘT lần; xong rồi mới cho gọi lại', async () => {
    const { result } = renderHook(() => useSingleFlight());
    const d = deferred<string>();
    const fn = vi.fn(() => d.promise);
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = result.current(fn);
      second = result.current(fn); // chạm lần hai trước khi React kịp vô hiệu hoá nút
    });
    expect(fn).toHaveBeenCalledTimes(1);
    d.resolve('xong');
    await act(async () => {
      expect(await first).toBe('xong');
      expect(await second).toBeUndefined();
    });
    await act(async () => {
      await result.current(async () => 'lần sau');
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('lỗi trong lần chạy không làm kẹt cờ (vẫn bấm lại được)', async () => {
    const { result } = renderHook(() => useSingleFlight());
    await act(async () => {
      await result.current(async () => { throw new Error('x'); }).catch(() => undefined);
    });
    const fn = vi.fn(async () => 1);
    await act(async () => {
      await result.current(fn);
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('useNow', () => {
  it('nhích theo giờ và cập nhật khi quay lại app', async () => {
    const { result } = renderHook(() => useNow(30_000));
    const t0 = result.current;
    await advance(31_000);
    expect(result.current).toBeGreaterThanOrEqual(t0 + 30);
  });
});
