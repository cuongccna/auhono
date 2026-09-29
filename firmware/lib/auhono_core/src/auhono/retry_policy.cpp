#include "auhono/retry_policy.h"

namespace auhono {

FailClass classifyFailure(const ServerReply& r) {
  switch (r.kind) {
    case ReplyKind::Ok:           return FailClass::None;
    case ReplyKind::NetworkError: return FailClass::Transient;
    case ReplyKind::ServerError:  return FailClass::Transient;
    case ReplyKind::Replay:       return FailClass::Transient;   // đã sửa seq; thử lại sớm
    case ReplyKind::Unauthorized: return FailClass::Persistent;
    case ReplyKind::RateLimited:  return FailClass::Persistent;
    case ReplyKind::ClockSkew:    return FailClass::Persistent;  // chỉ tới đây khi không chỉnh được giờ
    case ReplyKind::TooLarge:     return FailClass::Persistent;
    case ReplyKind::BadRequest:   return FailClass::Persistent;
    case ReplyKind::Unknown:
      // 200 nhưng body sai = trang đăng nhập/quảng cáo của Wi-Fi công cộng hoặc lỗi tạm: thử lại nhanh.
      // Mã khác (3xx/403/404/...) thường không tự hết trong vài phút.
      return (r.status == 200) ? FailClass::Transient : FailClass::Persistent;
  }
  return FailClass::Transient;
}

}  // namespace auhono
