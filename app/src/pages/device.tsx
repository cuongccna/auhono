// Chi tiết một thiết bị: nhiệt độ hiện tại, trạng thái, biểu đồ 24 giờ (tự làm mới), cảnh báo cấu hình, lối vào
// đặt ngưỡng / người nhận / đổi tên, gỡ thiết bị.
import { useRef, useState } from 'react';
import { Modal, useNavigate, useParams, useSnackbar } from 'zmp-ui';
import { api } from '../api.ts';
import { removeDevice } from '../actions.ts';
import { ErrorBox } from '../components/error-box.tsx';
import { AlertHelp, NoticeBanner, SetupHelp } from '../components/help.tsx';
import { Screen } from '../components/screen.tsx';
import { StatusBadge } from '../components/status-badge.tsx';
import { TempChart } from '../components/temp-chart.tsx';
import { nowSeconds, POLL_MS, useAsync, useNow, useSingleFlight } from '../hooks.ts';
import {
  ackedMessage,
  canAck,
  DEFAULT_ACK_HOURS,
  DEFAULT_PAUSE_DAYS,
  formatUntil,
  isAcked,
  isPaused,
  pausedBanner,
  PAUSE_DAY_CHOICES,
  pauseWarning,
  supportsPause,
} from '../lib/alert-actions.ts';
import { outOfRangeSince } from '../lib/chart.ts';
import { AppError, errorCodeOf } from '../lib/errors.ts';
import { formatAgo, formatTemp, formatVnDateTime, formatVnTime } from '../lib/format.ts';
import { deviceNotices } from '../lib/notices.ts';
import type { Readings } from '../lib/schemas.ts';
import { deviceStatus } from '../lib/status.ts';
import { kindLabel } from '../lib/thresholds.ts';

const HOURS = 24;

