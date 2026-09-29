// Chi tiết một thiết bị: nhiệt độ hiện tại, trạng thái, biểu đồ 24 giờ, lối vào đặt ngưỡng / người nhận, gỡ thiết bị.
import { useState } from 'react';
import { Modal, useNavigate, useParams, useSnackbar } from 'zmp-ui';
import { api } from '../api.ts';
import { ErrorBox } from '../components/error-box.tsx';
import { Screen } from '../components/screen.tsx';
import { StatusBadge } from '../components/status-badge.tsx';
import { TempChart } from '../components/temp-chart.tsx';
import { nowSeconds, useAsync } from '../hooks.ts';
import { AppError } from '../lib/errors.ts';
import { formatAgo, formatTemp, formatVnDateTime } from '../lib/format.ts';
import { deviceStatus } from '../lib/status.ts';
import { KIND_LABEL } from '../lib/thresholds.ts';

const HOURS = 24;

export default function DevicePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { openSnackbar } = useSnackbar();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<unknown>(undefined);

  const { data, error, loading, reload } = useAsync(async () => {
    const [devices, readings] = await Promise.all([api.listDevices(), api.getReadings(id, HOURS)]);
    const device = devices.find((d) => d.id === id);
    if (!device) throw new AppError('not_found');
    return { device, readings };
  }, [id]);

  const now = nowSeconds();
  const device = data?.device;
  const status = device ? deviceStatus({ phase: device.phase, lastSeen: device.last_seen, nowSeconds: now }) : null;
  const enc = encodeURIComponent(id);

  async function remove() {
    setRemoving(true);
    setRemoveError(undefined);
    try {
      await api.removeDevice(id);
      setConfirmOpen(false);
      openSnackbar({ text: 'Đã gỡ thiết bị', type: 'success', duration: 3000 });
      navigate('/', { replace: true });
    } catch (e) {
      setConfirmOpen(false);
      setRemoveError(e);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Screen title={device?.name ?? 'Thiết bị'}>
      {error !== undefined && <ErrorBox error={error} onRetry={reload} />}
      {removeError !== undefined && <ErrorBox error={removeError} />}

      {device && data && status && (
        <>
          <section className="auh-card">
            <div className="auh-row-between">
              <span className="auh-muted" style={{ margin: 0 }}>{KIND_LABEL[device.kind]}</span>
              <StatusBadge status={status} />
            </div>
            <div className="auh-temp-big" style={{ margin: '4px 0' }}>
              {device.latest ? formatTemp(device.latest.temp_c) : '--'}
            </div>
            <div className="auh-muted" style={{ margin: 0 }}>
              {device.latest
                ? `Cập nhật ${formatAgo(now, device.latest.ts)} (${formatVnDateTime(device.latest.ts)})`
                : 'Thiết bị chưa gửi số đo nào. Hãy cắm điện và nối Wi-Fi cho thiết bị.'}
            </div>
            {status === 'offline' && (
              <div className="auh-banner auh-banner-warn" style={{ marginTop: 12, marginBottom: 0 }}>
                Thiết bị đã lâu không gửi số đo. Có thể tủ bị mất điện hoặc mất Wi-Fi, bạn nên đi kiểm tra.
              </div>
            )}
            {status === 'alarm' && (
              <div className="auh-banner auh-banner-error" style={{ marginTop: 12, marginBottom: 0 }}>
                Nhiệt độ đang ra ngoài ngưỡng an toàn. Hãy kiểm tra tủ ngay.
              </div>
            )}
          </section>

          <section className="auh-card">
            <div className="auh-row-between" style={{ marginBottom: 8 }}>
              <h2 style={{ margin: 0 }}>Nhiệt độ 24 giờ qua</h2>
              <button type="button" className="auh-btn auh-btn-secondary" style={{ width: 'auto' }} onClick={reload} disabled={loading}>
                {loading ? 'Đang tải' : 'Làm mới'}
              </button>
            </div>
            <TempChart points={data.readings.points} minC={device.min_c} maxC={device.max_c} nowSec={now} hours={HOURS} />
          </section>

          <section className="auh-card auh-stack">
            <div className="auh-muted" style={{ margin: 0 }}>
              Ngưỡng hiện tại: {formatTemp(device.min_c)} đến {formatTemp(device.max_c)}. Báo sau {device.breach_minutes} phút vượt ngưỡng.
            </div>
            <button type="button" className="auh-btn" onClick={() => navigate(`/device/${enc}/thresholds`)}>
              Đặt ngưỡng cảnh báo
            </button>
            <button type="button" className="auh-btn" onClick={() => navigate(`/device/${enc}/recipients`)}>
              Người nhận cảnh báo
            </button>
          </section>

          <section className="auh-card">
            <button type="button" className="auh-btn auh-btn-danger" onClick={() => setConfirmOpen(true)}>
              Gỡ thiết bị
            </button>
            <p className="auh-help">Dùng khi bạn chuyển thiết bị cho người khác hoặc không dùng nữa.</p>
          </section>

          <Modal
            visible={confirmOpen}
            unmountOnClose
            title="Gỡ thiết bị này?"
            description="Bạn sẽ không còn thấy thiết bị và danh sách người nhận cảnh báo của nó sẽ bị xóa. Bạn có chắc không?"
            onClose={() => !removing && setConfirmOpen(false)}
            actions={[
              { text: 'Không gỡ', close: true, highLight: true },
              { text: removing ? 'Đang gỡ...' : 'Gỡ thiết bị', danger: true, disabled: removing, onClick: () => void remove() },
            ]}
          />
        </>
      )}

      {!data && loading && <p className="auh-muted auh-center">Đang tải...</p>}
    </Screen>
  );
}
