// Hộp báo lỗi thân thiện + nút thử lại; nếu lỗi do chưa cấp quyền Zalo thì có nút "Cho phép".
import { useState } from 'react';
import { errorMessage, needsAuth } from '../lib/errors.ts';
import { openPermissions, requestAccess } from '../sdk.ts';

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const auth = needsAuth(error);

  async function allow() {
    setBusy(true);
    try {
      await requestAccess();
      setDenied(false);
      onRetry?.();
    } catch {
      // Người dùng từ chối: hộp thoại có thể không hiện lại, hướng dẫn mở cài đặt.
      setDenied(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auh-banner auh-banner-error" role="alert">
      <div>{errorMessage(error)}</div>
      {denied && (
        <div style={{ marginTop: 8 }}>
          Bạn chưa cho phép. Hãy bật quyền cho Auhono trong phần cài đặt của Zalo rồi bấm "Thử lại".
        </div>
      )}
      <div className="auh-stack" style={{ marginTop: 12 }}>
        {auth && (
          <button type="button" className="auh-btn" onClick={allow} disabled={busy}>
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
