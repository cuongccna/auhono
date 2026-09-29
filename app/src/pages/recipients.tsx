// Màn hình "Người nhận cảnh báo": xem, thêm (tối đa 5), xóa người nhận tin cảnh báo của một thiết bị.
import { useState, type FormEvent } from 'react';
import { Modal, useParams, useSnackbar } from 'zmp-ui';
import { api } from '../api.ts';
import { ErrorBox } from '../components/error-box.tsx';
import { Screen } from '../components/screen.tsx';
import { useAsync } from '../hooks.ts';
import { formatPhone, MAX_RECIPIENTS, validateRecipientInput } from '../lib/phone.ts';
import type { Recipient } from '../lib/schemas.ts';

export default function RecipientsPage() {
  const { id = '' } = useParams();
  const { openSnackbar } = useSnackbar();
  const { data: recipients, error, loading, reload } = useAsync(() => api.listRecipients(id), [id]);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [errors, setErrors] = useState<{ name?: string; phone?: string }>({});
  const [actionError, setActionError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const [toDelete, setToDelete] = useState<Recipient | null>(null);

  const full = (recipients?.length ?? 0) >= MAX_RECIPIENTS;

  async function add(e: FormEvent) {
    e.preventDefault();
    setActionError(undefined);
    const v = validateRecipientInput(name, phone);
    if (!v.ok) {
      setErrors({ name: v.nameError, phone: v.phoneError });
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await api.addRecipient(id, { name: v.name, phone: v.phone });
      setName('');
      setPhone('');
      openSnackbar({ text: 'Đã thêm người nhận', type: 'success', duration: 2500 });
      reload();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!toDelete) return;
    const target = toDelete;
    setBusy(true);
    setActionError(undefined);
    try {
      await api.removeRecipient(id, target.id);
      openSnackbar({ text: 'Đã xóa người nhận', type: 'success', duration: 2500 });
      reload();
    } catch (err) {
      setActionError(err);
    } finally {
      setToDelete(null);
      setBusy(false);
    }
  }

  return (
    <Screen title="Người nhận cảnh báo">
      {error !== undefined && <ErrorBox error={error} onRetry={reload} />}

      <section className="auh-card">
        <div className="auh-row-between">
          <h2 style={{ margin: 0 }}>Danh sách</h2>
          <span className="auh-muted" style={{ margin: 0 }}>{recipients?.length ?? 0}/{MAX_RECIPIENTS} người</span>
        </div>
        {!recipients && loading && <p className="auh-muted">Đang tải...</p>}
        {recipients && recipients.length === 0 && (
          <div className="auh-banner auh-banner-warn" style={{ marginTop: 12, marginBottom: 0 }}>
            Chưa có ai nhận cảnh báo. Hãy thêm số điện thoại của bạn hoặc người trông quán để nhận tin khi tủ có vấn đề.
          </div>
        )}
        {recipients?.map((r) => (
          <div key={r.id} className="auh-list-item">
            <div>
              <strong>{r.name}</strong>
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
              <input id="r-name" className="auh-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ví dụ: Vợ, Quản lý" maxLength={80} autoComplete="off" aria-invalid={!!errors.name} aria-describedby={errors.name ? 'r-name-err' : undefined} />
              {errors.name && <div id="r-name-err" className="auh-error">{errors.name}</div>}
            </div>
            <div className="auh-field">
              <label htmlFor="r-phone">Số điện thoại Zalo</label>
              <input id="r-phone" className="auh-input" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0912 345 678" maxLength={24} autoComplete="off" aria-invalid={!!errors.phone} aria-describedby="r-phone-msg" />
              <div id="r-phone-msg" className={errors.phone ? 'auh-error' : 'auh-help'}>
                {errors.phone ?? 'Số di động Việt Nam. Gõ 0912345678 hoặc +84 912 345 678 đều được.'}
              </div>
            </div>
            {actionError !== undefined && <ErrorBox error={actionError} />}
            <button type="submit" className="auh-btn" disabled={busy}>
              {busy ? 'Đang xử lý...' : 'Thêm'}
            </button>
          </>
        )}
        {full && actionError !== undefined && <ErrorBox error={actionError} />}
      </form>

      <Modal
        visible={toDelete !== null}
        unmountOnClose
        title="Xóa người nhận này?"
        description={toDelete ? `${toDelete.name} (${formatPhone(toDelete.phone)}) sẽ không còn nhận cảnh báo của thiết bị này.` : ''}
        onClose={() => setToDelete(null)}
        actions={[
          { text: 'Không xóa', close: true, highLight: true },
          { text: 'Xóa', danger: true, disabled: busy, onClick: () => void confirmDelete() },
        ]}
      />
    </Screen>
  );
}
