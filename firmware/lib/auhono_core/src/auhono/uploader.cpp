#include "auhono/uploader.h"

#include "auhono/time_policy.h"

namespace auhono {

FlushResult ReadingsUploader::flush() {
  FlushResult res;

  const uint32_t now = platform_.unixNow();
  if (platform_.clockTrusted() && isPlausibleUnix(now) && now > kMaxAgeSeconds) {
    buffer_.dropOlderThan(now - kMaxAgeSeconds + kAgeMarginSeconds);
  }

  size_t limit = kMaxBatch;  // giảm một nửa khi gặp 413
  for (size_t batches = 0; !buffer_.empty() && batches < kMaxBatchesPerFlush; batches++) {
    Reading batch[kMaxBatch];
    const size_t n = buffer_.peek(batch, limit);
    char body[1024];  // 20 số đo ~ 560 byte; server giới hạn 4096
    const size_t len = buildReadingsBody(body, sizeof body, fw_, batch, n);
    if (len == 0) {  // không thể xảy ra với n <= 20; phòng thủ để không kẹt vòng lặp
      res.ok = false;
      res.lastKind = ReplyKind::Unknown;
      res.remaining = buffer_.size();
      return res;
    }

    const ServerReply r = client_.call("POST", "/v1/readings", reinterpret_cast<const uint8_t*>(body), len);
    res.lastKind = r.kind;

    if (r.kind == ReplyKind::Ok) {
      res.reachedServer = true;
      res.sentReadings += n;
      buffer_.popFront(n);
      if (r.hasConfig && !(r.config == thresholds_)) {
        thresholds_ = r.config;
        res.thresholdsChanged = true;
      }
      continue;
    }
    if (r.kind == ReplyKind::BadRequest) {
      // "bỏ gói, không gửi lại nguyên xi"
      res.discardedReadings += n;
      buffer_.popFront(n);
      continue;
    }
    if (r.kind == ReplyKind::TooLarge) {
      if (limit > 1) { limit /= 2; continue; }
      res.discardedReadings += n;
      buffer_.popFront(n);
      continue;
    }
    res.ok = false;  // 401 / 5xx / mạng / lệch giờ không sửa được: giữ số đo, backoff ở tầng trên
    res.remaining = buffer_.size();
    return res;
  }
  res.remaining = buffer_.size();  // > 0 nếu chạm giới hạn số gói mỗi lần; không phải lỗi
  return res;
}

}  // namespace auhono
