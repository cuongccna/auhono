// Nhận diện nhấn giữ nút (nút BOOT của bo mạch): 5 s = mở chế độ cấu hình Wi-Fi,
// 15 s = xóa Wi-Fi đã lưu (trả về xuất xưởng, giữ nguyên mã/khóa thiết bị).
#pragma once
#include <cstdint>

namespace auhono {

enum class ButtonEvent : uint8_t { None, LongPress, VeryLongPress };

class ButtonGesture {
 public:
  ButtonGesture(uint32_t longMs = 5000, uint32_t veryLongMs = 15000)
      : long_(longMs), veryLong_(veryLongMs) {}

  /// Gọi liên tục trong loop(). Mỗi sự kiện chỉ phát MỘT lần cho mỗi lần nhấn giữ.
  ButtonEvent update(bool pressed, uint32_t nowMs) {
    if (!pressed) { down_ = false; firedLong_ = firedVeryLong_ = false; return ButtonEvent::None; }
    if (!down_) { down_ = true; since_ = nowMs; return ButtonEvent::None; }
    const uint32_t held = static_cast<uint32_t>(nowMs - since_);
    if (!firedVeryLong_ && held >= veryLong_) { firedVeryLong_ = firedLong_ = true; return ButtonEvent::VeryLongPress; }
    if (!firedLong_ && held >= long_) { firedLong_ = true; return ButtonEvent::LongPress; }
    return ButtonEvent::None;
  }

 private:
  uint32_t long_, veryLong_;
  bool down_ = false, firedLong_ = false, firedVeryLong_ = false;
  uint32_t since_ = 0;
};

}  // namespace auhono