export default function DevicePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { openSnackbar } = useSnackbar();
  const singleFlight = useSingleFlight();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<unknown>(undefined);
  const [pauseDays, setPauseDays] = useState<number>(DEFAULT_PAUSE_DAYS);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(undefined);
  /** Mốc "đã biết" vừa nhận từ server, hiện ngay trong lúc chờ lần tải lại. */
  const [ackedLocal, setAckedLocal] = useState<number | null>(null);
  // Biểu đồ lần trước (cùng thiết bị): lần làm mới ngầm mà chỉ phần biểu đồ lỗi thì vẫn giữ hình cũ thay vì mất.
  const lastReadings = useRef<{ id: string; readings: Readings } | null>(null);

  const { data, error, loading, updatedAt, reload, refresh } = useAsync(
    async (signal) => {
      // Danh sách thiết bị là bắt buộc; biểu đồ lỗi riêng thì vẫn hiện trạng thái (endpoint nặng hơn, dễ lỗi hơn).
      const [devices, readings] = await Promise.allSettled([api.listDevices({ signal }), api.getReadings(id, HOURS, { signal })]);
      if (devices.status === 'rejected') throw devices.reason;
      const device = devices.value.find((d) => d.id === id);
      if (!device) throw new AppError('not_found');
      let readingsError: unknown = null;
      let shown: Readings | null = null;
      let readingsStale = false;
      if (readings.status === 'fulfilled') {
        shown = readings.value;
        lastReadings.current = { id, readings: readings.value };
      } else {
        readingsError = readings.reason;
        if (lastReadings.current?.id === id) {
          shown = lastReadings.current.readings;
          readingsStale = true;
        }
      }
      return { device, readings: shown, readingsError, readingsStale };
    },
    [id],
    { pollMs: POLL_MS },
  );

  const now = useNow(30_000, updatedAt);
  // Lần tải mới thất bại: tính trạng thái theo lúc tải cuối để không kết luận "mất kết nối" chỉ vì điện thoại mất mạng.
  const asOf = error !== undefined && updatedAt !== null ? updatedAt : now;
  const device = data?.device;
  const status = device
    ? deviceStatus({ phase: device.phase, lastSeen: device.last_seen, nowSeconds: asOf, pausedUntil: device.paused_until })
    : null;
  const paused = status === 'paused';
  const ackUntil = device ? Math.max(device.acked_until ?? 0, ackedLocal ?? 0) : 0;
  const showAck = device
    ? canAck({ phase: device.phase, paused_until: device.paused_until, acked_until: device.acked_until === undefined ? undefined : ackUntil > 0 ? ackUntil : null }, asOf)
    : false;
  const acked = device ? isAcked({ acked_until: ackUntil }, asOf) && device.phase !== 'ok' && !paused : false;
  const enc = encodeURIComponent(id);
  const notices = device && status ? deviceNotices(device, status) : [];
  const since = device && status === 'alarm' && data?.readings ? outOfRangeSince(data.readings.points, device.min_c, device.max_c) : null;

  /** Chạy một thao tác ghi (ack/tạm dừng/bật lại) với chống bấm đúp; lỗi hiện trong hộp lỗi, xong thì tải lại. */
  async function act(run: () => Promise<void>) {
    await singleFlight(async () => {
      setActionBusy(true);
      setActionError(undefined);
      try {
        await run();
        refresh();
      } catch (e) {
        setActionError(e);
        if (errorCodeOf(e) === 'no_active_alert') refresh(); // sự cố đã hết: cập nhật lại màn hình
      } finally {
        setActionBusy(false);
      }
    });
  }

  const doAck = () =>
    act(async () => {
      const until = await api.ackDevice(id, DEFAULT_ACK_HOURS);
      setAckedLocal(until);
      openSnackbar({ text: ackedMessage(until, nowSeconds()), type: 'success', duration: 5000 });
    });

  const doPause = () =>
    act(async () => {
      const until = await api.pauseDevice(id, pauseDays);
      setPauseOpen(false);
      openSnackbar({ text: `Đã tạm dừng cảnh báo tới ${formatUntil(until, nowSeconds())}`, type: 'success', duration: 4000 });
    });

  const doResume = () =>
    act(async () => {
      await api.resumeDevice(id);
      openSnackbar({ text: 'Đã bật lại cảnh báo', type: 'success', duration: 3000 });
    });

  async function remove() {
    await singleFlight(async () => {
      setRemoving(true);
      setRemoveError(undefined);
      try {
        await removeDevice(api, id);
        setConfirmOpen(false);
        openSnackbar({ text: 'Đã gỡ thiết bị', type: 'success', duration: 3000 });
        navigate('/', { replace: true });
      } catch (e) {
        setConfirmOpen(false);
        setRemoveError(e);
      } finally {
        setRemoving(false);
      }
    });
  }

  return (
    <Screen title={device?.name ?? 'Thiết bị'}>
      {error !== undefined && <ErrorBox error={error} onRetry={reload} staleSince={data ? updatedAt : null} />}
      {removeError !== undefined && <ErrorBox error={removeError} focusOnShow />}
      {actionError !== undefined && <ErrorBox error={actionError} focusOnShow />}

      {device && data && status && (
        <>
          <section className="auh-card">
            <div className="auh-row-between auh-wrap">
              <span className="auh-muted" style={{ margin: 0 }}>{kindLabel(device.kind)}</span>
              <StatusBadge status={status} />
            </div>
            <div className="auh-temp-big" style={{ margin: '4px 0' }}>
              {device.latest ? formatTemp(device.latest.temp_c) : '--'}
            </div>
            <div className="auh-muted" style={{ margin: 0 }}>
              {device.latest
                ? `${status === 'offline' ? 'Số đo cuối' : 'Cập nhật'} ${formatAgo(now, device.latest.ts)} (${formatVnDateTime(device.latest.ts)})`
                : 'Thiết bị chưa gửi số đo nào.'}
            </div>

            {paused && device.paused_until != null && (
              <div className="auh-banner auh-banner-info" role="status" style={{ marginTop: 12, marginBottom: 0 }}>
                <strong>{pausedBanner(device.paused_until)}.</strong> Trong thời gian này bạn KHÔNG nhận cảnh báo nào. Cảnh báo tự bật lại lúc{' '}
                {formatUntil(device.paused_until, now)}.
                <button type="button" className="auh-btn" style={{ marginTop: 12 }} onClick={() => void doResume()} disabled={actionBusy}>
                  {actionBusy ? 'Đang xử lý...' : 'Bật lại'}
                </button>
              </div>
            )}

            {status === 'no_data' && <SetupHelp deviceId={device.id} neverSeenAlert={device.phase === 'offline'} claimedAt={device.claimed_at ?? null} />}

            {status === 'offline' && (
              <div className="auh-banner auh-banner-warn" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>
                <strong>Mất kết nối.</strong>{' '}
                {device.last_seen !== null && <>Lần cuối nhận số đo lúc {formatVnDateTime(device.last_seen)} ({formatAgo(now, device.last_seen)}). </>}
                Đây <em>chưa chắc</em> là tủ hỏng: có thể mất điện, Wi-Fi tắt hoặc đổi mật khẩu, hoặc dây đầu dò bị đứt/rút. Bạn nên đi kiểm tra tủ.
                Nhiệt độ thật trong tủ lúc này không xem được.
              </div>
            )}

            {status === 'alarm' && device.latest && (
              <div className="auh-banner auh-banner-error" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>
                <strong>Nhiệt độ đang ra ngoài ngưỡng an toàn.</strong>{' '}
                {device.latest.temp_c > device.max_c
                  ? `Tủ đang nóng hơn mức cao nhất (${formatTemp(device.max_c)})`
                  : device.latest.temp_c < device.min_c
                    ? `Tủ đang lạnh hơn mức thấp nhất (${formatTemp(device.min_c)})`
                    : 'Nhiệt độ vừa trở lại trong ngưỡng nhưng chưa đủ lâu để báo là đã ổn'}
                {since ? `, từ khoảng ${formatVnTime(since.since)}${since.entireWindow ? ' hoặc sớm hơn' : ''}` : ''}. Hãy kiểm tra tủ ngay.
              </div>
            )}

            {status === 'unknown' && (
              <div className="auh-banner auh-banner-info" style={{ marginTop: 12, marginBottom: 0 }}>
                Chưa rõ tình trạng của thiết bị này. Bạn thử làm mới, hoặc cập nhật ứng dụng Zalo.
              </div>
            )}

            {showAck && (
              <div style={{ marginTop: 12 }}>
                <button type="button" className="auh-btn" onClick={() => void doAck()} disabled={actionBusy}>
                  {actionBusy ? 'Đang xử lý...' : 'Đã biết, đang xử lý'}
                </button>
                <p className="auh-help">Bấm khi bạn đã biết sự cố và đang xử lý: hệ thống ngừng nhắc lại trong {DEFAULT_ACK_HOURS} giờ (đỡ tốn tin nhắn).</p>
              </div>
            )}
            {acked && (
              <div className="auh-banner auh-banner-info" role="status" style={{ marginTop: 12, marginBottom: 0 }}>
                {ackedMessage(ackUntil, now)}
              </div>
            )}

            {notices.map((n) => (
              <NoticeBanner
                key={n}
                kind={n}
                onFix={n === 'no_recipients' || n === 'notify_failed' ? () => navigate(`/device/${enc}/recipients`) : undefined}
              />
            ))}
          </section>

          <section className="auh-card">
            <div className="auh-row-between auh-wrap" style={{ marginBottom: 8 }}>
              <h2 style={{ margin: 0 }}>Nhiệt độ {HOURS} giờ qua</h2>
              <button type="button" className="auh-btn auh-btn-secondary" style={{ width: 'auto' }} onClick={reload} disabled={loading}>
                {loading ? 'Đang tải' : 'Làm mới'}
              </button>
            </div>
            {data.readingsError !== null && (
              <ErrorBox error={data.readingsError} onRetry={reload} staleSince={data.readingsStale ? updatedAt : null} />
            )}
            {data.readings && (
              <TempChart points={data.readings.points} minC={device.min_c} maxC={device.max_c} nowSec={asOf} hours={HOURS} />
            )}
            {!data.readings && data.readingsError === null && <p className="auh-muted">Chưa có biểu đồ.</p>}
          </section>

          <section className="auh-card auh-stack">
            <div className="auh-muted" style={{ margin: 0 }}>
              Ngưỡng hiện tại: {formatTemp(device.min_c)} đến {formatTemp(device.max_c)}. Báo sau {device.breach_minutes} phút vượt ngưỡng liên tục.
            </div>
            <button type="button" className="auh-btn" onClick={() => navigate(`/device/${enc}/thresholds`)}>
              Đặt ngưỡng cảnh báo
            </button>
            <button type="button" className="auh-btn" onClick={() => navigate(`/device/${enc}/recipients`)}>
              Người nhận cảnh báo
            </button>
            <button type="button" className="auh-btn auh-btn-secondary" onClick={() => navigate(`/device/${enc}/rename`)}>
              Đổi tên thiết bị
            </button>
          </section>

          <section className="auh-card">
            <AlertHelp breachMinutes={device.breach_minutes} />
          </section>

          {supportsPause(device) && !paused && (
            <section className="auh-card">
              <h2>Tạm dừng cảnh báo</h2>
              <p className="auh-muted">
                Dùng khi quán nghỉ (như Tết), chuyển tủ hoặc bạn cố ý rút điện thiết bị: không cảnh báo, không tin nhắn. Trong thời gian này bạn
                sẽ <strong>KHÔNG</strong> nhận cảnh báo.
              </p>
              <div className="auh-days" role="group" aria-label="Số ngày tạm dừng">
                {PAUSE_DAY_CHOICES.map((d) => (
                  <button key={d} type="button" className="auh-choice auh-day" aria-pressed={pauseDays === d} onClick={() => setPauseDays(d)}>
                    <strong>{d}</strong>
                    <small>ngày</small>
                  </button>
                ))}
              </div>
              <button type="button" className="auh-btn auh-btn-secondary" style={{ marginTop: 12 }} onClick={() => setPauseOpen(true)} disabled={actionBusy}>
                Tạm dừng cảnh báo
              </button>
            </section>
          )}

          <section className="auh-card">
            <button type="button" className="auh-btn auh-btn-danger" onClick={() => setConfirmOpen(true)}>
              Gỡ thiết bị
            </button>
            <p className="auh-help">Dùng khi bạn chuyển thiết bị cho người khác hoặc không dùng nữa. Mỗi thiết bị chỉ thuộc một tài khoản Zalo.</p>
          </section>

          <Modal
            visible={pauseOpen}
            unmountOnClose
            title="Tạm dừng cảnh báo?"
            description={pauseWarning(pauseDays, now)}
            onClose={() => !actionBusy && setPauseOpen(false)}
            actions={[
              { text: 'Không', close: true, highLight: true },
              { text: actionBusy ? 'Đang xử lý...' : `Tạm dừng ${pauseDays} ngày`, danger: true, disabled: actionBusy, onClick: () => void doPause() },
            ]}
          />

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
