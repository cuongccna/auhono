// Nhận diện nhấn giữ nút (nút BOOT của bo mạch): giữ 5 s = mở chế độ cấu hình Wi-Fi;
// giữ 15 s RỒI NHẢ = xóa Wi-Fi đã lưu (trả về xuất xưởng, giữ nguyên mã/khóa thiết bị).
//
// Chống kích hoạt nhầm (nút kẹt trong vỏ hộp, ngón tay/đồ vật đè, nhiễu):
//   - Nút đang bị nhấn NGAY LÚC bắt đầu chạy: bỏ qua cho tới khi nhả ra một lần.
//   - Xóa Wi-Fi chỉ thực hiện khi NHẢ nút sau khi đã giữ 15..60 s. Nút kẹt (không bao giờ nhả, hoặc giữ quá `stuckMs`)
//     không bao giờ xóa được gì. Trong lúc đó `wipeArmed()` = true để tầng trên nháy đèn báo "nhả nút bây giờ sẽ xóa Wi-Fi".
//   - Phải giữ LIÊN TỤC; nhả (kể cả nhiễu ngắn) là đếm lại từ đầu.
#pragma once
#include <cstdint>

namespace auhono {

enum class ButtonEvent : uint8_t { None, LongPress, VeryLongPress };

class ButtonGesture {
 public:
  ButtonGesture(uint32_t longMs = 5000, uint32_t veryLongMs = 15000, uint32_t stuckMs = 60000)
      : long_(longMs), veryLong_(veryLongMs), stuck_(stuckMs) {}

  /// Gọi liên tục trong loop().
  ///  - LongPress: phát MỘT lần khi giữ tới `longMs`.
  ///  - VeryLongPress: phát MỘT lần lúc NHẢ nút, nếu đã giữ trong [veryLongMs, stuckMs).
  ButtonEvent update(bool pressed, uint32_t nowMs) {
    if (!seen_) {  // lần gọi đầu tiên
      seen_ = true;
      if (pressed) ignore_ = true;  // đang bị nhấn từ trước khi chạy: chờ nhả
    }
    if (!pressed) {
      ButtonEvent ev = ButtonEvent::None;
      if (down_ && !ignore_) {
        const uint32_t held = static_cast<uint32_t>(nowMs - since_);
        if (held >= veryLong_ && held < stuck_) ev = ButtonEvent::VeryLongPress;
      }
      down_ = false; ignore_ = false; firedLong_ = false; armed_ = false;
      return ev;
    }
    if (ignore_) return ButtonEvent::None;
    if (!down_) { down_ = true; since_ = nowMs; return ButtonEvent::None; }
    const uint32_t held = static_cast<uint32_t>(nowMs - since_);
    if (held >= stuck_) { ignore_ = true; armed_ = false; return ButtonEvent::None; }  // kẹt: bỏ qua tới khi nhả
    armed_ = held >= veryLong_;
    if (!firedLong_ && held >= long_) { firedLong_ = true; return ButtonEvent::LongPress; }
    return ButtonEvent::None;
  }

  /// Đang giữ đủ lâu để việc nhả nút sẽ xóa Wi-Fi.
  bool wipeArmed() const { return armed_; }

 private:
  uint32_t long_, veryLong_, stuck_;
  bool seen_ = false, ignore_ = false;
  bool down_ = false, firedLong_ = false, armed_ = false;
  uint32_t since_ = 0;
};

}  // namespace auhono
