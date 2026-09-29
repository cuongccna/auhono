// Logic hiển thị cho hai thao tác của chủ quán để KHÔNG tốn tin nhắn (mỗi tin ZNS ~220đ):
//  - "Đã biết, đang xử lý" (ack): dừng tin nhắc lại của một sự cố đang diễn ra trong vài giờ.
//  - "Tạm dừng cảnh báo" (pause): nghỉ Tết, chuyển tủ, rút điện có chủ ý: không cảnh báo, không tin nhắn.
// Hàm thuần (giờ truyền vào), test được không cần React.
import { formatVnDate, formatVnTime, vnParts } from './format.ts';
import type { Device } from './schemas.ts';

/** Số ngày cho phép chọn khi tạm dừng (server nhận 1..60). */
export const PAUSE_DAY_CHOICES = [1, 3, 7, 14, 30] as const;
export const DEFAULT_PAUSE_DAYS = 3;
/** Ghi nhận "đã biết" mặc định 4 giờ (server nhận 1..24). */
export const DEFAULT_ACK_HOURS = 4;

/** Đang tạm dừng cảnh báo? (paused_until còn hiệu lực theo giờ server). */
export function isPaused(d: Pick<Device, 'paused_until'>, nowSec: number): boolean {
  return d.paused_until != null && d.paused_until > nowSec;
}

/** Chủ quán đã "đã biết" và mốc đó chưa hết? */
export function isAcked(d: Pick<Device, 'acked_until'>, nowSec: number): boolean {
  return d.acked_until != null && d.acked_until > nowSec;
}

/** Server có hỗ trợ ack/pause không? Các trường vắng mặt = server cũ: khi đó KHÔNG hiện nút (bấm sẽ ra 404 khó hiểu). */
export const supportsAck = (d: Pick<Device, 'acked_until'>): boolean => d.acked_until !== undefined;
export const supportsPause = (d: Pick<Device, 'paused_until'>): boolean => d.paused_until !== undefined;

/**
 * Hiện nút "Đã biết, đang xử lý" CHỈ KHI: server hỗ trợ, đang có sự cố (phase khác 'ok'), không đang tạm dừng,
 * và chưa "đã biết" (acked_until trống hoặc đã qua).
 */
export function canAck(d: Pick<Device, 'phase' | 'acked_until' | 'paused_until'>, nowSec: number): boolean {
  if (!supportsAck(d)) return false;
  if (d.phase === 'ok') return false;
  if (isPaused(d, nowSec)) return false;
  return !isAcked(d, nowSec);
}

/** "14:30" nếu cùng ngày (giờ Việt Nam) với `nowSec`, ngược lại "14:30 05/02". */
export function formatUntil(ts: number, nowSec: number): string {
  const a = vnParts(ts);
  const b = vnParts(nowSec);
  const sameDay = a.year === b.year && a.month === b.month && a.day === b.day;
  return sameDay ? formatVnTime(ts) : `${formatVnTime(ts)} ${formatVnDate(ts)}`;
}

/** Câu xác nhận sau khi bấm "Đã biết". */
export function ackedMessage(untilSec: number, nowSec: number): string {
  return `Đã ghi nhận, sẽ nhắc lại sau ${formatUntil(untilSec, nowSec)} nếu chưa xong.`;
}

/** Biểu ngữ khi đang tạm dừng: "Đang tạm dừng cảnh báo tới dd/MM". */
export function pausedBanner(untilSec: number): string {
  return `Đang tạm dừng cảnh báo tới ${formatVnDate(untilSec)}`;
}

/** Cảnh báo trước khi tạm dừng (bắt buộc hiện). */
export function pauseWarning(days: number, nowSec: number): string {
  const until = nowSec + days * 86400;
  return `Tạm dừng cảnh báo ${days} ngày (tới ${formatVnDate(until)})? Trong thời gian này bạn sẽ KHÔNG nhận cảnh báo nào, kể cả khi tủ hỏng hoặc mất điện. Cảnh báo tự bật lại khi hết hạn, hoặc bạn bấm "Bật lại" bất cứ lúc nào.`;
}
