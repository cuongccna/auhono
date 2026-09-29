// Wi-Fi đã lưu (SSID + mật khẩu) và bản ghi nhị phân có CRC để lưu NVS.
//
// Tại sao một bản ghi duy nhất có CRC (thay vì hai khóa "ssid"/"pass"): mất điện đúng lúc đang lưu có thể để lại
// SSID mới + mật khẩu cũ (hoặc ngược lại) -> thiết bị kết nối sai mãi. Một mục NVS được ghi nguyên tử; CRC
// + kiểm tra định dạng khi đọc bảo đảm ta không bao giờ dùng cấu hình nửa vời/hỏng: hỏng thì coi như "chưa cấu hình".
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

namespace auhono {

struct WifiCreds {
  std::string ssid;
  std::string password;
  bool present() const { return !ssid.empty(); }
};

/// Kích thước tối đa của bản ghi mã hóa: 4 (đầu) + 32 (SSID) + 63 (mật khẩu) + 4 (CRC).
constexpr size_t kWifiCredsMaxEncoded = 4 + 32 + 63 + 4;

/// Mã hóa. Trả độ dài, 0 nếu `creds` không hợp lệ (SSID rỗng/dài, mật khẩu sai chuẩn) hoặc `cap` nhỏ.
size_t encodeWifiCreds(const WifiCreds& creds, uint8_t* out, size_t cap);

/// Giải mã + kiểm tra magic, phiên bản, độ dài, CRC và lại kiểm SSID/mật khẩu bằng validateSsid/validatePassword.
bool decodeWifiCreds(const uint8_t* data, size_t len, WifiCreds& out);

}  // namespace auhono
