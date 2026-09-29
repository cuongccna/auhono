// Các cảnh báo "cấu hình" của một thiết bị (khác với trạng thái nhiệt độ): thiếu người nhận, gửi tin lỗi, chưa bật báo động.
// Các trường đến từ server; server cũ chưa có thì vắng mặt và ta KHÔNG hiện gì (không đoán).
import type { Device } from './schemas.ts';
import type { DeviceStatus } from './status.ts';

export type DeviceNoticeKind = 'no_recipients' | 'notify_failed' | 'not_armed';

export const NOTICE_TEXT: Record<DeviceNoticeKind, string> = {
  no_recipients: 'Chưa có người nhận cảnh báo — sẽ không có tin nhắn nào được gửi.',
  notify_failed: 'Không gửi được tin cho một số người nhận, hãy kiểm tra số điện thoại/Zalo.',
  not_armed: 'Đang chờ tủ đạt nhiệt độ, chưa cảnh báo.',
};

/** Giải thích thêm, hiện bên dưới câu chính. */
export const NOTICE_DETAIL: Record<DeviceNoticeKind, string> = {
  no_recipients: 'Hãy thêm số điện thoại của bạn hoặc người trông quán.',
  notify_failed:
    'Người nhận phải có Zalo dùng đúng số đã nhập. Tin có thể không tới nếu họ đã chặn tài khoản Auhono trên Zalo.',
  not_armed:
    'Báo động chỉ bật sau khi tủ đã xuống tới khoảng ngưỡng ít nhất một lần (từ lúc lắp máy hoặc đổi ngưỡng). Nếu tủ của bạn vốn chạy ở mức khác, hãy chỉnh lại ngưỡng.',
};

/** Danh sách cảnh báo cần hiện, theo thứ tự quan trọng giảm dần. */
export function deviceNotices(
  d: Pick<Device, 'armed' | 'recipient_count' | 'notify_failures_24h'>,
  status?: DeviceStatus,
): DeviceNoticeKind[] {
  const out: DeviceNoticeKind[] = [];
  if (d.recipient_count === 0) out.push('no_recipients');
  if ((d.notify_failures_24h ?? 0) > 0) out.push('notify_failed');
  // Chưa có số đo nào thì hiển nhiên chưa bật báo động: đã có hướng dẫn cài đặt riêng, khỏi nói thêm.
  if (d.armed === false && status !== 'no_data') out.push('not_armed');
  return out;
}
