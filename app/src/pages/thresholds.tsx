// Màn hình "Đặt ngưỡng": chọn loại tủ (có sẵn ngưỡng), hoặc chỉnh tay trong mục "Nâng cao".
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSnackbar } from 'zmp-ui';
import { api } from '../api.ts';
import { ErrorBox } from '../components/error-box.tsx';
import { Screen } from '../components/screen.tsx';
import { useAsync } from '../hooks.ts';
import { AppError } from '../lib/errors.ts';
import {
  BREACH_LIMIT,
  KIND_LABEL,
  KIND_PRESETS,
  TEMP_LIMIT,
  validateThresholds,
  type Kind,
  type ThresholdErrors,
} from '../lib/thresholds.ts';

export default function ThresholdsPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { openSnackbar } = useSnackbar();

  const { data: device, error, loading, reload } = useAsync(async () => {
    const found = (await api.listDevices()).find((d) => d.id === id);
    if (!found) throw new AppError('not_found');
    return found;
  }, [id]);

  const [kind, setKind] = useState<Kind>('freezer');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [breach, setBreach] = useState('');
  const [errors, setErrors] = useState<ThresholdErrors>({});
  const [saveError, setSaveError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);

  // Điền form theo giá trị hiện tại khi dữ liệu về.
  useEffect(() => {
    if (!device) return;
    setKind(device.kind);
    setMin(String(device.min_c));
    setMax(String(device.max_c));
    setBreach(String(device.breach_minutes));
  }, [device]);

  function choosePreset(k: Kind) {
    setKind(k);
    setMin(String(KIND_PRESETS[k].min_c));
    setMax(String(KIND_PRESETS[k].max_c));
    setErrors({});
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaveError(undefined);
    const result = validateThresholds({ min, max, breach });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await api.updateDevice(id, { kind, ...result.value });
      openSnackbar({ text: 'Đã lưu ngưỡng cảnh báo', type: 'success', duration: 3000 });
      navigate(-1);
    } catch (err) {
      setSaveError(err);
    } finally {
      setBusy(false);
    }
  }

  const advancedInvalid = !!(errors.min || errors.max || errors.breach);

  return (
    <Screen title="Đặt ngưỡng cảnh báo">
      {error !== undefined && <ErrorBox error={error} onRetry={reload} />}
      {!device && loading && <p className="auh-muted auh-center">Đang tải...</p>}

      {device && (
        <form onSubmit={save} noValidate>
          <section className="auh-card">
            <h2>Tủ của bạn là loại nào?</h2>
            <p className="auh-muted">Chọn loại tủ, ứng dụng tự đặt ngưỡng phù hợp. Bạn không cần nhập con số nào.</p>
            <div className="auh-choices" role="group" aria-label="Loại tủ">
              {(['freezer', 'chiller'] as const).map((k) => (
                <button key={k} type="button" className="auh-choice" aria-pressed={kind === k} onClick={() => choosePreset(k)}>
                  <strong>{KIND_LABEL[k]}</strong>
                  <small>{KIND_PRESETS[k].hint}</small>
                </button>
              ))}
            </div>
          </section>

          <section className="auh-card">
            <details className="auh-details" open={advancedInvalid || undefined}>
              <summary>Nâng cao</summary>
              <p className="auh-muted">Chỉ chỉnh khi bạn hiểu rõ. Nhiệt độ ra ngoài khoảng này quá số phút bên dưới thì bạn sẽ nhận cảnh báo.</p>
              <div className="auh-field">
                <label htmlFor="min">Thấp nhất (°C)</label>
                <input id="min" className="auh-input" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} aria-invalid={!!errors.min} aria-describedby="min-msg" autoComplete="off" />
                <div id="min-msg" className={errors.min ? 'auh-error' : 'auh-help'}>{errors.min ?? `Từ ${TEMP_LIMIT.min} đến ${TEMP_LIMIT.max}`}</div>
              </div>
              <div className="auh-field">
                <label htmlFor="max">Cao nhất (°C)</label>
                <input id="max" className="auh-input" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} aria-invalid={!!errors.max} aria-describedby="max-msg" autoComplete="off" />
                <div id="max-msg" className={errors.max ? 'auh-error' : 'auh-help'}>{errors.max ?? `Từ ${TEMP_LIMIT.min} đến ${TEMP_LIMIT.max}, phải lớn hơn mức thấp nhất`}</div>
              </div>
              <div className="auh-field">
                <label htmlFor="breach">Báo sau bao nhiêu phút vượt ngưỡng</label>
                <input id="breach" className="auh-input" inputMode="numeric" value={breach} onChange={(e) => setBreach(e.target.value)} aria-invalid={!!errors.breach} aria-describedby="breach-msg" autoComplete="off" />
                <div id="breach-msg" className={errors.breach ? 'auh-error' : 'auh-help'}>
                  {errors.breach ?? `Từ ${BREACH_LIMIT.min} đến ${BREACH_LIMIT.max} phút. Số lớn hơn giúp tránh báo nhầm khi mở cửa tủ.`}
                </div>
              </div>
            </details>
          </section>

          {saveError !== undefined && <ErrorBox error={saveError} />}
          <button type="submit" className="auh-btn" disabled={busy}>
            {busy ? 'Đang lưu...' : 'Lưu'}
          </button>
        </form>
      )}
    </Screen>
  );
}
