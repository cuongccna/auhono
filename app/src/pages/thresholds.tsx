// Màn hình "Đặt ngưỡng": chọn loại tủ (có sẵn ngưỡng), hoặc chỉnh tay trong mục "Nâng cao".
// Hiện nhiệt độ hiện tại của tủ ngay cạnh form và cảnh báo nếu nó đã nằm ngoài ngưỡng định đặt
// (tủ đông gia đình chạy -12°C mà chọn "Tủ đông -18°C" thì báo động sẽ không bật cho tới khi tủ đạt ngưỡng).
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams, useSnackbar } from 'zmp-ui';
import { api } from '../api.ts';
import { ErrorBox } from '../components/error-box.tsx';
import { Screen } from '../components/screen.tsx';
import { useAsync, useNow, useSingleFlight } from '../hooks.ts';
import { AppError } from '../lib/errors.ts';
import { formatAgo, formatTemp } from '../lib/format.ts';
import {
  BREACH_LIMIT,
  currentTempWarning,
  describeThresholds,
  KIND_LABEL,
  KIND_PRESETS,
  parseNumberInput,
  TEMP_LIMIT,
  validateThresholds,
  type Kind,
  type ThresholdErrors,
} from '../lib/thresholds.ts';
import { focusSoon, useGoBack } from '../nav.ts';

/** Số đo cũ hơn ngần này thì không dùng để cảnh báo "đang vượt ngưỡng mới" (không còn phản ánh tủ hiện tại). */
const FRESH_READING_SECONDS = 30 * 60;

