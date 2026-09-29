// Đồng hồ theo giờ SERVER, không tin đồng hồ điện thoại.
// Điện thoại của chủ quán có thể lệch giờ (chỉnh tay, tắt tự động cập nhật giờ, pin yếu...). Nếu cứ dùng Date.now()
// thì "mất kết nối", "x phút trước" và cửa sổ 24 giờ của biểu đồ đều sai. Mỗi phản hồi server có `server_time`;
// ta lưu độ lệch = server_time - giờ điện thoại (tại điểm giữa lúc gửi và lúc nhận, để bù độ trễ mạng 3G).
// Server cũ chưa trả server_time thì độ lệch = 0 (dùng giờ điện thoại như trước).

/** Mốc hợp lý cho Unix giây (2020..2100): loại giá trị rác như 0, -1, hay mili-giây. */
const MIN_PLAUSIBLE = 1_577_836_800;
const MAX_PLAUSIBLE = 4_102_444_800;
/** Phản hồi mất quá lâu thì độ trễ không đoán được: bỏ qua, giữ độ lệch cũ. */
const MAX_ROUND_TRIP_MS = 60_000;

let offsetSeconds = 0;
let synced = false;

/** Ghi nhận `server_time` (Unix giây) của một phản hồi. `sentAtMs`/`receivedAtMs` là Date.now() của điện thoại. */
export function syncClock(serverTime: unknown, sentAtMs: number, receivedAtMs: number): boolean {
  if (typeof serverTime !== 'number' || !Number.isFinite(serverTime)) return false;
  if (serverTime < MIN_PLAUSIBLE || serverTime > MAX_PLAUSIBLE) return false;
  if (!Number.isFinite(sentAtMs) || !Number.isFinite(receivedAtMs) || receivedAtMs < sentAtMs) return false;
  if (receivedAtMs - sentAtMs > MAX_ROUND_TRIP_MS) return false;
  const phoneAtServerMs = (sentAtMs + receivedAtMs) / 2;
  offsetSeconds = serverTime - phoneAtServerMs / 1000;
  synced = true;
  return true;
}

/** Bây giờ theo giờ server (Unix giây, có phần lẻ). */
export function serverNow(): number {
  return Date.now() / 1000 + offsetSeconds;
}

/** Độ lệch hiện tại (giây): server - điện thoại. Dương = điện thoại chạy chậm. */
export function clockOffsetSeconds(): number {
  return offsetSeconds;
}

/** Đã từng nhận server_time hợp lệ chưa (để hiện cảnh báo lệch giờ, nếu cần). */
export function isClockSynced(): boolean {
  return synced;
}

/** Chỉ dùng trong test. */
export function resetClock(): void {
  offsetSeconds = 0;
  synced = false;
}
