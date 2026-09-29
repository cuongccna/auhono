// Chính sách Wi-Fi thuần túy: phân loại lý do rớt mạng và quyết định khi nào mở cổng cấu hình.
#pragma once
#include <cstdint>

namespace auhono {

/// Vì sao chưa kết nối được (để báo cho chủ quán trên trang cấu hình và bằng đèn LED).
enum class WifiFail : uint8_t {
  None,
  NoApFound,   // không thấy mạng tên đó: sai tên, router tắt/đang khởi động, hoặc router chỉ phát 5 GHz (ESP32-C3 chỉ 2.4 GHz)
  AuthFailed,  // thấy mạng nhưng bị từ chối/bắt tay lỗi: gần như chắc chắn sai mật khẩu (hoặc mạng WPA3 chuyển tiếp lạ)
  Other,       // nguyên nhân khác (mất tín hiệu, router đá ra...)
};

/// Ánh xạ mã `WIFI_REASON_*` của ESP-IDF 4.4 (esp_wifi_types.h). Mã 8 (ASSOC_LEAVE: ta tự ngắt) không mang thông tin
/// nên trả None — người gọi phải bỏ qua, không được ghi đè lý do thật trước đó.
WifiFail classifyDisconnectReason(uint8_t reason);

/// Thiết bị đã lưu Wi-Fi mà mất kết nối: có nên mở Wi-Fi cấu hình (Auhono-XXXX) chưa?
///  - Mất mạng >= 20 phút (mọi lý do): mở. Đủ lâu để router khởi động lại sau mất điện (2-10 phút) mà không mở nhầm.
///  - Router THẤY nhưng liên tục từ chối (sai mật khẩu, vừa đổi mật khẩu) >= 5 phút: mở sớm, vì router đang sống
///    nên đây không phải triệu chứng mất điện.
bool shouldOpenPortal(uint32_t downForMs, WifiFail lastFail, uint32_t failStableMs);

constexpr uint32_t kPortalAfterAnyFailMs = 20u * 60u * 1000u;
constexpr uint32_t kPortalAfterAuthFailMs = 5u * 60u * 1000u;

}  // namespace auhono
