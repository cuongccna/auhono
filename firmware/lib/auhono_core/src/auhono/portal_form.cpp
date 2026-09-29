#include "auhono/portal_form.h"

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

std::string pickSsid(const std::string& typed, const std::string& picked) {
  return typed.empty() ? picked : typed;
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
