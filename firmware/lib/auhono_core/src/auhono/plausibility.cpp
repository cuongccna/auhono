#include "auhono/plausibility.h"

namespace auhono {

namespace {
int32_t absDiff(int16_t a, int16_t b) {
  const int32_t d = static_cast<int32_t>(a) - static_cast<int32_t>(b);
  return d < 0 ? -d : d;
}
}  // namespace

Verdict ReadingFilter::onSample(int16_t centi, uint32_t monoS) {
  // Đang chờ xác nhận nhưng đã quá lâu (vòng lặp bị chặn, v.v.): coi số đo này là mới.
  if (pending_ && static_cast<uint32_t>(monoS - pendingT_) > kPendingExpireS) pending_ = false;

  const bool nearLast = hasBaseline_ && absDiff(centi, last_) <= kJumpCenti;

  if (pending_) {
    // (a) về lại gần số cũ: số nghi ngờ là gai nhiễu.  (b) khớp số nghi ngờ: thay đổi thật.
    if (nearLast || absDiff(centi, pendingC_) <= kAgreeCenti) {
      accept(centi, monoS);
      return Verdict::Accept;
    }
    pendingC_ = centi;  // không khớp gì cả: nhiễu. Thử lại với giá trị mới làm "nghi ngờ", tới hết số lần.
    pendingT_ = monoS;
    if (++attempts_ >= kMaxAttempts) {
      pending_ = false;
      return Verdict::Reject;
    }
    return Verdict::Confirm;
  }

  if (nearLast) {
    accept(centi, monoS);
    return Verdict::Accept;
  }

  // Nhảy lớn, hoặc chưa có số đo nào: cần xác nhận bằng lần đo lại.
  pending_ = true;
  pendingC_ = centi;
  pendingT_ = monoS;
  attempts_ = 1;
  return Verdict::Confirm;
}

}  // namespace auhono
