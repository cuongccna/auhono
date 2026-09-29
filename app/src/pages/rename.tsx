// Màn hình "Đổi tên thiết bị" (PATCH { name }). Tên được chuẩn hóa NFC (bàn phím iOS/Android có thể gửi chữ Việt dạng tổ hợp),
// bỏ ký tự vô hình/xuống dòng, cắt khoảng trắng thừa và kiểm tra 1..60 ký tự giống server.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams, useSnackbar } from 'zmp-ui';
import { api } from '../api.ts';
import { ErrorBox } from '../components/error-box.tsx';
import { Screen } from '../components/screen.tsx';
import { useAsync, useSingleFlight } from '../hooks.ts';
import { AppError } from '../lib/errors.ts';
import { NAME_MAX, validateName } from '../lib/text.ts';
import { focusSoon, useGoBack } from '../nav.ts';

export default function RenamePage() {
  const { id = '' } = useParams();
  const { openSnackbar } = useSnackbar();
  const singleFlight = useSingleFlight();
  const goBack = useGoBack(`/device/${encodeURIComponent(id)}`);

  const { data: device, error, loading, reload } = useAsync(
    async (signal) => {
      const found = (await api.listDevices({ signal })).find((d) => d.id === id);
      if (!found) throw new AppError('not_found');
      return found;
    },
    [id],
  );

  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | undefined>();
  const [saveError, setSaveError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);

  // Điền tên hiện tại một lần; tải lại không ghi đè chữ đang gõ.
  const filledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!device || filledFor.current === id) return;
    filledFor.current = id;
    setName(device.name);
  }, [device, id]);

  async function save(e: FormEvent) {
    e.preventDefault();
    await singleFlight(async () => {
      setSaveError(undefined);
      const v = validateName(name, 'Hãy đặt tên cho tủ, ví dụ "Tủ kem".');
      if (!v.ok) {
        setNameError(v.error);
        focusSoon('rename');
        return;
      }
      setNameError(undefined);
      if (device && v.value === device.name) {
        goBack();
        return;
      }
      setBusy(true);
      try {
        await api.updateDevice(id, { name: v.value });
        openSnackbar({ text: 'Đã đổi tên', type: 'success', duration: 2500 });
        goBack();
      } catch (err) {
        setSaveError(err);
      } finally {
        setBusy(false);
      }
    });
  }

  return (
    <Screen title="Đổi tên thiết bị">
      {error !== undefined && <ErrorBox error={error} onRetry={reload} />}
      {!device && loading && <p className="auh-muted auh-center">Đang tải...</p>}

      {device && (
        <form className="auh-card" onSubmit={save} noValidate>
          <div className="auh-field">
            <label htmlFor="rename">Tên tủ</label>
            <input
              id="rename"
              className="auh-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={NAME_MAX * 2}
              autoComplete="off"
              aria-invalid={!!nameError}
              aria-describedby="rename-msg"
            />
            <div id="rename-msg" className={nameError ? 'auh-error' : 'auh-help'}>
              {nameError ?? `Tối đa ${NAME_MAX} ký tự. Ví dụ "Tủ kem", "Tủ đông hải sản".`}
            </div>
          </div>
          {saveError !== undefined && (
            <ErrorBox
              error={saveError}
              focusOnShow
              onAllowed={() => {
                setSaveError(undefined);
                openSnackbar({ text: 'Đã cho phép. Bạn bấm "Lưu" lại để hoàn tất.', type: 'info', duration: 4000 });
              }}
            />
          )}
          <button type="submit" className="auh-btn" disabled={busy}>
            {busy ? 'Đang lưu...' : 'Lưu'}
          </button>
        </form>
      )}
    </Screen>
  );
}
