// Màn hình chính: danh sách thiết bị, nhiệt độ mới nhất và trạng thái.
import { useNavigate } from 'zmp-ui';
import { api } from '../api.ts';
import { ErrorBox } from '../components/error-box.tsx';
import { Screen } from '../components/screen.tsx';
import { StatusBadge } from '../components/status-badge.tsx';
import { isApiConfigured } from '../config.ts';
import { nowSeconds, useAsync } from '../hooks.ts';
import { formatAgo, formatTemp } from '../lib/format.ts';
import { deviceStatus } from '../lib/status.ts';
import { KIND_LABEL } from '../lib/thresholds.ts';

export default function HomePage() {
  const navigate = useNavigate();
  const { data: devices, error, loading, reload } = useAsync(() => api.listDevices(), []);
  const now = nowSeconds();

  return (
    <Screen title="Thiết bị của tôi" back={false} withNav>
      {!isApiConfigured && (
        <div className="auh-banner auh-banner-warn" role="alert">
          Ứng dụng chưa được cấu hình địa chỉ máy chủ (biến VITE_API_BASE). Xem app/README.md.
        </div>
      )}

      <div className="auh-row-between" style={{ marginBottom: 12 }}>
        <span className="auh-muted" style={{ margin: 0 }}>
          {loading ? 'Đang tải...' : 'Nhiệt độ mới nhất'}
        </span>
        <button type="button" className="auh-btn auh-btn-secondary" style={{ width: 'auto' }} onClick={reload} disabled={loading}>
          Làm mới
        </button>
      </div>

      {error !== undefined && <ErrorBox error={error} onRetry={reload} />}

      {devices && devices.length === 0 && !error && (
        <div className="auh-card auh-center">
          <h2>Bạn chưa có thiết bị nào</h2>
          <p className="auh-muted">Quét mã QR dán trên hộp thiết bị để bắt đầu theo dõi nhiệt độ tủ.</p>
          <button type="button" className="auh-btn" onClick={() => navigate('/activate')}>
            Kích hoạt thiết bị
          </button>
        </div>
      )}

      {devices?.map((d) => {
        const status = deviceStatus({ phase: d.phase, lastSeen: d.last_seen, nowSeconds: now });
        return (
          <button
            key={d.id}
            type="button"
            className="auh-card auh-device"
            onClick={() => navigate(`/device/${encodeURIComponent(d.id)}`)}
            aria-label={`${d.name}, ${d.latest ? formatTemp(d.latest.temp_c) : 'chưa có số đo'}`}
          >
            <div className="auh-row-between">
              <strong style={{ fontSize: 18 }}>{d.name}</strong>
              <StatusBadge status={status} />
            </div>
            <div className="auh-muted">{KIND_LABEL[d.kind]}</div>
            <div className="auh-row-between">
              <span className="auh-temp-big">{d.latest ? formatTemp(d.latest.temp_c) : '--'}</span>
              <span className="auh-muted" style={{ textAlign: 'right' }}>
                {d.latest ? `Cập nhật ${formatAgo(now, d.latest.ts)}` : 'Chưa có số đo'}
              </span>
            </div>
          </button>
        );
      })}
    </Screen>
  );
}
