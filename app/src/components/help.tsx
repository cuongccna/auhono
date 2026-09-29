// Các khối hướng dẫn ngắn bằng chữ đơn giản cho chủ quán không rành kỹ thuật.
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
          <strong>Nhắc lại:</strong> nếu sự cố kéo dài, hệ thống sẽ nhắc lại định kỳ, và báo "đã ổn" khi tủ về bình thường.
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
export function SetupHelp({ deviceId }: { deviceId: string }) {
  const tail = deviceId.slice(-4);
  return (
    <div className="auh-banner auh-banner-info" style={{ marginTop: 12, marginBottom: 0 }}>
      <strong>Chưa có dữ liệu — cắm điện và kết nối Wi-Fi cho thiết bị.</strong>
      <ol className="auh-list">
        <li>Cắm điện cho thiết bị và đặt đầu dò vào trong tủ.</li>
        <li>
          Trên điện thoại, vào phần Wi-Fi và nối vào mạng <strong>Auhono-{tail}</strong> do thiết bị phát ra. Trang cấu hình tự mở
          (nếu không, mở trình duyệt và gõ <strong>192.168.4.1</strong>). Chọn Wi-Fi của quán và nhập mật khẩu.
        </li>
        <li>
          Chỉ dùng Wi-Fi <strong>2.4 GHz</strong>; thiết bị không nối được Wi-Fi 5 GHz.
        </li>
        <li>Đèn sáng liên tục là đã nối xong. Sau vài phút số đo sẽ hiện ở đây.</li>
        <li>Không thấy mạng Auhono-{tail}? Giữ nút trên thiết bị khoảng 5 giây để mở lại trang cấu hình.</li>
      </ol>
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