export default function ThresholdsPage() {
  const { id = '' } = useParams();
  const { openSnackbar } = useSnackbar();
  const singleFlight = useSingleFlight();
  const goBack = useGoBack(`/device/${encodeURIComponent(id)}`);

  const { data: device, error, loading, updatedAt, reload } = useAsync(
    async (signal) => {
      const found = (await api.listDevices({ signal })).find((d) => d.id === id);
      if (!found) throw new AppError('not_found');
      return found;
    },
    [id],
  );
  const now = useNow(30_000, updatedAt);

  const [kind, setKind] = useState<Kind | null>(null);
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [breach, setBreach] = useState('');
  const [errors, setErrors] = useState<ThresholdErrors>({});
  const [saveError, setSaveError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);

  // Điền form theo giá trị hiện tại ĐÚNG MỘT LẦN cho mỗi thiết bị. Tải lại (thử lại sau lỗi mạng, quay lại từ cài đặt quyền)
  // không được ghi đè những gì người dùng đã gõ.
  const filledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!device || filledFor.current === id) return;
    filledFor.current = id;
    setKind(device.kind === 'other' ? null : device.kind);
    setMin(String(device.min_c));
    setMax(String(device.max_c));
    setBreach(String(device.breach_minutes));
  }, [device, id]);

  function choosePreset(k: Kind) {
    setKind(k);
    setMin(String(KIND_PRESETS[k].min_c));
    setMax(String(KIND_PRESETS[k].max_c));
    setErrors({});
  }

  const latest = device?.latest ?? null;
  const latestAge = latest ? now - latest.ts : null;
  const fresh = latestAge !== null && latestAge <= FRESH_READING_SECONDS;
  const warning = latest && fresh ? currentTempWarning({ current: latest.temp_c, min: parseNumberInput(min), max: parseNumberInput(max) }) : null;
  const preview = validateThresholds({ min, max, breach });

  async function save(e: FormEvent) {
    e.preventDefault();
    await singleFlight(async () => {
      setSaveError(undefined);
      const result = validateThresholds({ min, max, breach });
      if (!result.ok) {
        setErrors(result.errors);
        focusSoon(result.errors.min ? 'min' : result.errors.max ? 'max' : 'breach');
        return;
      }
      setErrors({});

      // Không đổi gì thì không gửi: mỗi lần đổi ngưỡng server đặt lại trạng thái "đã bật báo động".
      const same =
        device &&
        result.value.min_c === device.min_c &&
        result.value.max_c === device.max_c &&
        result.value.breach_minutes === device.breach_minutes &&
        (kind === null || kind === device.kind);
      if (same) {
        openSnackbar({ text: 'Ngưỡng không thay đổi', type: 'info', duration: 2500 });
        goBack();
        return;
      }

      setBusy(true);
      try {
        await api.updateDevice(id, { ...(kind ? { kind } : {}), ...result.value });
        // Đọc lại để báo TRẠNG THÁI SAU KHI LƯU: đổi ngưỡng làm server đặt lại "đã bật báo động".
        let text = 'Đã lưu ngưỡng cảnh báo';
        try {
          const fresh = (await api.listDevices()).find((d) => d.id === id);
          if (fresh?.armed === false) text = 'Đã lưu. Đang chờ tủ đạt ngưỡng mới, chưa cảnh báo cho tới khi tủ đạt.';
        } catch {
          /* không đọc lại được cũng không sao: đã lưu xong */
        }
        openSnackbar({ text, type: 'success', duration: 5000 });
        goBack();
      } catch (err) {
        setSaveError(err);
      } finally {
        setBusy(false);
      }
    });
  }

  const advancedInvalid = !!(errors.min || errors.max || errors.breach);

  return (
    <Screen title="Đặt ngưỡng cảnh báo">
      {error !== undefined && <ErrorBox error={error} onRetry={reload} />}
      {!device && loading && <p className="auh-muted auh-center">Đang tải...</p>}

      {device && (
        <form onSubmit={save} noValidate>
          <section className="auh-card">
            <h2>Nhiệt độ tủ hiện tại</h2>
            {latest && latestAge !== null ? (
              <>
                <div className="auh-temp-mid">{formatTemp(latest.temp_c)}</div>
                <div className="auh-muted" style={{ margin: 0 }}>
                  {fresh ? `Cập nhật ${formatAgo(now, latest.ts)}` : `Số đo cuối ${formatAgo(now, latest.ts)} (đã cũ, không dùng để so sánh)`}
                </div>
              </>
            ) : (
              <div className="auh-muted" style={{ margin: 0 }}>Thiết bị chưa gửi số đo nào.</div>
            )}
          </section>

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
              <p className="auh-muted">
                Chỉ chỉnh khi bạn hiểu rõ. <strong>Cao nhất</strong>: tủ nóng hơn mức này thì báo. <strong>Thấp nhất</strong>: tủ lạnh hơn mức này thì báo
                (dùng cho tủ mát bị đóng đá). Tủ gia đình thường chạy khoảng -12°C đến -18°C: hãy đặt "Cao nhất" cao hơn nhiệt độ tủ vẫn chạy bình thường.
              </p>
              <div className="auh-field">
                <label htmlFor="min">Thấp nhất (°C)</label>
                <input id="min" className="auh-input" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} aria-invalid={!!errors.min} aria-describedby="min-msg" autoComplete="off" />
                <div id="min-msg" className={errors.min ? 'auh-error' : 'auh-help'}>{errors.min ?? `Từ ${TEMP_LIMIT.min} đến ${TEMP_LIMIT.max}. Gõ -18,5 hoặc -18.5 đều được.`}</div>
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
                  {errors.breach ?? `Từ ${BREACH_LIMIT.min} đến ${BREACH_LIMIT.max} phút. Số lớn hơn giúp tránh báo nhầm khi mở cửa tủ, nhưng tin báo cũng đến chậm hơn.`}
                </div>
              </div>
            </details>
            {preview.ok && <p className="auh-muted" style={{ marginTop: 8, marginBottom: 0 }}>{describeThresholds(preview.value)}</p>}
          </section>

          {warning && (
            <div className="auh-banner auh-banner-warn" role="status">
              {warning}
            </div>
          )}

          {saveError !== undefined && <ErrorBox error={saveError} focusOnShow onAllowed={() => {
            setSaveError(undefined);
            openSnackbar({ text: 'Đã cho phép. Bạn bấm "Lưu" lại để hoàn tất.', type: 'info', duration: 4000 });
          }} />}
          <button type="submit" className="auh-btn" disabled={busy}>
            {busy ? 'Đang lưu...' : 'Lưu'}
          </button>
        </form>
      )}
    </Screen>
  );
}
