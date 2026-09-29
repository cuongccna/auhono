#include "auhono/upload_policy.h"

namespace auhono {

UploadReason UploadPolicy::poll(uint32_t nowMs, bool haveData) {
  if (!haveData) return UploadReason::None;

  if (retryPending_) {
    // Đang trong chuỗi backoff: mọi lần thử (kể cả "gửi ngay") phải chờ hết backoff.
    if (static_cast<int32_t>(nowMs - retryAt_) < 0) return UploadReason::None;
    attempted_ = true;
    lastAttempt_ = nowMs;
    immediatePending_ = false;
    return UploadReason::Retry;
  }

  if (!attempted_ || static_cast<uint32_t>(nowMs - lastAttempt_) >= period_) {
    attempted_ = true;
    lastAttempt_ = nowMs;
    immediatePending_ = false;  // gói định kỳ mang theo cả số đo vượt ngưỡng
    return UploadReason::Periodic;
  }

  if (immediatePending_ && immediate_.tryAcquire(nowMs)) {
    immediatePending_ = false;
    lastAttempt_ = nowMs;
    return UploadReason::Immediate;
  }
  return UploadReason::None;
}

}  // namespace auhono
