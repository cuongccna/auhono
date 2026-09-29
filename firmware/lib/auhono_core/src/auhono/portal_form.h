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

/// Mã hóa SSID (byte thô) thành chuỗi hex để đặt vào <option value>: đúng từng byte kể cả SSID không phải UTF-8
/// (Windows-1258, GBK...) mà trình duyệt không gửi lại nguyên vẹn nếu để dạng chữ, và không thể chứa ký tự nguy hiểm.
std::string ssidToken(const std::string& ssid);
/// Giải mã ngược, CHẶT: hex hợp lệ, độ dài chẵn, 1..32 byte. false nếu sai.
bool ssidFromToken(const std::string& token, std::string& out);

/// Chọn SSID: ô nhập tay (mạng ẩn / gõ tay) ưu tiên hơn danh sách chọn. `pickToken` là ssidToken() của mạng đã chọn
/// (chuỗi rỗng = chưa chọn). false nếu cả hai đều trống hoặc token hỏng.
bool resolveSsid(const std::string& typed, const std::string& pickToken, std::string& out);

/// Bản dùng để HIỂN THỊ: byte không phải UTF-8 hợp lệ (quá dài/mồ côi/surrogate/>U+10FFFF) thay bằng '?'.
/// Không dùng để kết nối (khi kết nối luôn dùng byte gốc).
std::string sanitizeUtf8(const std::string& in);

/// Tên Wi-Fi cấu hình: "Auhono-" + 4 ký tự cuối của mã thiết bị ("AUH-000001" -> "Auhono-0001").
/// Mã rỗng/quá ngắn -> "Auhono-0000".
std::string apSsid(const std::string& deviceId);

/// Khớp regex của server: ^[A-Z0-9-]{3,32}$
bool isValidDeviceId(const std::string& id);

}  // namespace auhono
