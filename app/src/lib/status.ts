// Trạng thái hiển thị của một thiết bị, suy ra từ `phase` (server) và `last_seen`.

/** Im lặng quá ngần này giây thì coi là mất kết nối (khớp offlineSeconds của server = 15 phút). */
export const OFFLINE_AFTER_SECONDS = 15 * 60;

export type DeviceStatus = 'ok' | 'alarm' | 'offline' | 'no_data' | 'paused' | 'unknown';

export const STATUS_LABEL: Record<DeviceStatus, string> = {
  ok: 'Bình thường',
  alarm: 'Đang báo động',
  offline: 'Mất kết nối',
  no_data: 'Chưa có dữ liệu',
  paused: 'Tạm dừng cảnh báo',
  unknown: 'Chưa rõ',
};

/**
 * Ưu tiên:
 *  0. đang tạm dừng cảnh báo (paused_until còn hiệu lực) → "Tạm dừng": chủ quán cố ý nghỉ/rút điện, KHÔNG được hiện
 *     "Mất kết nối" như một sự cố (server cũng không gửi tin nào trong lúc này);
 *  1. chưa từng gửi số đo → "Chưa có dữ liệu";
 *  2. im lặng quá 15 phút hoặc server đã đánh dấu offline → "Mất kết nối" (không biết nhiệt độ thật, nên đứng trên "Bình thường");
 *  3. đang vượt ngưỡng → "Đang báo động"; còn lại "Bình thường".
 * Phase lạ (server thêm trạng thái mới) → "Chưa rõ", không giả vờ là bình thường.
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
  if (phase === 'temp_alarm') return 'alarm';
  if (phase === 'ok') return 'ok';
  return 'unknown';
}
