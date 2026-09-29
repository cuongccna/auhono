// Chính sách đồng hồ. ESP32-C3 không có RTC: sau khi cấp điện giờ là 1970 cho tới khi
// đồng bộ NTP (hoặc lấy từ server). Số đo chỉ được ghi khi giờ ĐÁNG TIN.
#pragma once
#include <cstdint>

namespace auhono {

/// 2025-01-01T00:00:00Z. Giờ nhỏ hơn mức này coi như chưa đồng bộ.
constexpr uint32_t kMinValidUnix = 1735689600;
/// Chặn giá trị vô lý (năm 2100).
constexpr uint64_t kMaxValidUnix = 4102444800ULL;

inline bool isPlausibleUnix(uint64_t t) { return t >= kMinValidUnix && t < kMaxValidUnix; }

/// Đã tới hạn `deadline` chưa? Mọi mốc thời gian theo millis() 32 bit PHẢI so sánh bằng hàm này (phép trừ có dấu), không bao giờ
/// bằng `now >= deadline`: millis() tràn sau 49,7 ngày. Đúng khi khoảng cách tới mốc < 2^31 ms (24,8 ngày) — mọi mốc của
/// firmware (tối đa 6 giờ) đều nhỏ hơn nhiều.
inline bool reached(uint32_t now, uint32_t deadline) { return static_cast<int32_t>(now - deadline) >= 0; }

/// Có nên chỉnh đồng hồ theo `serverTime` (từ /v1/time hoặc phản hồi đã ký) không?
///  - `forced` (401 clock_skew): server đã xác thực ta và nói giờ lệch => luôn chỉnh.
///  - Đồng hồ chưa đáng tin (NTP lỗi): chỉnh.
///  - Đồng hồ đang đáng tin: chỉ chỉnh khi lệch > 120 s (tránh giật giờ vì độ trễ mạng).
bool shouldAdoptServerTime(bool clockTrusted, uint32_t localNow, uint64_t serverTime, bool forced);

}  // namespace auhono
