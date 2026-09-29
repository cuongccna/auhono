// Màn hình chính: danh sách thiết bị, nhiệt độ mới nhất và trạng thái. Tự làm mới mỗi 60 giây khi đang xem.
import { useNavigate } from 'zmp-ui';
import { api } from '../api.ts';
import { ErrorBox } from '../components/error-box.tsx';
import { AlertHelp } from '../components/help.tsx';
import { Screen } from '../components/screen.tsx';
import { StatusBadge } from '../components/status-badge.tsx';
import { isApiConfigured } from '../config.ts';
import { POLL_MS, useAsync, useNow } from '../hooks.ts';
import { formatAgo, formatTemp, formatVnTime } from '../lib/format.ts';
import { deviceNotices, NOTICE_TEXT } from '../lib/notices.ts';
import { deviceStatus, STATUS_LABEL } from '../lib/status.ts';
import { kindLabel } from '../lib/thresholds.ts';

export default function HomePage() {
  const navigate = useNavigate();
  const { data: devices, error, loading, updatedAt, reload } = useAsync((signal) => api.listDevices({ signal }), [], { pollMs: POLL_MS });
  const now = useNow(30_000, updatedAt);
  // Lần tải mới thất bại: tình trạng tính theo lúc tải cuối, KHÔNG theo giờ hiện tại
  // (nếu không, điện thoại mất mạng 20 phút sẽ làm mọi thiết bị hiện "Mất kết nối" dù chúng vẫn gửi số đo bình thường).
  const asOf = error !== undefined && updatedAt !== null ? updatedAt : now;

  return (
    <Screen title="Thiết bị của tôi" back={false} withNav>
      {!isApiConfigured && (
        <div className="auh-banner auh-banner-warn" role="alert">
          Ứng dụng chưa được cấu hình địa chỉ máy chủ (biến VITE_API_BASE). Xem app/README.md.
        </div>
      )}

      <div className="auh-row-between" style={{ marginBottom: 12 }}>
        <span className="auh-muted" style={{ margin: 0 }}>
          {loading ? 'Đang tải...' : updatedAt !== null ? `Cập nhật lúc ${formatVnTime(updatedAt)}` : 'Nhiệt độ mới nhất'}
        </span>
        <button type="button" className="auh-btn auh-btn-secondary" style={{ width: 'auto' }} onClick={reload} disabled={loading}>
          Làm mới
        </button>
      </div>

      {error !== undefined && <ErrorBox error={error} onRetry={reload} staleSince={devices ? updatedAt : null} />}

      {devices && devices.length === 0 && error === undefined && (
        <div className="auh-card auh-center">
          <h2>Bạn chưa có thiết bị nào</h2>
          <p className="auh-muted">Quét mã QR dán trên hộp thiết bị để bắt đầu theo dõi nhiệt độ tủ.</p>
          <button type="button" className="auh-btn" onClick={() => navigate('/activate')}>
            Kích hoạt thiết bị
          </button>
        </div>
      )}

      {devices?.map((d) => {
        const status = deviceStatus({ phase: d.phase, lastSeen: d.last_seen, nowSeconds: asOf });
        const notices = deviceNotices(d, status);
        return (
          <button
            key={d.id}
            type="button"
            className="auh-card auh-device"
            onClick={() => navigate(`/device/${encodeURIComponent(d.id)}`)}
            aria-label={`${d.name}, ${STATUS_LABEL[status]}, ${d.latest ? formatTemp(d.latest.temp_c) : 'chưa có số đo'}`}
          >
            <div className="auh-row-between auh-wrap">
              <strong className="auh-name">{d.name}</strong>
              <StatusBadge status={status} />
            </div>
            <div className="auh-muted">{kindLabel(d.kind)}</div>
            <div className="auh-row-between auh-wrap">
              <span className="auh-temp-big">{d.latest ? formatTemp(d.latest.temp_c) : '--'}</span>
              <span className="auh-muted" style={{ textAlign: 'right' }}>
                {d.latest ? `${status === 'offline' ? 'Số đo cuối' : 'Cập nhật'} ${formatAgo(now, d.latest.ts)}` : 'Chưa có số đo'}
              </span>
            </div>
            {notices.map((n) => (
              <div key={n} className="auh-card-note">
                <span aria-hidden="true">⚠ </span>
                {NOTICE_TEXT[n]}
              </div>
            ))}
          </button>
        );
      })}

      {devices && devices.length > 0 && <AlertHelp />}
    </Screen>
  );
}
