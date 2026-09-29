// Máy khách có ký: dựng chữ ký, gửi qua IHttp, và tự xử lý 401 clock_skew / 409 replay
// theo docs/PROTOCOL.md. Không phụ thuộc phần cứng: HTTP, đồng hồ, watchdog đều là giao diện.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

#include "auhono/seq_counter.h"
#include "auhono/server_reply.h"
#include "auhono/signer.h"

namespace auhono {

/// Dịch vụ nền tảng (millis, đồng hồ, watchdog). Trên chip: EspPlatform (src/platform_esp32.cpp).
class IPlatform {
 public:
  virtual ~IPlatform() = default;
  virtual uint32_t millis() = 0;
  /// Giờ unix hiện tại (giây). Chỉ có ý nghĩa khi clockTrusted().
  virtual uint32_t unixNow() = 0;
  /// Giờ đã được đồng bộ từ NTP hoặc từ server (không phải 1970 mặc định).
  virtual bool clockTrusted() = 0;
  /// Đặt đồng hồ hệ thống và đánh dấu là đáng tin.
  virtual void setUnix(uint32_t t) = 0;
  virtual void feedWatchdog() = 0;
};

struct HttpRequest {
  std::string method;        // "GET" / "POST"
  std::string pathAndQuery;  // "/v1/readings", "/v1/ota/check?current=1.0.0"
  bool hasSignature = false; // false cho GET /v1/time (không cần ký)
  SignedHeaders headers;
  const uint8_t* body = nullptr;  // đúng các byte đã ký
  size_t bodyLen = 0;
};

struct HttpResponse {
  int status = 0;    // <= 0: lỗi mạng
  std::string body;  // đã giới hạn kích thước ở tầng dưới
};

class IHttp {
 public:
  virtual ~IHttp() = default;
  virtual HttpResponse perform(const HttpRequest& req) = 0;
};

class DeviceClient {
 public:
  static constexpr int kMaxAttempts = 3;  // 1 lần đầu + tối đa 2 lần sửa (giờ / seq)

  DeviceClient(const Signer& signer, SeqCounter& seq, IPlatform& platform, IHttp& http)
      : signer_(signer), seq_(seq), platform_(platform), http_(http) {}

  /// Gửi request có ký. Mỗi lần thử dùng seq mới và giờ hiện tại.
  ///  - ClockSkew: đặt lại đồng hồ theo server_time rồi gửi lại.
  ///  - Replay: seq = max(seq, last_seq) rồi gửi lại.
  /// Trả phản hồi cuối cùng (có thể vẫn là lỗi nếu hết số lần thử).
  /// `requireOkField`: xem parseReply(). Đặt false cho GET /v1/ota/check.
  ServerReply call(const std::string& method, const std::string& pathAndQuery, const uint8_t* body,
                   size_t bodyLen, bool requireOkField = true);

  /// GET /v1/time (không ký) để chỉnh giờ khi NTP lỗi. true nếu đã chỉnh được đồng hồ.
  bool syncTimeFromServer();

  /// Phản hồi thô của lần gọi gần nhất (để đọc manifest OTA).
  const HttpResponse& lastResponse() const { return last_; }

 private:
  const Signer& signer_;
  SeqCounter& seq_;
  IPlatform& platform_;
  IHttp& http_;
  HttpResponse last_;
};

}  // namespace auhono
