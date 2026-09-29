// Mật khẩu WPA2 của Wi-Fi cấu hình (AP) do CHÍNH thiết bị suy ra từ khóa thiết bị (docs/PROTOCOL.md, mục "Wi-Fi cấu hình
// của thiết bị (AP) có mật khẩu WPA2"). Máy chủ/provision.ts suy ra cùng giá trị để in lên tem/QR, nên không cần nạp thêm gì.
//
//   ap_ssid     = "Auhono-" + 4 ký tự cuối của device_id
//   ap_password = 10 ký tự: ALPHABET[byte % 32] của 10 byte đầu HMAC-SHA256(device_key, "ap-password:v1")
//                 (ALPHABET = 0123456789ABCDEFGHJKMNPQRSTVWXYZ, không có I L O U)
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

#include "auhono/crypto_iface.h"
#include "auhono/signer.h"

namespace auhono {

constexpr size_t kApPasswordLen = 10;                      // nằm trong 8..63 của WPA2-PSK
constexpr char kApPasswordAlphabet[] = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
constexpr char kApPasswordContext[] = "ap-password:v1";

/// Suy ra mật khẩu AP từ khóa thiết bị (32 byte). Luôn trả đúng kApPasswordLen ký tự thuộc bảng chữ cái trên.
std::string deriveApPassword(ICrypto& crypto, const uint8_t key[kDeviceKeyLen]);

}  // namespace auhono
