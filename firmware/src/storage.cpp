#include "storage.h"

#include <Preferences.h>
#include <nvs.h>
#include <nvs_flash.h>

#include "auhono/portal_form.h"

namespace {
const char* kIdentPartition = "ident";  // khớp partitions.csv
}

Identity loadIdentity() {
  Identity id;
  // Phân vùng "ident" là một phân vùng NVS riêng, tạo bằng tools/flash_identity.py.
  if (nvs_flash_init_partition(kIdentPartition) != ESP_OK) return id;

  nvs_handle_t h;
  if (nvs_open_from_partition(kIdentPartition, "id", NVS_READONLY, &h) != ESP_OK) return id;

  char idBuf[40] = {0};
  size_t idLen = sizeof idBuf;
  size_t keyLen = sizeof id.key;
  const bool ok = nvs_get_str(h, "device_id", idBuf, &idLen) == ESP_OK &&
                  nvs_get_blob(h, "device_key", id.key, &keyLen) == ESP_OK && keyLen == sizeof id.key;
  nvs_close(h);
  if (!ok || !auhono::isValidDeviceId(idBuf)) return id;

  // Khóa toàn số 0 là dấu hiệu flash trống/lỗi: không coi là hợp lệ.
  uint8_t any = 0;
  for (uint8_t b : id.key) any |= b;
  if (any == 0) return id;

  id.deviceId = idBuf;
  id.valid = true;
  return id;
}

void storageBegin() {
  // Phân vùng NVS mặc định ("nvs"). Nếu hỏng/đầy phiên bản thì xóa và tạo lại (mất Wi-Fi đã lưu,
  // không mất danh tính vì nằm ở phân vùng "ident").
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    nvs_flash_erase();
    nvs_flash_init();
  }
}

WifiCreds loadWifiCreds() {
  WifiCreds c;
  Preferences p;
  if (!p.begin("wifi", true)) return c;
  c.ssid = p.getString("ssid", "").c_str();
  c.password = p.getString("pass", "").c_str();
  p.end();
  return c;
}

bool saveWifiCreds(const WifiCreds& creds) {
  Preferences p;
  if (!p.begin("wifi", false)) return false;
  const bool ok = p.putString("ssid", creds.ssid.c_str()) > 0 && (p.putString("pass", creds.password.c_str()) > 0 || creds.password.empty());
  p.end();
  return ok;
}

void clearWifiCreds() {
  Preferences p;
  if (p.begin("wifi", false)) {
    p.clear();
    p.end();
  }
}

auhono::Thresholds loadThresholds() {
  auhono::Thresholds t;  // mặc định -40/-18
  Preferences p;
  if (!p.begin("cfg", true)) return t;
  const int32_t mn = p.getShort("min", t.minCenti);
  const int32_t mx = p.getShort("max", t.maxCenti);
  p.end();
  if (auhono::Thresholds::isSane(mn, mx)) {
    t.minCenti = static_cast<int16_t>(mn);
    t.maxCenti = static_cast<int16_t>(mx);
  }
  return t;
}

void saveThresholds(const auhono::Thresholds& t) {
  Preferences p;
  if (!p.begin("cfg", false)) return;
  p.putShort("min", t.minCenti);
  p.putShort("max", t.maxCenti);
  p.end();
}
