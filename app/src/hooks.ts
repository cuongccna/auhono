// Hook dùng chung.
import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * Chạy một hàm bất đồng bộ khi vào màn hình / đổi `deps`, và khi gọi `reload()`.
 * Giữ dữ liệu cũ khi tải lại (không nhấp nháy); bỏ qua kết quả về muộn sau khi rời màn hình.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({
    data: undefined,
    error: undefined,
    loading: true,
  });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, error: undefined, loading: true }));
    fnRef.current().then(
      (data) => alive && setState({ data, error: undefined, loading: false }),
      (error: unknown) => alive && setState((s) => ({ ...s, error, loading: false })),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

/** Unix giây hiện tại (đổi theo mỗi lần render; đủ cho hiển thị "x phút trước"). */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
