// Hook dùng chung: tải dữ liệu (huỷ được, tự làm mới khi đang xem), đồng hồ theo giờ server, trạng thái mạng, chống bấm đúp.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { serverNow } from './lib/clock.ts';
import { isAborted, isAppError, needsAuth } from './lib/errors.ts';

/** Làm mới mỗi 60 giây khi đang xem (đủ "gần thời gian thực" khi có sự cố, nhẹ cho 3G/pin). */
export const POLL_MS = 60_000;
/** Lỗi liên tiếp thì giãn dần (gấp đôi mỗi lần) nhưng không quá 5 phút. */
export const POLL_MAX_BACKOFF_MS = 5 * 60_000;

/** Khoảng chờ tới lần làm mới kế tiếp: `pollMs`, nhân đôi sau mỗi lần lỗi liên tiếp, trần 5 phút. */
export function nextPollDelay(pollMs: number, failures: number): number {
  const ceiling = Math.max(POLL_MAX_BACKOFF_MS, pollMs);
  return Math.min(ceiling, pollMs * 2 ** Math.min(Math.max(0, failures), 8));
}

const isVisible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden';

export interface AsyncOptions {
  /** Có giá trị: tự tải lại mỗi ngần này ms KHI màn hình đang hiện (tạm dừng khi ẩn, giãn dần khi lỗi). */
  pollMs?: number;
}

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  /** Đang tải ở "tiền cảnh" (lần đầu hoặc người dùng bấm làm mới). Làm mới ngầm KHÔNG bật cờ này. */
  loading: boolean;
  /** Bất kỳ request nào đang bay, kể cả làm mới ngầm. */
  refreshing: boolean;
  /** Giờ SERVER (Unix giây) lúc dữ liệu hiện có được tải xong; null nếu chưa có. */
  updatedAt: number | null;
  /** Người dùng bấm "Làm mới"/"Thử lại": bỏ qua nếu đang có request bay (chống bấm liên tục). */
  reload: () => void;
  /** Sau khi ghi (thêm/xóa): đảm bảo có MỘT lần tải mới bắt đầu sau lúc gọi; nếu đang có request bay thì xếp hàng chạy ngay khi nó xong. */
  refresh: () => void;
}

interface Inner<T> {
  gen: number;
  data: T | undefined;
  error: unknown;
  loading: boolean;
  refreshing: boolean;
  updatedAt: number | null;
}

const sameDeps = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/**
 * Chạy `fn` khi vào màn hình / khi `deps` đổi / khi gọi `reload()` / theo chu kỳ (nếu có `pollMs`).
 *  - Giữ dữ liệu cũ khi tải lại hoặc gặp lỗi (hiện số cũ + báo lỗi, không trắng màn hình).
 *  - Đổi `deps` (vd. sang thiết bị khác) thì BỎ dữ liệu của lần trước ngay, không để lẫn thiết bị.
 *  - Mỗi lần chạy có AbortSignal: rời màn hình/đổi deps thì huỷ request đang bay; kết quả về muộn không ghi đè trạng thái mới.
 *  - `reload()` khi đang có request bay thì bỏ qua (chống bấm liên tục).
 *  - Lỗi cần cấp quyền hoặc "không tìm thấy" (thiết bị đã bị gỡ): dừng tự làm mới cho tới khi người dùng thao tác/quay lại app
 *    (tránh gọi liên tục vô ích).
 */
