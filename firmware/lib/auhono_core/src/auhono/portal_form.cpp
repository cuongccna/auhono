#include "auhono/portal_form.h"

#include "auhono/hex.h"

namespace auhono {

std::string htmlEscape(const std::string& in) {
  std::string out;
  out.reserve(in.size() + in.size() / 4);
  for (char c : in) {
    switch (c) {
      case '&':  out += "&amp;"; break;
      case '<':  out += "&lt;"; break;
      case '>':  out += "&gt;"; break;
      case '"':  out += "&quot;"; break;
      case '\'': out += "&#39;"; break;
      default:
        // Bỏ ký tự điều khiển (kể cả xuống dòng) để không phá cấu trúc thuộc tính.
        if (static_cast<unsigned char>(c) >= 0x20 && c != 0x7f) out.push_back(c);
    }
  }
  return out;
}

FormError validateSsid(const std::string& ssid) {
  if (ssid.empty()) return FormError::SsidEmpty;
  if (ssid.size() > kMaxSsidLen) return FormError::SsidTooLong;
  for (char c : ssid) {
    const unsigned char u = static_cast<unsigned char>(c);
    if (u < 0x20 || u == 0x7f) return FormError::SsidBadChar;
  }
  return FormError::None;
}

FormError validatePassword(const std::string& pw) {
  if (pw.empty()) return FormError::None;  // mạng mở
  if (pw.size() < kMinPasswordLen) return FormError::PasswordTooShort;
  if (pw.size() > kMaxPasswordLen) return FormError::PasswordTooLong;
  for (char c : pw) {
    const unsigned char u = static_cast<unsigned char>(c);
    if (u < 0x20 || u > 0x7e) return FormError::PasswordBadChar;
  }
  return FormError::None;
}

const char* formErrorText(FormError e) {
  switch (e) {
    case FormError::None:             return "";
    case FormError::SsidEmpty:        return "Vui lòng chọn hoặc nhập tên Wi-Fi.";
    case FormError::SsidTooLong:      return "Tên Wi-Fi quá dài (tối đa 32 byte).";
    case FormError::SsidBadChar:      return "Tên Wi-Fi chứa ký tự không hợp lệ.";
    case FormError::PasswordTooShort: return "Mật khẩu Wi-Fi phải có ít nhất 8 ký tự (hoặc để trống nếu mạng không có mật khẩu).";
    case FormError::PasswordTooLong:  return "Mật khẩu Wi-Fi quá dài (tối đa 63 ký tự).";
    case FormError::PasswordBadChar:  return "Mật khẩu Wi-Fi chỉ được dùng ký tự ASCII (chữ, số, ký hiệu).";
  }
  return "";
}

std::string ssidToken(const std::string& ssid) {
  return toHex(reinterpret_cast<const uint8_t*>(ssid.data()), ssid.size());
}

bool ssidFromToken(const std::string& token, std::string& out) {
  if (token.empty() || token.size() > kMaxSsidLen * 2) return false;
  uint8_t buf[kMaxSsidLen];
  size_t n = 0;
  if (!fromHex(token.data(), token.size(), buf, sizeof buf, &n) || n == 0) return false;
  out.assign(reinterpret_cast<const char*>(buf), n);
  return true;
}

bool resolveSsid(const std::string& typed, const std::string& pickToken, std::string& out) {
  if (!typed.empty()) { out = typed; return true; }
  if (pickToken.empty()) return false;
  return ssidFromToken(pickToken, out);
}

std::string sanitizeUtf8(const std::string& in) {
  std::string out;
  out.reserve(in.size());
  const size_t n = in.size();
  size_t i = 0;
  while (i < n) {
    const unsigned char c = static_cast<unsigned char>(in[i]);
    size_t len = 0;
    uint32_t cp = 0;
    if (c < 0x80) { len = 1; cp = c; }
    else if (c >= 0xC2 && c <= 0xDF) { len = 2; cp = c & 0x1Fu; }
    else if (c >= 0xE0 && c <= 0xEF) { len = 3; cp = c & 0x0Fu; }
    else if (c >= 0xF0 && c <= 0xF4) { len = 4; cp = c & 0x07u; }
    bool ok = len != 0 && i + len <= n;
    for (size_t k = 1; ok && k < len; k++) {
      const unsigned char cc = static_cast<unsigned char>(in[i + k]);
      if ((cc & 0xC0) != 0x80) ok = false;
      else cp = (cp << 6) | (cc & 0x3Fu);
    }
    if (ok) {  // loại mã hóa quá dài, surrogate, và > U+10FFFF
      if (len == 3 && (cp < 0x800 || (cp >= 0xD800 && cp <= 0xDFFF))) ok = false;
      if (len == 4 && (cp < 0x10000 || cp > 0x10FFFF)) ok = false;
    }
    if (ok) { out.append(in, i, len); i += len; }
    else { out.push_back('?'); ++i; }
  }
  return out;
}

std::string apSsid(const std::string& deviceId) {
  std::string tail = "0000";
  if (deviceId.size() >= 4) tail = deviceId.substr(deviceId.size() - 4);
  return "Auhono-" + tail;
}

bool isValidDeviceId(const std::string& id) {
  if (id.size() < 3 || id.size() > 32) return false;
  for (char c : id) {
    const bool ok = (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-';
    if (!ok) return false;
  }
  return true;
}

}  // namespace auhono
