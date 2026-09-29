// Lưu trữ bền vững (NVS). Ba nơi tách biệt để mỗi loại dữ liệu có vòng đời riêng:
//   - phân vùng NVS "ident" (chỉ đọc lúc chạy): mã thiết bị + khóa 32 byte, nạp lúc ráp.
//     KHÔNG bị xóa khi "reset Wi-Fi" hay OTA. Xem tools/flash_identity.py.
//   - phân vùng NVS mặc định "nvs":
//       namespace "wifi": MỘT bản ghi nhị phân có CRC (SSID + mật khẩu) — không bao giờ ghi nửa vời;
//       namespace "cfg" : ngưỡng lấy từ server (cache);
//       namespace "auh" : trần seq (NvsSeqStore, platform_esp32.cpp);
//       namespace "ota" : sổ cài OTA (chống vòng lặp, rollback mềm);
//       namespace "sys" : lý do khởi động lại chủ động lần trước.
#pragma once
#include <stdint.h>

#include <string>

#include "auhono/maintenance.h"
#include "auhono/ota_policy.h"
#include "auhono/upload_policy.h"
#include "auhono/wifi_creds.h"

using auhono::WifiCreds;

struct Identity {
  bool valid = false;
  std::string deviceId;
  uint8_t key[32] = {0};
};

/// Đọc mã + khóa từ phân vùng "ident". valid=false nếu chưa nạp / sai định dạng / khóa toàn 0 hoặc toàn 0xFF.
Identity loadIdentity();

/// Khởi tạo phân vùng NVS mặc định. Gọi một lần ở setup().
void storageBegin();

/// Đọc Wi-Fi đã lưu; bản ghi hỏng/nửa vời/không có -> WifiCreds rỗng (coi như chưa cấu hình).
WifiCreds loadWifiCreds();
/// Ghi MỘT bản ghi nguyên tử rồi đọc lại đối chiếu. false nếu không ghi/đối chiếu được.
bool saveWifiCreds(const WifiCreds& creds);
/// Xóa Wi-Fi đã lưu (KHÔNG đụng danh tính).
void clearWifiCreds();

auhono::Thresholds loadThresholds();  // mặc định -40/-18 nếu chưa có / hỏng
void saveThresholds(const auhono::Thresholds& t);

/// Sổ cài OTA (auhono::IOtaStore) lưu trong NVS.
class NvsOtaStore : public auhono::IOtaStore {
 public:
  bool load(auhono::OtaRecord& r) override;
  bool save(const auhono::OtaRecord& r) override;
};

/// Lý do khởi động lại chủ động: ghi TRƯỚC khi restart, đọc (và xóa) ở lần khởi động sau để log.
void saveRebootReason(auhono::RebootReason r);
auhono::RebootReason takeRebootReason();
