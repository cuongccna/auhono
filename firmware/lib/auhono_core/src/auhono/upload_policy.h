// Khi nào gửi: ngưỡng, giới hạn gửi ngay, và nhịp gửi định kỳ.
#pragma once
#include <cstdint>

namespace auhono {

/// Ngưỡng cảnh báo (centi-độ). Mặc định -40/-18 °C cho tới khi server trả `config`.
struct Thresholds {
  int16_t minCenti = -4000;
  int16_t maxCenti = -1800;

  bool outOfRange(int16_t centi) const { return centi < minCenti || centi > maxCenti; }
  bool operator==(const Thresholds& o) const { return minCenti == o.minCenti && maxCenti == o.maxCenti; }

  /// Ngưỡng từ server có hợp lý không (min < max, trong dải cảm biến).
  static bool isSane(int32_t minCenti, int32_t maxCenti) {
    return minCenti >= -6000 && maxCenti <= 12500 && minCenti < maxCenti;
  }
};

/// Giới hạn tần suất: tối thiểu `intervalMs` giữa hai lần được phép. Dùng millis() 32-bit
/// (so sánh bằng phép trừ nên đúng cả khi millis tràn sau ~49 ngày).
class IntervalLimiter {
 public:
  explicit IntervalLimiter(uint32_t intervalMs) : interval_(intervalMs) {}
  bool canAcquire(uint32_t nowMs) const { return !used_ || static_cast<uint32_t>(nowMs - last_) >= interval_; }
  bool tryAcquire(uint32_t nowMs) {
    if (!canAcquire(nowMs)) return false;
    used_ = true;
    last_ = nowMs;
    return true;
  }

 private:
  uint32_t interval_;
  uint32_t last_ = 0;
  bool used_ = false;
};

enum class UploadReason : uint8_t { None, Periodic, Immediate, Retry };

/// Quyết định thời điểm gửi. poll() tự "ghi nhận" lần thử khi trả về khác None.
///  - Định kỳ: mỗi `periodMs` (mặc định 5 phút; lần đầu gửi ngay khi có dữ liệu).
///  - Gửi ngay: có số đo vượt ngưỡng, nhưng tối đa 1 lần / `immediateMinMs` (mặc định 60 s).
///  - Thử lại: sau thất bại, chỉ thử khi hết thời gian backoff (onFailure).
class UploadPolicy {
 public:
  UploadPolicy(uint32_t periodMs = 300000, uint32_t immediateMinMs = 60000)
      : period_(periodMs), immediate_(immediateMinMs) {}

  /// Báo có số đo mới; `outOfRange` = vượt ngưỡng hiện hành.
  void noteReading(bool outOfRange) { if (outOfRange) immediatePending_ = true; }

  UploadReason poll(uint32_t nowMs, bool haveData);

  void onSuccess() { retryPending_ = false; }
  void onFailure(uint32_t nowMs, uint32_t retryDelayMs) {
    retryPending_ = true;
    retryAt_ = nowMs + retryDelayMs;
  }

 private:
  uint32_t period_;
  IntervalLimiter immediate_;
  bool attempted_ = false;
  uint32_t lastAttempt_ = 0;
  bool immediatePending_ = false;
  bool retryPending_ = false;
  uint32_t retryAt_ = 0;
};

}  // namespace auhono
