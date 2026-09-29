// Hộp báo lỗi thân thiện + nút thử lại; nếu lỗi do chưa cấp quyền Zalo thì có nút "Cho phép".
// Không làm mất dữ liệu người dùng đã nhập: hộp này chỉ hiện thêm, không thay/đặt lại form bên dưới.
import { useEffect, useRef, useState } from 'react';
import { nowSeconds } from '../hooks.ts';
import { errorMessage, isAborted, needsAuth } from '../lib/errors.ts';
import { formatAgo, formatVnDateTime } from '../lib/format.ts';
import { getToken, openPermissions, requestAccess } from '../sdk.ts';

export interface ErrorBoxProps {
  error: unknown;
  /** Bấm "Thử lại" (tải lại). Không truyền thì không có nút. */
  onRetry?: () => void;
  /** Sau khi người dùng vừa cho phép thành công. Mặc định gọi onRetry. Form dùng để xóa lỗi và nhắc bấm lại. */
  onAllowed?: () => void;
  /** Đang hiện dữ liệu CŨ (giờ server, Unix giây) vì lần tải mới thất bại: nói rõ để chủ quán không tưởng là số mới. */
  staleSince?: number | null;
  /** Đưa focus vào hộp (cho lỗi sau khi bấm nút gửi, giúp người dùng đọc màn hình biết có lỗi). */
  focusOnShow?: boolean;
}

export function ErrorBox({ error, onRetry, onAllowed, staleSince, focusOnShow }: ErrorBoxProps) {
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const auth = needsAuth(error);
  const afterAllowed = onAllowed ?? onRetry;
  const afterAllowedRef = useRef(afterAllowed);
  afterAllowedRef.current = afterAllowed;

  // Lỗi mới hiện ra: cuộn tới và (nếu được yêu cầu) đưa focus vào để trình đọc màn hình đọc ngay.
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !focusOnShow) return;
    el.scrollIntoView?.({ block: 'nearest' });
    el.focus({ preventScroll: true });
  }, [error, focusOnShow]);

  // Người dùng bật quyền trong Cài đặt rồi quay lại app: tự thử lại thay vì bắt bấm nút.
  useEffect(() => {
    if (!auth) return;
    const onVisible = () => {
      if (document.visibilityState === 'hidden') return;
      void getToken().then(
        (t) => t && afterAllowedRef.current?.(),
        () => undefined,
      );
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [auth]);

  if (isAborted(error)) return null;

  async function allow() {
    setBusy(true);
    try {
      await requestAccess();
      setDenied(false);
      afterAllowed?.();
    } catch {
      // Người dùng từ chối: hộp thoại có thể không hiện lại, hướng dẫn mở cài đặt.
      setDenied(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={boxRef} className="auh-banner auh-banner-error" role="alert" tabIndex={-1}>
      <div>{errorMessage(error)}</div>
      {staleSince != null && (
        <div style={{ marginTop: 8 }}>
          Đang hiện số liệu lúc {formatVnDateTime(staleSince)} ({formatAgo(nowSeconds(), staleSince)}). Tình trạng thật của tủ có thể đã khác.
        </div>
      )}
      {denied && (
        <div style={{ marginTop: 8 }}>
          Bạn chưa cho phép. Hãy bật quyền cho Auhono trong phần cài đặt của Zalo rồi quay lại đây, ứng dụng sẽ tự thử lại.
        </div>
      )}
      <div className="auh-stack" style={{ marginTop: 12 }}>
        {auth && (
          <button type="button" className="auh-btn" onClick={() => void allow()} disabled={busy}>
            {busy ? 'Đang xin phép...' : 'Cho phép'}
          </button>
        )}
        {auth && denied && (
          <button type="button" className="auh-btn auh-btn-secondary" onClick={() => void openPermissions()}>
            Mở cài đặt quyền
          </button>
        )}
        {onRetry && (
          <button type="button" className="auh-btn auh-btn-secondary" onClick={onRetry}>
            Thử lại
          </button>
        )}
      </div>
    </div>
  );
}
