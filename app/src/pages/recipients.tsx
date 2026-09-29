// Màn hình "Người nhận cảnh báo": xem, thêm (tối đa 5), xóa người nhận tin cảnh báo của một thiết bị.
// Nhắc rõ: người nhận cần có Zalo; xóa người cuối cùng nghĩa là sẽ không còn tin nào được gửi.
import { useEffect, useState, type FormEvent } from 'react';
import { Modal, useParams, useSnackbar } from 'zmp-ui';
import { api } from '../api.ts';
import { addRecipient } from '../actions.ts';
import { ErrorBox } from '../components/error-box.tsx';
import { NoticeBanner } from '../components/help.tsx';
import { TelegramRow, type PendingLink } from '../components/telegram-row.tsx';
import { Screen } from '../components/screen.tsx';
import { useAsync, useSingleFlight } from '../hooks.ts';
import { formatPhone, MAX_RECIPIENTS, validateRecipientInput } from '../lib/phone.ts';
import type { Recipient } from '../lib/schemas.ts';
import { TELEGRAM_HELP, TELEGRAM_ONLY_WARNING, type RecipientMode } from '../lib/telegram.ts';
import { focusSoon } from '../nav.ts';

export default function RecipientsPage() {
  const { id = '' } = useParams();
  const { openSnackbar } = useSnackbar();
  const singleFlight = useSingleFlight();

  const { data, error, loading, reload, refresh } = useAsync(
    async (signal) => {
      // Danh sách người nhận là bắt buộc; thông tin thiết bị (để hiện "gửi tin lỗi") chỉ là phụ, lỗi cũng bỏ qua.
      const [recipients, devices] = await Promise.allSettled([api.getRecipients(id, { signal }), api.listDevices({ signal })]);
      if (recipients.status === 'rejected') throw recipients.reason;
      const device = devices.status === 'fulfilled' ? devices.value.find((d) => d.id === id) : undefined;
      return {
        recipients: recipients.value.recipients,
        telegramAvailable: recipients.value.telegram_available,
        notifyFailures: device?.notify_failures_24h ?? 0,
      };
    },
    [id],
  );
  const recipients = data?.recipients;
  const telegramAvailable = data?.telegramAvailable === true; // vắng mặt (server cũ) => ẩn mọi giao diện Telegram

  // Liên kết Telegram vừa tạo (chỉ giữ trong bộ nhớ của màn hình này, KHÔNG lưu, KHÔNG log: mã trong liên kết là bí mật dùng một lần).
  const [links, setLinks] = useState<Record<number, PendingLink>>({});
  const [tgError, setTgError] = useState<unknown>(undefined);
  const [modeConfirm, setModeConfirm] = useState<Recipient | null>(null);
  const [unlinkConfirm, setUnlinkConfirm] = useState<Recipient | null>(null);
  const hasPendingLink = Object.keys(links).length > 0;

  // Sau khi người nhận bấm Start trong Telegram, chủ quán quay lại app: tự làm mới để thấy "Đã kết nối".
  useEffect(() => {
    if (!hasPendingLink) return;
    const onVisible = () => document.visibilityState !== 'hidden' && refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [hasPendingLink, refresh]);

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

  /** Thao tác Telegram với chống bấm đúp; lỗi hiện trong hộp lỗi riêng, xong thì tải lại danh sách. */
  async function tgAct(run: () => Promise<void>) {
    await singleFlight(async () => {
      setBusy(true);
      setTgError(undefined);
      try {
        await run();
        refresh();
      } catch (err) {
        setTgError(err);
        refresh(); // vd. 409 telegram_not_linked: người nhận vừa ngắt kết nối, cập nhật lại trạng thái
      } finally {
        setBusy(false);
      }
    });
  }

  const createLink = (r: Recipient) =>
    tgAct(async () => {
      const link = await api.createTelegramLink(id, r.id);
      setLinks((m) => ({ ...m, [r.id]: { url: link.url, expiresAt: link.expires_at } }));
    });

  const changeMode = (r: Recipient, mode: RecipientMode) =>
    tgAct(async () => {
      await api.setRecipientMode(id, r.id, mode);
      openSnackbar({ text: 'Đã đổi kênh nhận tin', type: 'success', duration: 2500 });
    });

  const unlink = (r: Recipient) =>
    tgAct(async () => {
      await api.unlinkTelegram(id, r.id);
      setLinks((m) => {
        const { [r.id]: _gone, ...rest } = m;
        return rest;
      });
      openSnackbar({ text: 'Đã ngắt kết nối Telegram', type: 'success', duration: 2500 });
    });

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
        {tgError !== undefined && <ErrorBox error={tgError} focusOnShow />}
        {recipients?.map((r, index) => (
          <div key={r.id}>
          <div className="auh-list-item">
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
          {telegramAvailable && (
            <TelegramRow
              recipient={r}
              link={links[r.id] ?? null}
              busy={busy}
              onCreateLink={() => void createLink(r)}
              onSetMode={(mode) => (mode === 'telegram' ? setModeConfirm(r) : void changeMode(r, mode))}
              onUnlink={() => setUnlinkConfirm(r)}
              onRefresh={refresh}
              onCloseLink={() => setLinks((m) => { const { [r.id]: _gone, ...rest } = m; return rest; })}
            />
          )}
          </div>
        ))}
        {telegramAvailable && recipients && recipients.length > 0 && <p className="auh-help">{TELEGRAM_HELP}</p>}
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
        visible={modeConfirm !== null}
        unmountOnClose
        title="Chỉ nhận tin qua Telegram?"
        description={TELEGRAM_ONLY_WARNING}
        onClose={() => setModeConfirm(null)}
        actions={[
          { text: 'Không', close: true, highLight: true },
          {
            text: 'Chỉ Telegram',
            danger: true,
            disabled: busy,
            onClick: () => {
              const r = modeConfirm;
              setModeConfirm(null);
              if (r) void changeMode(r, 'telegram');
            },
          },
        ]}
      />

      <Modal
        visible={unlinkConfirm !== null}
        unmountOnClose
        title="Ngắt kết nối Telegram?"
        description={
          unlinkConfirm
            ? `${unlinkConfirm.name} sẽ không nhận tin qua Telegram nữa và chỉ nhận tin qua Zalo. Bạn có thể kết nối lại bất cứ lúc nào.`
            : ''
        }
        onClose={() => setUnlinkConfirm(null)}
        actions={[
          { text: 'Không', close: true, highLight: true },
          {
            text: 'Ngắt kết nối',
            danger: true,
            disabled: busy,
            onClick: () => {
              const r = unlinkConfirm;
              setUnlinkConfirm(null);
              if (r) void unlink(r);
            },
          },
        ]}
      />

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
