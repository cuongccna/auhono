// Backoff khi gửi lỗi, cộng ngẫu nhiên ±20% để nhiều máy không dồn cùng lúc sau mất điện (docs/PROTOCOL.md).
//   Nhanh (mạng/5xx):   30 s -> 1 -> 2 -> 5 phút (không vượt 5 phút)
//   Chậm (401/429/403...): 5 -> 10 -> 20 -> 30 -> 60 phút  (thiết bị bị thu hồi / sai khóa / bị giới hạn tốc độ:
//                          không được gõ cửa server dồn dập; 1 lần/giờ là đủ để tự hồi phục khi sự cố hết)
//   Wi-Fi:              10 s -> 20 -> 30 -> 60 s (nối lại router; không tốn server, nhưng cũng không nên dồn)
#pragma once
#include <cstdint>

namespace auhono {

/// Nguồn ngẫu nhiên (esp_random trên chip; giả lập khi test).
class IRandom {
 public:
  virtual ~IRandom() = default;
  virtual uint32_t next() = 0;
};

class Backoff {
 public:
  static constexpr uint32_t kStepsMs[4] = {30000, 60000, 120000, 300000};          // nhanh (mặc định)
  static constexpr uint32_t kSlowStepsMs[5] = {300000, 600000, 1200000, 1800000, 3600000};
  static constexpr uint32_t kWifiStepsMs[4] = {10000, 20000, 30000, 60000};
  static constexpr uint32_t kMaxBaseMs = 300000;  // trần của bậc nhanh

  explicit Backoff(IRandom& rng) : rng_(rng), steps_(kStepsMs), count_(4) {}
  /// Dùng bảng bậc riêng (mảng phải sống lâu hơn Backoff; dùng các hằng ở trên).
  Backoff(IRandom& rng, const uint32_t* steps, uint8_t count) : rng_(rng), steps_(steps), count_(count ? count : 1) {}

  /// Thời gian chờ (ms) trước lần thử tiếp theo, rồi tăng bậc. Luôn nằm trong [0,8x; 1,2x] của bậc.
  uint32_t nextDelayMs();
  /// Gọi khi thành công: quay về bậc đầu.
  void reset() { step_ = 0; }
  uint8_t step() const { return step_; }

 private:
  IRandom& rng_;
  const uint32_t* steps_;
  uint8_t count_;
  uint8_t step_ = 0;
};

}  // namespace auhono
