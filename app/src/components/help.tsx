// Các khối hướng dẫn ngắn bằng chữ đơn giản cho chủ quán không rành kỹ thuật.
import { useNavigate } from 'zmp-ui';
import { techRows } from '../lib/diag.ts';
import { formatVnDateTime } from '../lib/format.ts';
import type { Device } from '../lib/schemas.ts';
import { NOTICE_DETAIL, NOTICE_TEXT, type DeviceNoticeKind } from '../lib/notices.ts';

/** Vì sao cảnh báo không kêu ngay + "mất kết nối" nghĩa là gì. Đặt ở chi tiết thiết bị. */
export function AlertHelp({ breachMinutes }: { breachMinutes?: number }) {
  return (
    <details className="auh-details">
      <summary>Cảnh báo hoạt động thế nào?</summary>
      <ul className="auh-list">
        <li>
          <strong>Nhiệt độ:</strong> chỉ báo khi tủ nóng hoặc lạnh quá ngưỡng <em>liên tục</em> {breachMinutes ?? 15} phút, để mở cửa tủ vài phút
          không bị báo nhầm. Vì vậy tin báo luôn đến chậm hơn lúc sự cố thật khoảng chừng đó.
        </li>
        <li>
          <strong>Mất kết nối:</strong> báo khi thiết bị không gửi số đo nào trong 15 phút. Có thể do mất điện, Wi-Fi bị tắt hoặc đổi mật khẩu,
          hoặc dây đầu dò nhiệt độ bị đứt/rút. Bạn nên đi kiểm tra tủ.
        </li>
        <li>
          <strong>Lỗi cảm biến:</strong> báo khi thiết bị VẪN kết nối nhưng sau 15 phút vẫn không có số đo hợp lệ nào (thường do dây đầu dò đứt, rút ra hoặc kẹt ở gioăng
          cửa tủ). Khác với "mất kết nối" (mất điện/Wi-Fi). Nhắc lại sau 2 giờ, rồi cách 6, 12 giờ.
        </li>
        <li>
          <strong>Nhắc lại:</strong> nếu sự cố kéo dài, hệ thống nhắc lại thưa dần (nhiệt độ: sau 30 phút, rồi cách 2, 4, 8, 12 giờ; mất kết nối: sau 2 giờ,
          rồi cách 6, 12 giờ) và báo "đã ổn" khi tủ về bình thường. Chỉ người nhận chính (người đầu tiên trong danh sách) nhận tin nhắc lại. Bấm{' '}
          <strong>"Đã biết, đang xử lý"</strong> để ngừng nhắc trong vài giờ.
        </li>
        <li>
          <strong>Tủ mới hoặc vừa đổi ngưỡng:</strong> báo động chỉ bật sau khi tủ đã xuống tới khoảng ngưỡng ít nhất một lần.
        </li>
        <li>
          <strong>Tin nhắn</strong> gửi qua Zalo cho người nhận, nên họ cần có Zalo dùng đúng số đã thêm. Tin có thể không tới nếu họ đã chặn Auhono.
        </li>
      </ul>
    </details>
  );
}

/** Thiết bị mới kích hoạt, chưa có số đo: hướng dẫn cắm điện + nối Wi-Fi + mở lại trang cấu hình. */
export function SetupHelp({ deviceId, neverSeenAlert, claimedAt }: { deviceId: string; neverSeenAlert?: boolean; claimedAt?: number | null }) {
  const tail = deviceId.slice(-4);
  const navigate = useNavigate();
  return (
    <div className="auh-banner auh-banner-info" style={{ marginTop: 12, marginBottom: 0 }}>
      <strong>Chưa có dữ liệu — cắm điện và kết nối Wi-Fi cho thiết bị.</strong>
      {neverSeenAlert && (
        <div style={{ marginTop: 4 }}>
          Đã lâu kể từ lúc kích hoạt{claimedAt ? ` (${formatVnDateTime(claimedAt)})` : ''} mà thiết bị vẫn chưa gửi số đo nào, nên hệ thống đã báo cho bạn.
          Rất có thể Wi-Fi chưa được cài, hoặc nhập sai mật khẩu, hoặc nhà dùng Wi-Fi 5 GHz.
        </div>
      )}
      <ol className="auh-list">
        <li>Cắm điện cho thiết bị và đặt đầu dò vào trong tủ.</li>
        <li>
          Trên điện thoại, vào phần Wi-Fi và nối vào mạng <strong>Auhono-{tail}</strong> do thiết bị phát ra (có mật khẩu, in trên tem của thiết bị). Trang cấu hình tự mở
          (nếu không, mở trình duyệt và gõ <strong>192.168.4.1</strong>). Chọn Wi-Fi của quán và nhập mật khẩu.
        </li>
        <li>
          Chỉ dùng Wi-Fi <strong>2.4 GHz</strong>; thiết bị không nối được Wi-Fi 5 GHz.
        </li>
        <li>Đèn sáng liên tục là đã nối xong. Sau vài phút số đo sẽ hiện ở đây.</li>
        <li>Không thấy mạng Auhono-{tail}? Giữ nút trên thiết bị khoảng 5 giây để mở lại trang cấu hình.</li>
      </ol>
      <button type="button" className="auh-btn" onClick={() => navigate(`/device/${encodeURIComponent(deviceId)}/setup`)}>
        Xem tên và mật khẩu Wi-Fi của thiết bị
      </button>
    </div>
  );
}

/** Một cảnh báo cấu hình (thiếu người nhận / gửi tin lỗi / chưa bật báo động), kèm nút hành động nếu có. */
export function NoticeBanner({ kind, onFix }: { kind: DeviceNoticeKind; onFix?: () => void }) {
  const tone = kind === 'not_armed' ? 'auh-banner-info' : 'auh-banner-warn';
  return (
    <div className={`auh-banner ${tone}`} role={kind === 'not_armed' ? 'status' : 'alert'} style={{ marginTop: 12, marginBottom: 0 }}>
      <strong>{NOTICE_TEXT[kind]}</strong>
      <div style={{ marginTop: 4 }}>{NOTICE_DETAIL[kind]}</div>
      {onFix && (
        <button type="button" className="auh-btn" style={{ marginTop: 12 }} onClick={onFix}>
          {kind === 'no_recipients' ? 'Thêm người nhận' : 'Kiểm tra người nhận'}
        </button>
      )}
    </div>
  );
}

/** Mục "Thông tin kỹ thuật" (gập lại): sóng Wi-Fi, lý do khởi động lại, thời gian chạy, phần mềm. Không có dữ liệu thì không hiện. */
export function TechInfo({ device }: { device: Partial<Pick<Device, 'diag' | 'diag_at' | 'firmware'>> }) {
  const rows = techRows(device);
  if (rows.length === 0) return null;
  return (
    <details className="auh-details">
      <summary>Thông tin kỹ thuật</summary>
      <dl className="auh-tech">
        {rows.map((r) => (
          <div key={r.label} className="auh-tech-row">
            <dt>{r.label}</dt>
            <dd>
              {r.value}
              {r.hint && <div className="auh-help">{r.hint}</div>}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
