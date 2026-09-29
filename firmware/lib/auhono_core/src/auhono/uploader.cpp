#include "auhono/uploader.h"

#include "auhono/time_policy.h"

namespace auhono {

namespace {

/// Dựng body cho `n` số đo đầu hàng theo đồng hồ HIỆN TẠI (gọi lại ở mỗi lần thử của DeviceClient).
class BatchBody : public IBodySource {
 public:
  BatchBody(IPlatform& platform, const char* fw, const Reading* batch, size_t n)
      : platform_(platform), fw_(fw), batch_(batch), n_(n) {}

  size_t build(char* out, size_t cap) override {
    const TimeAnchor anchor{platform_.unixNow(), platform_.monoSeconds()};
    WireReading wire[kMaxBatch];
    if (n_ == 0 || n_ > kMaxBatch) return 0;
    for (size_t i = 0; i < n_; i++) {
      uint32_t u = 0;
      if (!monoToUnix(batch_[i].t, anchor, u)) return 0;  // đã loại trước khi vào đây; phòng thủ
      if (u > anchor.unixNow) u = anchor.unixNow;         // không bao giờ ở tương lai
      wire[i] = WireReading{u, batch_[i].centi};
    }
    return buildReadingsBody(out, cap, fw_, wire, n_);
  }

 private:
  IPlatform& platform_;
  const char* fw_;
  const Reading* batch_;
  size_t n_;
};

}  // namespace

FlushResult ReadingsUploader::flush() {
  FlushResult res;

  if (!platform_.clockTrusted() || !isPlausibleUnix(platform_.unixNow())) {
    res.ok = false;
    res.clockNotReady = true;
    res.lastKind = ReplyKind::Unknown;
    res.failClass = FailClass::Transient;
    res.remaining = buffer_.size();
    return res;
  }

  // 1. Bỏ số đo quá cũ (server sẽ loại) hoặc không đổi được sang giờ unix hợp lý.
  {
    const uint32_t mono = platform_.monoSeconds();
    const uint32_t keep = kMaxAgeSeconds - kAgeMarginSeconds;
    if (mono > keep) res.staleDropped += buffer_.dropOlderThan(mono - keep);
    const TimeAnchor anchor{platform_.unixNow(), mono};
    for (;;) {
      Reading head;
      if (buffer_.peek(&head, 1) == 0) break;
      uint32_t u = 0;
      if (monoToUnix(head.t, anchor, u)) break;
      buffer_.popFront(1);
      ++res.staleDropped;
    }
  }

  const uint32_t startMs = platform_.millis();
  size_t limit = kMaxBatch;  // giảm khi server từ chối cả gói
  for (size_t iter = 0; !buffer_.empty() && iter < kMaxBatchesPerFlush; iter++) {
    if (iter > 0 && static_cast<uint32_t>(platform_.millis() - startMs) >= kFlushBudgetMs) break;

    Reading batch[kMaxBatch];
    const size_t n = buffer_.peek(batch, limit);
    BatchBody body(platform_, fw_, batch, n);
    const ServerReply r = client_.callBuilt("POST", "/v1/readings", body);
    res.lastKind = r.kind;
    res.lastStatus = r.status;

    if (r.kind == ReplyKind::Ok) {
      res.reachedServer = true;
      res.sentReadings += n;
      if (r.accepted < n) res.serverDroppedReadings += n - r.accepted;
      buffer_.popFront(n);
      limit = kMaxBatch;
      if (r.hasConfig && !(r.config == thresholds_)) {
        thresholds_ = r.config;
        res.thresholdsChanged = true;
      }
      continue;
    }

    if (r.kind == ReplyKind::BadRequest || r.kind == ReplyKind::TooLarge) {
      // Server từ chối gói. Đừng xóa cả gói (có thể là lỗi server/giao thức tạm thời, xóa là mất sạch 24 giờ dữ liệu).
      if (n > 1) {  // chia đôi để cô lập số đo "độc"
        limit = n / 2;
        continue;
      }
      if (res.discardedReadings < kMaxPoisonDropsPerFlush) {  // một số đo đơn lẻ vẫn bị từ chối: bỏ nó
        ++res.discardedReadings;
        buffer_.popFront(1);
        limit = kMaxBatch;
        continue;
      }
      // Vượt ngân sách bỏ số đo: nhiều khả năng do server/giao thức, không phải do dữ liệu. Giữ lại, thử chậm.
      res.ok = false;
      res.failClass = FailClass::Persistent;
      res.certError = false;
      res.remaining = buffer_.size();
      return res;
    }

    // 401 / 429 / 5xx / mạng / lệch giờ không sửa được: giữ số đo, backoff ở tầng trên.
    res.ok = false;
    res.failClass = classifyFailure(r);
    res.certError = client_.lastResponse().certError;
    res.remaining = buffer_.size();
    return res;
  }
  res.remaining = buffer_.size();  // > 0 nếu chạm giới hạn gói/thời gian mỗi lần; không phải lỗi
  return res;
}

}  // namespace auhono
