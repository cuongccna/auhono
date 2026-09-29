// Màn hình "Kích hoạt": quét QR trên hộp (hoặc nhập tay), chọn loại tủ, đặt tên, gắn thiết bị vào tài khoản.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSnackbar } from 'zmp-ui';
import { api } from '../api.ts';
import { claimDevice } from '../actions.ts';
import { ErrorBox } from '../components/error-box.tsx';
import { Screen } from '../components/screen.tsx';
import { useSingleFlight } from '../hooks.ts';
import { isAppError } from '../lib/errors.ts';
import { parseClaimQr, validateManualClaim, type QrParseResult } from '../lib/qr.ts';
import { NAME_MAX, validateName } from '../lib/text.ts';
import { KIND_LABEL, KIND_PRESETS, type Kind } from '../lib/thresholds.ts';
import { focusSoon } from '../nav.ts';
import { askCameraPermission, openPermissions, scanQr } from '../sdk.ts';

const QR_PROBLEM: Record<Exclude<QrParseResult, { ok: true }>['reason'], string> = {
  empty: 'Chưa đọc được mã QR. Bạn thử quét lại, hoặc nhập mã tay bên dưới nhé.',
  not_auhono: 'Đây không phải mã QR của thiết bị Auhono. Hãy quét mã dán trên hộp thiết bị.',
  malformed: 'Mã QR này không đúng định dạng. Bạn nhập mã tay bên dưới giúp nhé.',
};

/** Sau khi bị khóa vì nhập sai nhiều lần (429), tạm chặn nút gửi ngần này giây để khỏi bấm dồn. */
const LOCKOUT_SECONDS = 30;

