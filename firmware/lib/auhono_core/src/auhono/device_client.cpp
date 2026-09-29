#include "auhono/device_client.h"

#include "auhono/time_policy.h"

namespace auhono {

ServerReply DeviceClient::call(const std::string& method, const std::string& pathAndQuery,
                               const uint8_t* body, size_t bodyLen) {
  ServerReply reply;
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    platform_.feedWatchdog();

    HttpRequest req;
    req.method = method;
    req.pathAndQuery = pathAndQuery;
    req.hasSignature = true;
    req.body = body;
    req.bodyLen = bodyLen;
    req.headers = signer_.sign(method, pathAndQuery, platform_.unixNow(), seq_.next(), body, bodyLen);

    last_ = http_.perform(req);
    reply = parseReply(last_.status, last_.body.data(), last_.body.size());

    if (reply.kind == ReplyKind::Ok) {
      if (reply.hasServerTime &&
          shouldAdoptServerTime(platform_.clockTrusted(), platform_.unixNow(), reply.serverTime, false)) {
        platform_.setUnix(static_cast<uint32_t>(reply.serverTime));
      }
      return reply;
    }
    if (reply.kind == ReplyKind::ClockSkew) {
      // Server đã xác thực chữ ký và cho biết giờ chuẩn: chỉnh rồi ký lại với seq mới.
      if (!shouldAdoptServerTime(platform_.clockTrusted(), platform_.unixNow(), reply.serverTime, true)) return reply;
      platform_.setUnix(static_cast<uint32_t>(reply.serverTime));
      continue;
    }
    if (reply.kind == ReplyKind::Replay) {
      if (reply.hasLastSeq) seq_.raiseTo(reply.lastSeq);
      continue;  // không có last_seq thì next() tự tăng thêm 1
    }
    return reply;  // 400/401/413/5xx/lỗi mạng: để tầng trên quyết định
  }
  return reply;
}

bool DeviceClient::syncTimeFromServer() {
  HttpRequest req;
  req.method = "GET";
  req.pathAndQuery = "/v1/time";
  req.hasSignature = false;
  last_ = http_.perform(req);
  uint64_t t = 0;
  if (last_.status != 200 || !parseServerTime(last_.body.data(), last_.body.size(), t)) return false;
  if (!shouldAdoptServerTime(platform_.clockTrusted(), platform_.unixNow(), t, false)) return false;
  platform_.setUnix(static_cast<uint32_t>(t));
  return true;
}

}  // namespace auhono
