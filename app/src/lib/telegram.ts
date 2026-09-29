// Kênh Telegram (miễn phí, dự phòng khi tin Zalo không gửi được): kiểm tra liên kết và câu chữ.
// Liên kết do server tạo, dùng MỘT LẦN, hiệu lực 24 giờ, và phải mở trên điện thoại của NGƯỜI NHẬN.
// Bảo mật: chỉ chấp nhận đúng https://t.me/<bot>?start=<mã>; mọi thứ khác (http, host lạ, cổng, user@, #, đường dẫn thêm) bị từ chối
// trước khi đưa cho SDK mở ra ngoài. Không log liên kết (mã trong đó là bí mật dùng một lần).

export type RecipientMode = 'zns' | 'both' | 'telegram';

/** Tên bot Telegram: 4–32 ký tự chữ/số/gạch dưới. Mã `start`: base64url do server tạo. */
const TELEGRAM_URL_RE = /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{3,31}\?start=[A-Za-z0-9_-]{1,64}$/;

export function isTelegramUrl(url: unknown): url is string {
  return typeof url === 'string' && url.length <= 200 && TELEGRAM_URL_RE.test(url);
}

export const MODE_LABEL: Record<RecipientMode, string> = {
  both: 'Zalo + Telegram',
  telegram: 'Chỉ Telegram',
  zns: 'Chỉ Zalo',
};

export const MODE_ORDER: readonly RecipientMode[] = ['both', 'telegram', 'zns'];

/** Cảnh báo bắt buộc khi chọn "Chỉ Telegram". */
export const TELEGRAM_ONLY_WARNING =
  'Người này sẽ không nhận tin Zalo. Nếu tắt Telegram hoặc chặn bot, họ sẽ không nhận được gì.';

export const TELEGRAM_HELP =
  'Telegram miễn phí và là kênh dự phòng khi tin Zalo không gửi được. Nếu kết nối cả hai kênh, người đó nhận cả hai tin. ' +
  'Lưu ý: chỉ người nhận chính nhận tin nhắc lại qua Zalo, còn mọi người đã kết nối Telegram đều nhận tin nhắc lại qua Telegram.';

export const LINK_ONE_TIME_NOTE = 'Liên kết chỉ dùng được một lần và có hiệu lực 24 giờ.';

/** Lời nhắn gửi cho người nhận (dùng khi chia sẻ/sao chép). */
export function shareMessage(recipientName: string, url: string): string {
  return `Chào ${recipientName}, bấm liên kết này rồi bấm Start trong Telegram để nhận cảnh báo tủ lạnh (dùng một lần, hết hạn sau 24 giờ): ${url}`;
}