export default function ActivatePage() {
  const navigate = useNavigate();
  const { openSnackbar } = useSnackbar();
  const singleFlight = useSingleFlight();

  const [rawId, setRawId] = useState('');
  const [rawCode, setRawCode] = useState('');
  const [kind, setKind] = useState<Kind>('freezer');
  const [name, setName] = useState(KIND_LABEL.freezer);
  const [nameTouched, setNameTouched] = useState(false);

  const [scanNote, setScanNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [cameraDenied, setCameraDenied] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [errors, setErrors] = useState<{ id?: string; code?: string; name?: string }>({});
  const [submitError, setSubmitError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [, forceTick] = useState(0);

  // Đếm ngược thời gian khóa để nút tự mở lại.
  const lockTimer = useRef<ReturnType<typeof setTimeout> | undefined>();
  useEffect(() => () => clearTimeout(lockTimer.current), []);
  const locked = lockedUntil > Date.now();

  function applyScan(content: string) {
    const parsed = parseClaimQr(content);
    if (!parsed.ok) {
      setScanNote({ text: QR_PROBLEM[parsed.reason], ok: false });
      return;
    }
    setRawId(parsed.deviceId);
    setRawCode(parsed.code);
    setErrors({});
    setScanNote({ text: `Đã quét thiết bị ${parsed.deviceId}. Chọn loại tủ rồi bấm "Kích hoạt".`, ok: true });
  }

  async function scan() {
    if (scanning) return; // chống mở camera hai lần
    setScanning(true);
    setScanNote(null);
    setCameraDenied(false);
    try {
      const result = await scanQr();
      if (result.status === 'camera_denied') {
        setCameraDenied(true);
        setScanNote({ text: 'Auhono chưa được phép dùng camera. Bạn bấm "Cho phép camera", hoặc nhập mã tay bên dưới.', ok: false });
      } else if (result.status === 'cancelled') {
        setScanNote({ text: 'Chưa quét được mã. Bạn thử lại hoặc nhập mã tay nhé.', ok: false });
      } else {
        applyScan(result.content);
      }
    } finally {
      setScanning(false);
    }
  }

  async function allowCamera() {
    if (await askCameraPermission()) {
      setCameraDenied(false);
      await scan();
    } else {
      void openPermissions();
    }
  }

  function chooseKind(k: Kind) {
    setKind(k);
    if (!nameTouched) setName(KIND_LABEL[k]);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (locked) return;
    await singleFlight(async () => {
      setSubmitError(undefined);

      const claim = validateManualClaim(rawId, rawCode);
      const nameCheck = validateName(name, 'Hãy đặt tên cho tủ, ví dụ "Tủ kem".');
      if (!claim.ok || !nameCheck.ok) {
        const next = {
          id: claim.ok ? undefined : claim.idError,
          code: claim.ok ? undefined : claim.codeError,
          name: nameCheck.ok ? undefined : nameCheck.error,
        };
        setErrors(next);
        focusSoon(next.id ? 'device-id' : next.code ? 'code' : 'name');
        return;
      }
      setErrors({});

      setBusy(true);
      try {
        // Bấm lại sau khi mất phản hồi vẫn an toàn: server trả 200 cho chính chủ, và claimDevice tự kiểm tra danh sách khi không rõ kết quả.
        await claimDevice(api, { device_id: claim.deviceId, code: claim.code, name: nameCheck.value, kind });
        openSnackbar({ text: 'Đã kích hoạt thiết bị', type: 'success', duration: 3000 });
        // Thêm người nhận ngay, vì chưa có ai nhận thì sẽ không có tin cảnh báo nào được gửi.
        navigate(`/device/${encodeURIComponent(claim.deviceId)}/recipients`, { replace: true });
      } catch (err) {
        setSubmitError(err);
        if (isAppError(err) && (err.code === 'too_many_attempts' || err.code === 'rate_limited')) {
          setLockedUntil(Date.now() + LOCKOUT_SECONDS * 1000);
          clearTimeout(lockTimer.current);
          lockTimer.current = setTimeout(() => forceTick((n) => n + 1), LOCKOUT_SECONDS * 1000 + 50);
        }
      } finally {
        setBusy(false);
      }
    });
  }

  return (
    <Screen title="Kích hoạt thiết bị" back={false} withNav>
      <form onSubmit={submit} noValidate>
        <section className="auh-card">
          <h2>Bước 1. Quét mã trên hộp</h2>
          <p className="auh-muted">Mở camera và hướng vào mã QR dán trên hộp thiết bị.</p>
          <button type="button" className="auh-btn" onClick={() => void scan()} disabled={scanning}>
            {scanning ? 'Đang mở camera...' : 'Quét mã QR'}
          </button>
          {scanNote && (
            <div className={`auh-banner ${scanNote.ok ? 'auh-banner-info' : 'auh-banner-warn'}`} style={{ marginTop: 12, marginBottom: 0 }} role="status">
              {scanNote.text}
            </div>
          )}
          {cameraDenied && (
            <div className="auh-stack" style={{ marginTop: 12 }}>
              <button type="button" className="auh-btn" onClick={() => void allowCamera()}>
                Cho phép camera
              </button>
              <button type="button" className="auh-btn auh-btn-secondary" onClick={() => void openPermissions()}>
                Mở cài đặt quyền
              </button>
            </div>
          )}

          <details className="auh-details" open={!!errors.id || !!errors.code || undefined} style={{ marginTop: 8 }}>
            <summary>Không quét được? Nhập mã tay</summary>
            <div className="auh-field">
              <label htmlFor="device-id">Mã thiết bị</label>
              <input
                id="device-id"
                className="auh-input"
                value={rawId}
                onChange={(e) => setRawId(e.target.value)}
                placeholder="AUH-000001"
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                maxLength={130}
                aria-invalid={!!errors.id}
                aria-describedby={errors.id ? 'device-id-err' : undefined}
              />
              {errors.id && <div id="device-id-err" className="auh-error">{errors.id}</div>}
            </div>
            <div className="auh-field">
              <label htmlFor="code">Mã kích hoạt</label>
              <input
                id="code"
                className="auh-input"
                value={rawCode}
                onChange={(e) => setRawCode(e.target.value)}
                placeholder="10 ký tự chữ và số"
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                maxLength={130}
                aria-invalid={!!errors.code}
                aria-describedby={errors.code ? 'code-err' : undefined}
              />
              {errors.code ? (
                <div id="code-err" className="auh-error">{errors.code}</div>
              ) : (
                <div className="auh-help">Gõ chữ hoa hay thường, có hoặc không có dấu gạch đều được. Nhầm chữ O với số 0 hay chữ I với số 1 cũng không sao.</div>
              )}
            </div>
          </details>
        </section>

        <section className="auh-card">
          <h2>Bước 2. Đây là loại tủ nào?</h2>
          <div className="auh-choices" role="group" aria-label="Loại tủ">
            {(['freezer', 'chiller'] as const).map((k) => (
              <button key={k} type="button" className="auh-choice" aria-pressed={kind === k} onClick={() => chooseKind(k)}>
                <strong>{KIND_LABEL[k]}</strong>
                <small>{KIND_PRESETS[k].hint}</small>
              </button>
            ))}
          </div>
          <div className="auh-field" style={{ marginTop: 16 }}>
            <label htmlFor="name">Tên tủ</label>
            <input
              id="name"
              className="auh-input"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              maxLength={NAME_MAX * 2}
              autoComplete="off"
              aria-invalid={!!errors.name}
              aria-describedby={errors.name ? 'name-err' : undefined}
            />
            {errors.name && <div id="name-err" className="auh-error">{errors.name}</div>}
          </div>
        </section>

        {submitError !== undefined && (
          <ErrorBox
            error={submitError}
            focusOnShow
            onAllowed={() => {
              setSubmitError(undefined);
              openSnackbar({ text: 'Đã cho phép. Bạn bấm "Kích hoạt" lại để hoàn tất.', type: 'info', duration: 4000 });
            }}
          />
        )}

        <button type="submit" className="auh-btn" disabled={busy || locked}>
          {busy ? 'Đang kích hoạt...' : locked ? 'Đợi một chút rồi thử lại' : 'Kích hoạt'}
        </button>

        <details className="auh-details" style={{ marginTop: 16 }}>
          <summary>Thiết bị đã dùng ở tài khoản khác?</summary>
          <p className="auh-muted">
            Mỗi thiết bị chỉ thuộc <strong>một</strong> tài khoản Zalo. Nếu bạn mua lại thiết bị đã qua sử dụng, chủ cũ cần mở Auhono, vào thiết bị đó
            và bấm "Gỡ thiết bị"; sau đó bạn kích hoạt như bình thường. Không liên lạc được với chủ cũ thì hãy liên hệ nơi bán.
            Người nhà muốn nhận cảnh báo thì không cần kích hoạt: hãy thêm số điện thoại của họ ở mục "Người nhận cảnh báo".
          </p>
        </details>
      </form>
    </Screen>
  );
}
