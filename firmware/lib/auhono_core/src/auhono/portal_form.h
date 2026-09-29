// Kiểm tra dữ liệu form cấu hình Wi-Fi (captive portal) và escape HTML.
// Mọi chuỗi từ bên ngoài (SSID quét được, giá trị nhập) đều phải qua htmlEscape trước khi
// đưa vào trang; không có JavaScript nên không có đường XSS nào khác.
#pragma once
#include <cstddef>
#include <string>

namespace auhono {

constexpr size_t kMaxSsidLen = 32;      // byte (chuẩn 802.11)
constexpr size_t kMinPasswordLen = 8;   // WPA2-PSK
constexpr size_t kMaxPasswordLen = 63;

/// Escape & < > " ' để dùng an toàn cả trong nội dung lẫn giá trị thuộc tính. Bỏ ký tự điều khiển.
std::string htmlEscape(const std::string& in);

enum class FormError : unsigned char {
  None,
  SsidEmpty,
  SsidTooLong,
  SsidBadChar,
  PasswordTooShort,
  PasswordTooLong,
  PasswordBadChar,
};

/// SSID: 1..32 byte, cho phép UTF-8 (tên tiếng Việt có dấu), cấm ký tự điều khiển.
FormError validateSsid(const std::string& ssid);

/// Mật khẩu: rỗng (mạng mở) hoặc 8..63 ký tự ASCII in được (chuẩn WPA2-PSK).
FormError validatePassword(const std::string& password);

/// Thông báo tiếng Việt cho người dùng ("" nếu None).
const char* formErrorText(FormError e);

/// Ô nhập tay ưu tiên hơn danh sách chọn (mạng ẩn không có trong danh sách quét).
std::string pickSsid(const std::string& typed, const std::string& picked);

/// Tên Wi-Fi cấu hình: "Auhono-" + 4 ký tự cuối của mã thiết bị ("AUH-000001" -> "Auhono-0001").
/// Mã rỗng/quá ngắn -> "Auhono-0000".
std::string apSsid(const std::string& deviceId);

/// Khớp regex của server: ^[A-Z0-9-]{3,32}$
bool isValidDeviceId(const std::string& id);

}  // namespace auhono
