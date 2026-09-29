// Phân loại thất bại khi nói chuyện với server và chọn nhịp thử lại tương ứng.
//   Tạm thời (mạng đứt, 5xx, trang lạ 200 của Wi-Fi công cộng, lệch seq): thử lại nhanh (30 s .. 5 phút).
//   Dai dẳng (401 thu hồi/sai khóa, 429/1015, 403, 404, 3xx, lệch giờ không sửa được): thử lại CHẬM
//   (5 phút .. 1 giờ), không gõ cửa server dồn dập, nhưng vẫn tự hồi phục khi sự cố hết.
#pragma once
#include <cstdint>

#include "auhono/backoff.h"
#include "auhono/server_reply.h"

namespace auhono {

enum class FailClass : uint8_t { None, Transient, Persistent };

/// Phân loại phản hồi thất bại (kind != Ok). Ok -> None.
FailClass classifyFailure(const ServerReply& r);

class RetryScheduler {
 public:
  explicit RetryScheduler(IRandom& rng) : fast_(rng), slow_(rng, Backoff::kSlowStepsMs, 5) {}
  /// Thời gian chờ (ms) cho lần thử tiếp theo theo loại thất bại; tăng bậc của loại đó.
  uint32_t nextDelayMs(FailClass c) { return c == FailClass::Persistent ? slow_.nextDelayMs() : fast_.nextDelayMs(); }
  void reset() { fast_.reset(); slow_.reset(); }

 private:
  Backoff fast_;
  Backoff slow_;
};

}  // namespace auhono
