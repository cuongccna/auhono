#include "storage.h"

#include <Preferences.h>
#include <nvs.h>
#include <nvs_flash.h>

#include <string.h>

#include "auhono/portal_form.h"

namespace {
const char* kIdentPartition = "ident";  // khớp partitions.csv
}

Identity loadIdentity() {
  Identity id;
  // Phân vùng "ident" là một phân vùng NVS riêng, tạo bằng tools/flash_identity.py. Nếu nó trống/hỏng ta chỉ báo
  // "chưa có danh tính" — KHÔNG BAO GIỜ xóa nó (khác với phân vùng "nvs" mặc định).
  if (nvs_flash_init_partition(kIdentPartition) != ESP_OK) return id;

  nvs_handle_t h;
  if (nvs_open_from_partition(kIdentPartition, "id", NVS_READONLY, &h) != ESP_OK) return id;

  char idBuf[40] = {0};
  size_t idLen = sizeof idBuf;
  size_t keyLen = sizeof id.key;
  const bool ok = nvs_get_str(h, "device_id", idBuf, &idLen) == ESP_OK &&
                  nvs_get_blob(h, "device_key", id.key, &keyLen) == ESP_OK && keyLen == sizeof id.key;
  nvs_close(h);
  if (!ok || !auhono::isValidDeviceId(idBuf)) { memset(id.key, 0, sizeof id.key); return id; }

  // Khóa toàn 0 hoặc toàn 0xFF là dấu hiệu flash trống/lỗi: không coi là hợp lệ.
  uint8_t any = 0, all = 0xFF;
  for (uint8_t b : id.key) { any |= b; all &= b; }
  if (any == 0 || all == 0xFF) { memset(id.key, 0, sizeof id.key); return id; }

  id.deviceId = idBuf;
  id.valid = true;
  return id;
}

void storageBegin() {
  // Phân vùng NVS mặc định ("nvs"). Nếu hỏng/đầy phiên bản thì xóa và tạo lại (mất Wi-Fi đã lưu và trần seq — server sẽ trả
  // 409 kèm last_seq để ta tự nhảy lên —, không mất danh tính vì nằm ở phân vùng "ident").
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    nvs_flash_erase();
    nvs_flash_init();
  }
}

// ── Wi-Fi ──────────────────────────────────────────────────────────────────

WifiCreds loadWifiCreds() {
  WifiCreds c;
  Preferences p;
  if (!p.begin("wifi", true)) return c;
  uint8_t buf[auhono::kWifiCredsMaxEncoded + 8];
  const size_t n = p.getBytesLength("cred");
  if (n > 0 && n <= sizeof buf && p.getBytes("cred", buf, sizeof buf) == n) {
    if (!auhono::decodeWifiCreds(buf, n, c)) c = WifiCreds();  // hỏng: coi như chưa có
  }
  p.end();
  memset(buf, 0, sizeof buf);
  return c;
}

bool saveWifiCreds(const WifiCreds& creds) {
  uint8_t buf[auhono::kWifiCredsMaxEncoded];
  const size_t n = auhono::encodeWifiCreds(creds, buf, sizeof buf);
  if (n == 0) return false;

  bool ok = false;
  Preferences p;
  if (p.begin("wifi", false)) {
    // nvs_set_blob + nvs_commit là nguyên tử ở mức mục: mất điện giữa chừng để lại bản CŨ nguyên vẹn hoặc bản MỚI nguyên vẹn.
    ok = p.putBytes("cred", buf, n) == n;
    p.end();
  }
  memset(buf, 0, sizeof buf);
  if (!ok) return false;
  // Đọc lại đối chiếu (bắt lỗi ghi flash âm thầm).
  const WifiCreds back = loadWifiCreds();
  return back.ssid == creds.ssid && back.password == creds.password;
}

void clearWifiCreds() {
  Preferences p;
  if (p.begin("wifi", false)) {
    p.clear();  // cả khóa cũ nếu có
    p.end();
  }
}

// ── Ngưỡng ─────────────────────────────────────────────────────────────────

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
  p.putShort("min", t.minCenti);  // NVS bỏ qua ghi nếu giá trị không đổi
  p.putShort("max", t.maxCenti);
  p.end();
}

// ── Sổ cài OTA ─────────────────────────────────────────────────────────────

bool NvsOtaStore::load(auhono::OtaRecord& r) {
  Preferences p;
  if (!p.begin("ota", true)) return false;
  uint8_t buf[auhono::kOtaRecordEncodedLen + 8];
  const size_t n = p.getBytesLength("rec");
  const bool ok = n == auhono::kOtaRecordEncodedLen && p.getBytes("rec", buf, sizeof buf) == n &&
                  auhono::decodeOtaRecord(buf, n, r);
  p.end();
  return ok;
}

bool NvsOtaStore::save(const auhono::OtaRecord& r) {
  uint8_t buf[auhono::kOtaRecordEncodedLen];
  const size_t n = auhono::encodeOtaRecord(r, buf, sizeof buf);
  if (n == 0) return false;
  Preferences p;
  if (!p.begin("ota", false)) return false;
  const bool ok = p.putBytes("rec", buf, n) == n;
  p.end();
  return ok;
}

// ── Lý do khởi động lại ────────────────────────────────────────────────────

void saveRebootReason(auhono::RebootReason r) {
  Preferences p;
  if (!p.begin("sys", false)) return;
  p.putUChar("why", static_cast<uint8_t>(r));
  p.end();
}

auhono::RebootReason takeRebootReason() {
  Preferences p;
  if (!p.begin("sys", false)) return auhono::RebootReason::None;
  const uint8_t v = p.getUChar("why", 0);
  if (v != 0) p.putUChar("why", 0);  // xóa: chỉ ghi khi thật sự có (mỗi lần khởi động chủ động một lần)
  p.end();
  return v <= static_cast<uint8_t>(auhono::RebootReason::PortalFault) ? static_cast<auhono::RebootReason>(v) : auhono::RebootReason::None;
}
