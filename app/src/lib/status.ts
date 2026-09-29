// Trạng thái hiển thị của một thiết bị, suy ra từ `phase` (server) và `last_seen`.

/** Im lặng quá ngần này giây thì coi là mất kết nối (khớp offlineSeconds của server = 15 phút). */
export const OFFLINE_AFTER_SECONDS = 15 * 60;

export type DeviceStatus = 'ok' | 'alarm' | 'offline' | 'no_data' | 'paused' | 'sensor' | 'unknown';

export const STATUS_LABEL: Record<DeviceStatus, string> = {
  ok: 'Bình thường',
  alarm: 'Đang báo động',
  offline: 'Mất kết nối',
  no_data: 'Chưa có dữ liệu',
  paused: 'Tạm dừng cảnh báo',
  sensor: 'Lỗi cảm biến',
  unknown: 'Cần kiểm tra',
};

/**
 * Ưu tiên:
 *  0. đang tạm dừng cảnh báo (paused_until còn hiệu lực) → "Tạm dừng": chủ quán cố ý nghỉ/rút điện, KHÔNG được hiện
 *     "Mất kết nối" như một sự cố (server cũng không gửi tin nào trong lúc này);
 *  1. chưa từng gửi số đo → "Chưa có dữ liệu";
 *  2. im lặng quá 15 phút hoặc server đã đánh dấu offline → "Mất kết nối" (không biết nhiệt độ thật, nên đứng trên "Bình thường");
 *  3. `sensor_fault`: thiết bị VẪN liên lạc (nhịp tim) nhưng >15 phút không có số đo hợp lệ (dây đầu dò đứt/rút) → "Lỗi cảm biến".
 *     Đứng dưới "Mất kết nối" (không liên lạc thì không biết đầu dò ra sao) và trên "Báo động";
 *  4. đang vượt ngưỡng → "Đang báo động"; còn lại "Bình thường".
 * Phase lạ (server mới thêm trạng thái) → "Cần kiểm tra", không giả vờ là bình thường và không ẩn thiết bị.
 * `pausedUntil` vắng mặt/null (server cũ, hoặc không tạm dừng) thì bỏ qua bước 0.
 */
export function deviceStatus(input: {
  phase: string;
  lastSeen: number | null;
  nowSeconds: number;
  pausedUntil?: number | null;
}): DeviceStatus {
  const { phase, lastSeen, nowSeconds, pausedUntil } = input;
  if (pausedUntil != null && pausedUntil > nowSeconds) return 'paused';
  if (lastSeen === null) return 'no_data';
  if (phase === 'offline' || nowSeconds - lastSeen > OFFLINE_AFTER_SECONDS) return 'offline';
  if (phase === 'sensor_fault') return 'sensor';
  if (phase === 'temp_alarm') return 'alarm';
  if (phase === 'ok') return 'ok';
  return 'unknown';
}

/**
 * Độ ưu tiên khi sắp xếp danh sách (nhỏ = lên đầu): sự cố cần xử lý ngay (báo động, lỗi cảm biến) trước,
 * rồi mất kết nối, trạng thái lạ, chưa có dữ liệu, bình thường, cuối cùng là đang tạm dừng.
 */
export const STATUS_RANK: Record<DeviceStatus, number> = {
  alarm: 0,
  sensor: 0,
  offline: 1,
  unknown: 2,
  no_data: 3,
  ok: 4,
  paused: 5,
};

/** Sắp xếp ổn định theo độ ưu tiên; cùng mức giữ nguyên thứ tự server. Không sửa mảng gốc. */
export function sortBySeverity<T>(items: readonly T[], statusOf: (item: T) => DeviceStatus): T[] {
  return items
    .map((item, index) => ({ item, index, rank: STATUS_RANK[statusOf(item)] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.item);
}
