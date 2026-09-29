// Màn hình "Người nhận cảnh báo": xem, thêm (tối đa 5), xóa người nhận tin cảnh báo của một thiết bị.
// Nhắc rõ: người nhận cần có Zalo; xóa người cuối cùng nghĩa là sẽ không còn tin nào được gửi.
import { useState, type FormEvent } from 'react';
import { Modal, useParams, useSnackbar } from 'zmp-ui';
import { api } from '../api.ts';
import { addRecipient } from '../actions.ts';
import { ErrorBox } from '../components/error-box.tsx';
import { NoticeBanner } from '../components/help.tsx';
import { Screen } from '../components/screen.tsx';
import { useAsync, useSingleFlight } from '../hooks.ts';
import { formatPhone, MAX_RECIPIENTS, validateRecipientInput } from '../lib/phone.ts';
import type { Recipient } from '../lib/schemas.ts';
import { focusSoon } from '../nav.ts';

export default function RecipientsPage() {
  const { id = '' } = useParams();
  const { openSnackbar } = useSnackbar();
  const singleFlight = useSingleFlight();

  const { data, error, loading, reload, refresh } = useAsync(
    async (signal) => {
      // Danh sách người nhận là bắt buộc; thông tin thiết bị (để hiện "gửi tin lỗi") chỉ là phụ, lỗi cũng bỏ qua.
      const [recipients, devices] = await Promise.allSettled([api.listRecipients(id, { signal }), api.listDevices({ signal })]);
      if (recipients.status === 'rejected') throw recipients.reason;
      const device = devices.status === 'fulfilled' ? devices.value.find((d) => d.id === id) : undefined;
      return { recipients: recipients.value, notifyFailures: device?.notify_failures_24h ?? 0 };
    },
    [id],
  );
  const recipients = data?.recipients;

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [errors, setErrors] = useState<{ name?: string; phone?: string }>({});
  const [actionError, setActionError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const [toDelete, setToDelete] = useState<Recipient | null>(null);

  const full = (recipients?.length ?? 0) >= MAX_RECIPIENTS;
  const onAllowed = () => {
    setActionError(undefined);
    openSnackbar({ text: 'Đã cho phép. Bạn bấm lại nút để hoàn tất.', type: 'info', duration: 4000 });
  };

  async function add(e: FormEvent) {
    e.preventDefault();
    await singleFlight(async () => {
      setActionError(undefined);
      const v = validateRecipientInput(name, phone);
      if (!v.ok) {
        setErrors({ name: v.nameError, phone: v.phoneError });
        focusSoon(v.nameError ? 'r-name' : 'r-phone');
        return;
      }
      const dup = recipients?.find((r) => r.phone === v.phone);
      if (dup) {
        setErrors({ phone: `Số này đã có trong danh sách (${dup.name}).` });
        focusSoon('r-phone');
        return;
      }
      setErrors({});
      setBusy(true);
      try {
        await addRecipient(api, id, { name: v.name, phone: v.phone });
        setName('');
        setPhone('');
        openSnackbar({ text: 'Đã thêm người nhận', type: 'success', duration: 2500 });
        refresh();
      } catch (err) {
        setActionError(err);
      } finally {
        setBusy(false);
      }
    });
  }

  async function confirmDelete() {
    if (!toDelete) return;
    const target = toDelete;
    await singleFlight(async () => {
      setBusy(true);
      setActionError(undefined);
      try {
        await api.removeRecipient(id, target.id);
        const wasLast = (recipients?.length ?? 0) <= 1;
        openSnackbar({
          text: wasLast ? 'Đã xóa. Hiện không còn ai nhận cảnh báo, sẽ không có tin nhắn nào được gửi.' : 'Đã xóa người nhận',
          type: wasLast ? 'warning' : 'success',
          duration: wasLast ? 5000 : 2500,
        });
        refresh();
      } catch (err) {
        setActionError(err);
      } finally {
        setToDelete(null);
        setBusy(false);
      }
    });
  }

  const isLast = (recipients?.length ?? 0) === 1;

  return (
    <Screen title="Người nhận cảnh báo">
      {error !== undefined && <ErrorBox error={error} onRetry={reload} />}
      {(data?.notifyFailures ?? 0) > 0 && <NoticeBanner kind="notify_failed" />}

      <section className="auh-card">
        <div className="auh-row-between">
          <h2 style={{ margin: 0 }}>Danh sách</h2>
          <span className="auh-muted" style={{ margin: 0 }}>{recipients?.length ?? 0}/{MAX_RECIPIENTS} người</span>
        </div>
        {!recipients && loading && <p className="auh-muted">Đang tải...</p>}
        {recipients && recipients.length === 0 && (
          <div className="auh-banner auh-banner-warn" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>
            <strong>Chưa có người nhận cảnh báo — sẽ không có tin nhắn nào được gửi.</strong> Hãy thêm số điện thoại của bạn hoặc người trông quán.
          </div>
        )}
        {recipients?.map((r, index) => (
          <div key={r.id} className="auh-list-item">
            <div className="auh-grow">
              <strong className="auh-name">{r.name}</strong>
              {index === 0 && <span className="auh-tag">Người nhận chính</span>}
              <div className="auh-muted" style={{ margin: 0 }}>{formatPhone(r.phone)}</div>
            </div>
            <button
              type="button"
              className="auh-btn auh-btn-danger"
              style={{ width: 'auto' }}
              onClick={() => setToDelete(r)}
              aria-label={`Xóa ${r.name}`}
            >
              Xóa
            </button>
          </div>
        ))}
        {recipients && recipients.length > 0 && (
          <p className="auh-help">
            <strong>Người đầu tiên trong danh sách nhận cả tin nhắc lại; những người khác chỉ nhận tin báo đầu và tin đã ổn.</strong> Muốn đổi người nhận chính,
            hãy xóa người đầu rồi thêm lại người đó (sẽ nằm cuối danh sách).
          </p>
        )}
        <p className="auh-help">
          Tin cảnh báo gửi qua Zalo tới số điện thoại này, nên người nhận cần có Zalo dùng đúng số đó. Tin có thể không tới nếu họ đã chặn tài khoản Auhono.
          Bạn nên thêm cả số của chính mình. Mỗi thiết bị chỉ thuộc một tài khoản Zalo; người nhà muốn nhận cảnh báo thì thêm số của họ ở đây.
        </p>
      </section>

      <form className="auh-card" onSubmit={add} noValidate>
        <h2>Thêm người nhận</h2>
        {full ? (
          <div className="auh-banner auh-banner-info" style={{ marginBottom: 0 }}>
            Đã đủ {MAX_RECIPIENTS} người. Hãy xóa bớt một người nếu muốn thêm người mới.
          </div>
        ) : (
          <>
            <div className="auh-field">
              <label htmlFor="r-name">Tên</label>
              <input id="r-name" className="auh-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ví dụ: Vợ, Quản lý" maxLength={120} autoComplete="off" aria-invalid={!!errors.name} aria-describedby={errors.name ? 'r-name-err' : undefined} />
              {errors.name && <div id="r-name-err" className="auh-error">{errors.name}</div>}
            </div>
            <div className="auh-field">
              <label htmlFor="r-phone">Số điện thoại Zalo</label>
              <input id="r-phone" className="auh-input" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0912 345 678" maxLength={30} autoComplete="off" aria-invalid={!!errors.phone} aria-describedby="r-phone-msg" />
              <div id="r-phone-msg" className={errors.phone ? 'auh-error' : 'auh-help'}>
                {errors.phone ?? 'Số di động Việt Nam. Gõ 0912345678 hoặc +84 912 345 678 đều được.'}
              </div>
            </div>
            {actionError !== undefined && <ErrorBox error={actionError} focusOnShow onAllowed={onAllowed} />}
            <button type="submit" className="auh-btn" disabled={busy}>
              {busy ? 'Đang xử lý...' : 'Thêm'}
            </button>
          </>
        )}
        {full && actionError !== undefined && <ErrorBox error={actionError} focusOnShow onAllowed={onAllowed} />}
      </form>

      <Modal
        visible={toDelete !== null}
        unmountOnClose
        title="Xóa người nhận này?"
        description={
          toDelete
            ? `${toDelete.name} (${formatPhone(toDelete.phone)}) sẽ không còn nhận cảnh báo của thiết bị này.${
                isLast ? ' Đây là người nhận cuối cùng: xóa xong sẽ KHÔNG còn ai nhận tin nhắn cảnh báo.' : ''
              }`
            : ''
        }
        onClose={() => setToDelete(null)}
        actions={[
          { text: 'Không xóa', close: true, highLight: true },
          { text: 'Xóa', danger: true, disabled: busy, onClick: () => void confirmDelete() },
        ]}
      />
    </Screen>
  );
}
