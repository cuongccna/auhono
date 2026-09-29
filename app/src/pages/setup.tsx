// "Thông tin Wi-Fi cài đặt thiết bị": tên + mật khẩu Wi-Fi mà thiết bị phát khi ở chế độ cài đặt (chủ quán mất tem vẫn xem lại được).
// BẢO MẬT: chỉ tải khi mở màn hình này; không cache, không lưu (không storage), không log, không đưa vào URL hay state chung;
// dữ liệu chỉ nằm trong state của chính màn hình và bị bỏ khi rời màn hình. Không vẽ mã QR (có sẵn trên tem).
import { useState } from 'react';
import { useParams } from 'zmp-ui';
import { api } from '../api.ts';
import { ErrorBox } from '../components/error-box.tsx';
import { Screen } from '../components/screen.tsx';
import { useAsync } from '../hooks.ts';
import { copyText } from '../sdk.ts';

/** Hiện từng ký tự trong một ô riêng để đọc/chép tay không nhầm (0/O, 1/l...). */
function BigChars({ value, label }: { value: string; label: string }) {
  return (
    <div className="auh-cred" role="img" aria-label={`${label}: ${value.split('').join(' ')}`}>
      {value.split('').map((ch, i) => (
        <span key={i} className="auh-cred-char" aria-hidden="true">
          {ch}
        </span>
      ))}
    </div>
  );
}

export default function SetupPage() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useAsync((signal) => api.getSetup(id, { signal }), [id]);
  const [note, setNote] = useState<string | null>(null);

  async function copy(what: string, value: string) {
    setNote((await copyText(value)) ? `Đã sao chép ${what}.` : `Không sao chép được ${what}. Bạn hãy chép tay theo các ô ở trên.`);
  }

  return (
    <Screen title="Wi-Fi cài đặt thiết bị">
      {error !== undefined && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <p className="auh-muted auh-center">Đang tải...</p>}

      {data && (
        <>
          <section className="auh-card">
            <h2>Tên Wi-Fi của thiết bị</h2>
            <BigChars value={data.ap_ssid} label="Tên Wi-Fi" />
            <button type="button" className="auh-btn auh-btn-secondary" onClick={() => void copy('tên Wi-Fi', data.ap_ssid)}>
              Sao chép tên Wi-Fi
            </button>

            <h2 style={{ marginTop: 20 }}>Mật khẩu</h2>
            <BigChars value={data.ap_password} label="Mật khẩu" />
            <button type="button" className="auh-btn auh-btn-secondary" onClick={() => void copy('mật khẩu', data.ap_password)}>
              Sao chép mật khẩu
            </button>
            {note && <p role="status" className="auh-muted" style={{ marginTop: 8, marginBottom: 0 }}>{note}</p>}

            <div className="auh-banner auh-banner-warn auh-secret-note" style={{ marginTop: 16, marginBottom: 0 }}>
              Chỉ chia sẻ mật khẩu này với người cần cài đặt thiết bị.
            </div>
          </section>

          <section className="auh-card">
            <h2>Cách cài đặt Wi-Fi cho thiết bị</h2>
            <ol className="auh-list">
              <li>
                Cắm điện cho thiết bị. Nếu thiết bị chưa phát Wi-Fi trên, giữ nút trên thiết bị khoảng <strong>5 giây</strong> cho tới khi đèn nháy nhanh
                (5 lần mỗi giây). Thiết bị cũng tự mở lại Wi-Fi cài đặt sau khoảng 20 phút mất Wi-Fi đã lưu.
              </li>
              <li>
                Trên điện thoại, vào phần Wi-Fi, chọn mạng <strong>{data.ap_ssid}</strong> và nhập mật khẩu ở trên.
              </li>
              <li>
                Trang cài đặt tự mở. Nếu không, mở trình duyệt và gõ <strong>192.168.4.1</strong>. Nếu điện thoại báo "không có Internet", chọn giữ kết nối.
              </li>
              <li>
                Chọn Wi-Fi của quán và nhập mật khẩu của quán, rồi bấm Lưu. Chỉ dùng Wi-Fi <strong>2.4 GHz</strong>; thiết bị không nối được Wi-Fi 5 GHz.
              </li>
              <li>Đèn sáng liên tục là đã nối xong. Sau vài phút số đo sẽ hiện trong ứng dụng.</li>
            </ol>
          </section>

          {data.wifi_qr && (
            <section className="auh-card">
              <details className="auh-details">
                <summary>Nâng cao</summary>
                <p className="auh-muted">Chuỗi mã QR Wi-Fi (mã QR đã in sẵn trên tem, ứng dụng không vẽ lại).</p>
                <code className="auh-code">{data.wifi_qr}</code>
              </details>
            </section>
          )}
        </>
      )}
    </Screen>
  );
}
