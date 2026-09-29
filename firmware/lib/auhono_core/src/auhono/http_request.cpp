#include "auhono/http_request.h"

namespace auhono {

namespace {

bool isTokenChar(unsigned char c) { return c > 0x20 && c < 0x7f; }

std::string lower(const std::string& s) {
  std::string o = s;
  for (char& c : o) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + 32);
  return o;
}

std::string trim(const std::string& s) {
  size_t b = 0, e = s.size();
  while (b < e && (s[b] == ' ' || s[b] == '\t')) ++b;
  while (e > b && (s[e - 1] == ' ' || s[e - 1] == '\t')) --e;
  return s.substr(b, e - b);
}

}  // namespace

int httpStatusFor(HttpError e) {
  switch (e) {
    case HttpError::None:               return 200;
    case HttpError::RequestLineTooLong: return 414;
    case HttpError::HeadersTooLarge:    return 431;
    case HttpError::BadRequest:         return 400;
    case HttpError::BodyTooLarge:       return 413;
    case HttpError::Unsupported:        return 501;
  }
  return 400;
}

void HttpRequestParser::reset() { *this = HttpRequestParser(limits_); }

HttpRequestParser::State HttpRequestParser::feed(const uint8_t* data, size_t len) {
  for (size_t i = 0; i < len && state_ == State::NeedMore; i++) {
    const unsigned char c = data[i];

    if (phase_ == Phase::Body) {
      body_.push_back(static_cast<char>(c));
      if (body_.size() >= contentLength_) state_ = State::Done;
      continue;
    }

    if (c == '\n') {  // hết dòng (chấp nhận cả LF trần)
      pendingCr_ = false;
      if (phase_ == Phase::RequestLine) onRequestLine();
      else onHeaderLine();
      line_.clear();
      continue;
    }
    if (pendingCr_) { fail(HttpError::BadRequest); break; }        // CR trần giữa dòng: nghi buôn lậu request
    if (c == '\r') { pendingCr_ = true; continue; }
    if ((c < 0x20 && c != '\t') || c == 0x7f) { fail(HttpError::BadRequest); break; }  // ký tự điều khiển (kể cả NUL)

    line_.push_back(static_cast<char>(c));
    if (phase_ == Phase::RequestLine) {
      if (line_.size() > limits_.maxRequestLine) fail(HttpError::RequestLineTooLong);
    } else {
      if (++headerBytes_ > limits_.maxHeaderBytes || line_.size() > limits_.maxHeaderBytes) fail(HttpError::HeadersTooLarge);
    }
  }
  return state_;
}

void HttpRequestParser::onRequestLine() {
  if (line_.empty()) return;  // RFC 7230 3.5: bỏ qua dòng trống đứng trước request line
  const size_t s1 = line_.find(' ');
  const size_t s2 = s1 == std::string::npos ? std::string::npos : line_.find(' ', s1 + 1);
  if (s1 == std::string::npos || s2 == std::string::npos || line_.find(' ', s2 + 1) != std::string::npos) {
    fail(HttpError::BadRequest);
    return;
  }
  const std::string m = line_.substr(0, s1);
  std::string target = line_.substr(s1 + 1, s2 - s1 - 1);
  const std::string ver = line_.substr(s2 + 1);
  if (ver != "HTTP/1.1" && ver != "HTTP/1.0") { fail(HttpError::BadRequest); return; }
  for (char c : m) if (!isTokenChar(static_cast<unsigned char>(c))) { fail(HttpError::BadRequest); return; }
  for (char c : target) if (!isTokenChar(static_cast<unsigned char>(c))) { fail(HttpError::BadRequest); return; }
  if (target.empty()) { fail(HttpError::BadRequest); return; }

  method_ = m == "GET" ? HttpMethod::Get : m == "HEAD" ? HttpMethod::Head : m == "POST" ? HttpMethod::Post : HttpMethod::Other;

  // Dạng tuyệt đối "http://host/path" (một số client/proxy gửi kiểu này): tách authority làm Host.
  if (target.compare(0, 7, "http://") == 0) {
    const size_t slash = target.find('/', 7);
    host_ = target.substr(7, slash == std::string::npos ? std::string::npos : slash - 7);
    target = slash == std::string::npos ? "/" : target.substr(slash);
  }
  if (target[0] != '/') {
    if (method_ != HttpMethod::Other) { fail(HttpError::BadRequest); return; }
    path_ = target;  // ví dụ CONNECT host:443 -> sẽ bị điều hướng/từ chối ở tầng route
  } else {
    const size_t q = target.find('?');
    path_ = target.substr(0, q);
    if (q != std::string::npos) query_ = target.substr(q + 1);
  }
  phase_ = Phase::Headers;
}

void HttpRequestParser::onHeaderLine() {
  if (line_.empty()) { onHeadersEnd(); return; }
  if (++headerCount_ > limits_.maxHeaders) { fail(HttpError::HeadersTooLarge); return; }
  if (line_[0] == ' ' || line_[0] == '\t') { fail(HttpError::BadRequest); return; }  // gộp dòng (obs-fold) bị cấm
  const size_t colon = line_.find(':');
  if (colon == std::string::npos || colon == 0) { fail(HttpError::BadRequest); return; }
  const std::string name = lower(line_.substr(0, colon));
  for (char c : name) if (!isTokenChar(static_cast<unsigned char>(c))) { fail(HttpError::BadRequest); return; }
  const std::string value = trim(line_.substr(colon + 1));

  if (name == "host") {
    if (host_.empty() && value.size() <= 100) host_ = value;
  } else if (name == "content-length") {
    if (value.empty()) { fail(HttpError::BadRequest); return; }
    for (char c : value) if (c < '0' || c > '9') { fail(HttpError::BadRequest); return; }
    if (value.size() > 9) { fail(HttpError::BodyTooLarge); return; }   // số khổng lồ: từ chối ngay, không tính
    size_t v = 0;
    for (char c : value) v = v * 10 + static_cast<size_t>(c - '0');
    if (haveContentLength_ && v != contentLength_) { fail(HttpError::BadRequest); return; }  // hai giá trị khác nhau: nghi buôn lậu request
    haveContentLength_ = true;
    contentLength_ = v;
    if (v > limits_.maxBody) { fail(HttpError::BodyTooLarge); return; }
  } else if (name == "transfer-encoding") {
    fail(HttpError::Unsupported);
  }
}

void HttpRequestParser::onHeadersEnd() {
  if (contentLength_ == 0) { state_ = State::Done; return; }
  phase_ = Phase::Body;
  body_.reserve(contentLength_);
}

}  // namespace auhono
