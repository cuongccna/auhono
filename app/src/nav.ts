// Quay lại an toàn: bấm Lưu xong thì về màn hình trước; nếu màn hình này là điểm vào đầu tiên (mở thẳng, không có lịch sử)
// thì đi tới đường dẫn dự phòng thay vì `navigate(-1)` (trong Zalo có thể đóng cả Mini App).
import { useCallback } from 'react';
import { useLocation, useNavigate } from 'zmp-ui';

export function useGoBack(fallback: string): () => void {
  const navigate = useNavigate();
  const { key } = useLocation();
  return useCallback(() => {
    if (key === 'default') navigate(fallback, { replace: true });
    else navigate(-1);
  }, [key, navigate, fallback]);
}

/** Đưa focus vào ô lỗi đầu tiên sau khi kiểm tra form (để người dùng và trình đọc màn hình biết chỗ cần sửa). */
export function focusSoon(id: string | undefined): void {
  if (!id) return;
  setTimeout(() => document.getElementById(id)?.focus(), 0);
}
