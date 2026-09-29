// Lưới an toàn cuối cùng: nếu một màn hình gặp lỗi lập trình bất ngờ, hiện thông báo + nút tải lại
// thay vì màn hình trắng (chủ quán không biết phải làm gì với màn hình trắng).
// Không ghi log nội dung lỗi (có thể chứa dữ liệu người dùng).
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    /* cố ý không log: tránh rò dữ liệu; trạng thái lỗi đã được hiển thị */
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="auh-card auh-center" role="alert" style={{ margin: 16 }}>
        <h2>Ứng dụng gặp sự cố</h2>
        <p className="auh-muted">Xin lỗi bạn. Thiết bị của bạn vẫn đang được theo dõi bình thường. Bạn bấm nút dưới đây để mở lại nhé.</p>
        <button type="button" className="auh-btn" onClick={() => window.location.reload()}>
          Mở lại ứng dụng
        </button>
      </div>
    );
  }
}