export function useAsync<T>(fn: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[], options: AsyncOptions = {}): AsyncState<T> {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const pollMs = options.pollMs;

  const depsRef = useRef(deps);
  const genRef = useRef(0);
  if (!sameDeps(depsRef.current, deps)) {
    depsRef.current = deps;
    genRef.current += 1;
  }
  const gen = genRef.current;

  const [state, setState] = useState<Inner<T>>({ gen, data: undefined, error: undefined, loading: true, refreshing: true, updatedAt: null });
  const reloadRef = useRef<{ reload: () => void; refresh: () => void }>({ reload: () => undefined, refresh: () => undefined });

  useEffect(() => {
    let alive = true;
    let inFlight = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let lastOkAt = 0;
    let queued = false; // có yêu cầu refresh() xếp hàng trong lúc request đang bay

    const clearTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const schedule = (delayMs: number) => {
      clearTimer();
      if (!alive || !pollMs || !isVisible()) return;
      timer = setTimeout(() => void load(false), delayMs);
    };

    async function load(foreground: boolean): Promise<void> {
      if (!alive || inFlight) return;
      clearTimer();
      inFlight = true;
      const mine = new AbortController();
      controller = mine;
      setState((s) =>
        s.gen === gen
          ? { ...s, error: foreground ? undefined : s.error, loading: foreground || s.data === undefined, refreshing: true }
          : { gen, data: undefined, error: undefined, loading: true, refreshing: true, updatedAt: null },
      );

      let stopPolling = false;
      try {
        const data = await fnRef.current(mine.signal);
        if (!alive || mine.signal.aborted) return;
        failures = 0;
        lastOkAt = Date.now();
        setState({ gen, data, error: undefined, loading: false, refreshing: false, updatedAt: serverNow() });
      } catch (error) {
        if (!alive || mine.signal.aborted || isAborted(error)) return;
        failures += 1;
        // Cần cấp quyền, hoặc thiết bị không còn của mình (đã gỡ ở nơi khác): thử lại vô ích, dừng tự làm mới.
        stopPolling = needsAuth(error) || (isAppError(error) && error.code === 'not_found');
        setState((s) => (s.gen === gen ? { ...s, error, loading: false, refreshing: false } : s));
      } finally {
        if (controller === mine) inFlight = false;
      }
      if (queued) {
        queued = false;
        void load(true);
      } else if (!stopPolling && pollMs) {
        schedule(nextPollDelay(pollMs, failures));
      }
    }

    reloadRef.current = {
      reload: () => void load(true),
      refresh: () => {
        if (inFlight) queued = true;
        else void load(true);
      },
    };
    void load(true);

    // Quay lại app / bật lại mạng: tải ngay nếu dữ liệu đã cũ.
    const onVisibility = () => {
      if (!alive || !pollMs) return;
      if (!isVisible()) {
        clearTimer();
        return;
      }
      const age = Date.now() - lastOkAt;
      if (failures > 0 || age >= Math.min(pollMs, 30_000)) void load(false);
      else schedule(Math.max(0, pollMs - age));
    };
    const onOnline = () => {
      if (alive && pollMs && isVisible()) void load(false);
    };
    if (pollMs) {
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('online', onOnline);
    }

    return () => {
      alive = false;
      inFlight = false;
      controller?.abort();
      clearTimer();
      if (pollMs) {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('online', onOnline);
      }
    };
    // `fn` được đọc qua ref nên không đưa vào phụ thuộc; `gen` đổi khi `deps` đổi.
  }, [gen, pollMs]);

  const reload = useCallback(() => reloadRef.current.reload(), []);
  const refresh = useCallback(() => reloadRef.current.refresh(), []);
  const current = state.gen === gen;
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : undefined,
    loading: current ? state.loading : true,
    refreshing: current ? state.refreshing : true,
    updatedAt: current ? state.updatedAt : null,
    reload,
    refresh,
  };
}

/** Unix giây hiện tại THEO GIỜ SERVER (đã bù độ lệch đồng hồ điện thoại). */
export const nowSeconds = (): number => Math.floor(serverNow());

/**
 * "Bây giờ" theo giờ server, tự cập nhật mỗi `intervalMs` (để "5 phút trước" nhích lên) và khi quay lại app.
 * `syncKey` đổi (vd. vừa tải dữ liệu mới) thì cập nhật ngay.
 */
export function useNow(intervalMs = 30_000, syncKey?: unknown): number {
  const [now, setNow] = useState(nowSeconds);
  useEffect(() => {
    const tick = () => setNow(nowSeconds());
    tick();
    const id = setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [intervalMs, syncKey]);
  return now;
}

/** Điện thoại đang có mạng? (navigator.onLine chỉ là gợi ý: true chưa chắc tới được server). */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (notify) => {
      window.addEventListener('online', notify);
      window.addEventListener('offline', notify);
      return () => {
        window.removeEventListener('online', notify);
        window.removeEventListener('offline', notify);
      };
    },
    () => navigator.onLine !== false,
    () => true,
  );
}

/**
 * Chống bấm đúp: `run(fn)` bỏ qua nếu lần trước chưa xong. Cờ `disabled` của nút chỉ có hiệu lực sau lần render kế tiếp,
 * hai lần chạm trong cùng một khung hình vẫn lọt qua; cờ ref này thì chặn ngay lập tức.
 */
export function useSingleFlight(): <T>(fn: () => Promise<T>) => Promise<T | undefined> {
  const busy = useRef(false);
  return useCallback(async <T,>(fn: () => Promise<T>) => {
    if (busy.current) return undefined;
    busy.current = true;
    try {
      return await fn();
    } finally {
      busy.current = false;
    }
  }, []);
}
