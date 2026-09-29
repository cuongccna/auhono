// Bộ phân tích HTTP request có GIỚI HẠN cứng, dùng cho cổng cấu hình Wi-Fi.
//
// Vì sao không dùng WebServer của Arduino: nó đọc dòng đầu/các header bằng String không giới hạn, đọc body theo
// Content-Length không giới hạn (realloc tới khi hết heap) và chặn vòng lặp tới 5 s mỗi khách -> ai đứng trong tầm
// Wi-Fi mở cũng có thể làm thiết bị hết RAM/khởi động lại (mất số đo chưa gửi) hoặc "slowloris". Ở đây:
//   - mọi kích thước bị chặn (dòng, tổng header, số header, body) -> lỗi 4xx cụ thể, không bao giờ cấp phát theo số client gửi;
//   - phân tích tăng dần từng byte (không chặn); thời hạn/đồng thời do tầng ổ cắm (portal.cpp) quản lý;
//   - chỉ nhận Content-Length (không Transfer-Encoding), số thập phân thuần.
// Thuần C++, chạy được trên máy và fuzz được (test/test_core/t_portal_http.cpp).
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

namespace auhono {

enum class HttpMethod : uint8_t { Other, Get, Head, Post };

enum class HttpError : uint8_t {
  None,
  RequestLineTooLong,  // 414
  HeadersTooLarge,     // 431
  BadRequest,          // 400
  BodyTooLarge,        // 413
  Unsupported,         // 501 (Transfer-Encoding: chunked...)
};

/// Mã HTTP tương ứng để trả cho client.
int httpStatusFor(HttpError e);

struct HttpLimits {
  size_t maxRequestLine = 200;   // "GET /generate_204 HTTP/1.1" ~ 30; URL dài hơn là bất thường
  size_t maxHeaderBytes = 1024;  // tổng các dòng header (điện thoại gửi ~300-600 byte)
  size_t maxHeaders = 24;
  size_t maxBody = 1024;         // form Wi-Fi: SSID(32 byte -> tối đa 96 mã hóa %) + mật khẩu (63 -> 189) + tên trường ~ 400
};

class HttpRequestParser {
 public:
  enum class State : uint8_t { NeedMore, Done, Error };

  explicit HttpRequestParser(HttpLimits limits = HttpLimits()) : limits_(limits) {}

  /// Đưa thêm byte vào. Sau Done/Error các byte tiếp theo bị bỏ qua. Trả trạng thái hiện tại.
  State feed(const uint8_t* data, size_t len);
  State state() const { return state_; }
  HttpError error() const { return error_; }
  void reset();

  HttpMethod method() const { return method_; }
  const std::string& path() const { return path_; }   // không gồm query
  const std::string& query() const { return query_; }
  const std::string& host() const { return host_; }   // header Host (hoặc authority của URL tuyệt đối)
  size_t contentLength() const { return contentLength_; }
  const std::string& body() const { return body_; }

 private:
  enum class Phase : uint8_t { RequestLine, Headers, Body };

  void fail(HttpError e) { state_ = State::Error; error_ = e; }
  void onRequestLine();
  void onHeaderLine();
  void onHeadersEnd();

  HttpLimits limits_;
  State state_ = State::NeedMore;
  HttpError error_ = HttpError::None;
  Phase phase_ = Phase::RequestLine;
  std::string line_;
  size_t headerBytes_ = 0;
  size_t headerCount_ = 0;

  HttpMethod method_ = HttpMethod::Other;
  std::string path_;
  std::string query_;
  std::string host_;
  bool haveContentLength_ = false;
  size_t contentLength_ = 0;
  std::string body_;
};

}  // namespace auhono
