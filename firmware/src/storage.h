// Lưu trữ bền vững (NVS). Ba nơi tách biệt để mỗi loại dữ liệu có vòng đời riêng:
//   - phân vùng NVS "ident" (chỉ đọc lúc chạy): mã thiết bị + khóa 32 byte, nạp lúc ráp.
//     KHÔNG bị xóa khi "reset Wi-Fi" hay OTA. Xem tools/flash_identity.py.
//   - phân vùng NVS mặc định, namespace "wifi": SSID + mật khẩu Wi-Fi.
//   - namespace "cfg": ngưỡng lấy từ server (cache); namespace "auh": trần seq (NvsSeqStore).
#pragma once
#include <stdint.h>

#include <string>

#include "auhono/upload_policy.h"

struct Identity {
  bool valid = false;
  std::string deviceId;
  uint8_t key[32] = {0};
};

/// Đọc mã + khóa từ phân vùng "ident". valid=false nếu chưa nạp / sai định dạng.
Identity loadIdentity();

struct WifiCreds {
  std::string ssid;
  std::string password;
  bool present() const { return !ssid.empty(); }
};

/// Khởi tạo phân vùng NVS mặc định. Gọi một lần ở setup().
void storageBegin();

WifiCreds loadWifiCreds();
bool saveWifiCreds(const WifiCreds& creds);
void clearWifiCreds();

auhono::Thresholds loadThresholds();  // mặc định -40/-18 nếu chưa có
void saveThresholds(const auhono::Thresholds& t);
