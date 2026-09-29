// Backoff khi gửi lỗi: 30 s -> 1 -> 2 -> 5 phút (không vượt 5 phút), cộng ngẫu nhiên ±20%
// để nhiều máy không dồn cùng lúc sau khi mất điện (docs/PROTOCOL.md).
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
  explicit Backoff(IRandom& rng) : rng_(rng) {}

  /// Thời gian chờ (ms) trước lần thử tiếp theo, rồi tăng bậc. Luôn nằm trong [0,8x; 1,2x] của bậc.
  uint32_t nextDelayMs();
  /// Gọi khi thành công: quay về bậc đầu.
  void reset() { step_ = 0; }
  uint8_t step() const { return step_; }

  static constexpr uint32_t kStepsMs[4] = {30000, 60000, 120000, 300000};
  static constexpr uint32_t kMaxBaseMs = 300000;

 private:
  IRandom& rng_;
  uint8_t step_ = 0;
};

}  // namespace auhono
