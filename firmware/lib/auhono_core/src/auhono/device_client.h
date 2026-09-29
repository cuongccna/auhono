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
  /// Giây từ lúc khởi động (đơn điệu, 64-bit trên chip nên không tràn; KHÔNG bị NTP/setUnix làm nhảy).
  /// Dùng để đóng dấu số đo trước khi có giờ thật (xem readings.h).
  virtual uint32_t monoSeconds() = 0;
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
  /// Kết nối TLS thất bại vì KHÔNG XÁC THỰC được chứng chỉ máy chủ (CA gốc đổi/hết hạn, bị chặn/can thiệp).
  /// Dùng cho chế độ cứu hộ OTA (maintenance.h, TlsRescue).
  bool certError = false;
};

/// Nguồn body được dựng LẠI ở mỗi lần thử (sau khi đồng hồ được chỉnh theo server thì giờ trong body cũng
/// phải đổi theo, nếu không số đo sẽ mang dấu thời gian sai và server (INSERT OR IGNORE) giữ luôn dữ liệu sai).
class IBodySource {
 public:
  virtual ~IBodySource() = default;
  /// Ghi body vào `out` (tối đa `cap` byte). Trả độ dài; 0 nghĩa là không dựng được (không gửi gì).
  virtual size_t build(char* out, size_t cap) = 0;
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

  /// Như call(), nhưng body được dựng lại (source.build) NGAY TRƯỚC MỖI lần ký/gửi.
  ServerReply callBuilt(const std::string& method, const std::string& pathAndQuery, IBodySource& source,
                        bool requireOkField = true);

  /// Kích thước bộ đệm body dựng sẵn (20 số đo ~ 560 byte; server giới hạn 4096).
  static constexpr size_t kBodyCap = 1024;

  /// GET /v1/time (không ký) để chỉnh giờ khi NTP lỗi. true nếu đã chỉnh được đồng hồ.
  bool syncTimeFromServer();

  /// Cho phép chỉnh đồng hồ theo `server_time` trong phản hồi (Ok và 401 clock_skew). Mặc định true. Đặt false khi kết nối
  /// KHÔNG được xác thực chứng chỉ (OTA cứu hộ): kẻ đứng giữa không được phép đặt giờ của thiết bị.
  void setAllowClockAdopt(bool allow) { allowClockAdopt_ = allow; }

  /// Phản hồi thô của lần gọi gần nhất (để đọc manifest OTA).
  const HttpResponse& lastResponse() const { return last_; }

 private:
  const Signer& signer_;
  SeqCounter& seq_;
  IPlatform& platform_;
  IHttp& http_;
  HttpResponse last_;
  bool allowClockAdopt_ = true;
  char bodyBuf_[kBodyCap];  // DeviceClient nằm trên heap (unique_ptr) nên không tốn stack

  ServerReply run(const std::string& method, const std::string& pathAndQuery, const uint8_t* fixedBody,
                  size_t fixedLen, IBodySource* source, bool requireOkField);
};

}  // namespace auhono
