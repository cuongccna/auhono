// Màn hình "Kích hoạt": quét QR trên hộp (hoặc nhập tay), chọn loại tủ, đặt tên, gắn thiết bị vào tài khoản.
import { useState, type FormEvent } from 'react';
import { useNavigate, useSnackbar } from 'zmp-ui';
import { api } from '../api.ts';
import { ErrorBox } from '../components/error-box.tsx';
import { Screen } from '../components/screen.tsx';
import { parseClaimQr, validateManualClaim, type QrParseResult } from '../lib/qr.ts';
import { KIND_LABEL, KIND_PRESETS, type Kind } from '../lib/thresholds.ts';
import { scanQr } from '../sdk.ts';

const QR_PROBLEM: Record<Exclude<QrParseResult, { ok: true }>['reason'], string> = {
  empty: 'Chưa đọc được mã QR. Bạn thử quét lại, hoặc nhập mã tay bên dưới nhé.',
  not_auhono: 'Đây không phải mã QR của thiết bị Auhono. Hãy quét mã dán trên hộp thiết bị.',
  malformed: 'Mã QR này không đúng định dạng. Bạn nhập mã tay bên dưới giúp nhé.',
};

const NAME_MAX = 60;

export default function ActivatePage() {
  const navigate = useNavigate();
  const { openSnackbar } = useSnackbar();

  const [rawId, setRawId] = useState('');
  const [rawCode, setRawCode] = useState('');
  const [kind, setKind] = useState<Kind>('freezer');
  const [name, setName] = useState(KIND_LABEL.freezer);
  const [nameTouched, setNameTouched] = useState(false);

  const [scanNote, setScanNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [errors, setErrors] = useState<{ id?: string; code?: string; name?: string }>({});
  const [submitError, setSubmitError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);

  async function scan() {
    setScanNote(null);
    const content = await scanQr();
    if (content === null) {
      setScanNote({ text: 'Chưa quét được mã. Bạn thử lại hoặc nhập mã tay nhé.', ok: false });
      return;
    }
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

  function chooseKind(k: Kind) {
    setKind(k);
    if (!nameTouched) setName(KIND_LABEL[k]);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitError(undefined);

    const claim = validateManualClaim(rawId, rawCode);
    const trimmed = name.trim();
    const nameError = trimmed.length === 0 ? 'Hãy đặt tên cho tủ, ví dụ "Tủ kem".' : trimmed.length > NAME_MAX ? `Tên tối đa ${NAME_MAX} ký tự.` : undefined;
    if (!claim.ok || nameError) {
      setErrors({ id: claim.ok ? undefined : claim.idError, code: claim.ok ? undefined : claim.codeError, name: nameError });
      return;
    }
    setErrors({});

    setBusy(true);
    try {
      await api.claimDevice({ device_id: claim.deviceId, code: claim.code, name: trimmed, kind });
      openSnackbar({ text: 'Đã kích hoạt thiết bị', type: 'success', duration: 3000 });
      // Thêm người nhận ngay, vì chưa có ai nhận thì sẽ không có tin cảnh báo nào được gửi.
      navigate(`/device/${encodeURIComponent(claim.deviceId)}/recipients`, { replace: true });
    } catch (err) {
      setSubmitError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title="Kích hoạt thiết bị" back={false} withNav>
      <form onSubmit={submit} noValidate>
        <section className="auh-card">
          <h2>Bước 1. Quét mã trên hộp</h2>
          <p className="auh-muted">Mở camera và hướng vào mã QR dán trên hộp thiết bị.</p>
          <button type="button" className="auh-btn" onClick={() => void scan()}>
            Quét mã QR
          </button>
          {scanNote && (
            <div className={`auh-banner ${scanNote.ok ? 'auh-banner-info' : 'auh-banner-warn'}`} style={{ marginTop: 12, marginBottom: 0 }} role="status">
              {scanNote.text}
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
                maxLength={40}
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
                maxLength={40}
                aria-invalid={!!errors.code}
                aria-describedby={errors.code ? 'code-err' : undefined}
              />
              {errors.code ? (
                <div id="code-err" className="auh-error">{errors.code}</div>
              ) : (
                <div className="auh-help">Gõ chữ hoa hay thường, có hoặc không có dấu gạch đều được.</div>
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
              maxLength={NAME_MAX + 20}
              autoComplete="off"
              aria-invalid={!!errors.name}
              aria-describedby={errors.name ? 'name-err' : undefined}
            />
            {errors.name && <div id="name-err" className="auh-error">{errors.name}</div>}
          </div>
        </section>

        {submitError !== undefined && <ErrorBox error={submitError} />}

        <button type="submit" className="auh-btn" disabled={busy}>
          {busy ? 'Đang kích hoạt...' : 'Kích hoạt'}
        </button>
      </form>
    </Screen>
  );
}
