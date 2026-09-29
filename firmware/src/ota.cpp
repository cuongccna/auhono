#include "ota.h"

#include <Arduino.h>
#include <HTTPClient.h>
#include <Update.h>
#include <WiFiClientSecure.h>
#include <esp_ota_ops.h>
#include <mbedtls/md.h>
#include <mbedtls/pk.h>

#include <string>

#include "auhono/hex.h"
#include "auhono/server_reply.h"
#include "config.h"
#include "tls_util.h"

// Khóa công khai ECDSA P-256 (PEM) nhúng lúc build từ keys/ota_public.pem. Khóa BÍ MẬT không bao giờ ở đây.
extern const uint8_t ota_public_pem_start[] asm("_binary_keys_ota_public_pem_start");

namespace {

/// Kiểm chữ ký ECDSA P-256/SHA-256 (DER) trên `digest` (SHA-256 của toàn bộ file .bin).
bool verifySignature(const uint8_t digest[32], const std::vector<uint8_t>& sigDer) {
  mbedtls_pk_context pk;
  mbedtls_pk_init(&pk);
  const char* pem = reinterpret_cast<const char*>(ota_public_pem_start);
  bool ok = false;
  // +1: mbedtls đòi độ dài PEM gồm cả '\0' cuối (embed_txtfiles đã thêm '\0').
  if (mbedtls_pk_parse_public_key(&pk, ota_public_pem_start, strlen(pem) + 1) == 0 &&
      mbedtls_pk_can_do(&pk, MBEDTLS_PK_ECDSA) && mbedtls_pk_get_bitlen(&pk) == 256) {
    ok = mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, digest, 32, sigDer.data(), sigDer.size()) == 0;
  }
  mbedtls_pk_free(&pk);
  return ok;
}

/// Tải, ghi flash và kiểm chứng. true = ĐÃ CÀI (Update.end() thành công).
bool downloadAndInstall(const auhono::OtaManifest& m, auhono::IPlatform& platform) {
  WiFiClientSecure client;
  configureTls(client);
  client.setHandshakeTimeout(15);

  HTTPClient http;
  if (!http.begin(client, m.url.c_str())) return false;
  http.useHTTP10(true);  // cần Content-Length, không chunked
  http.setReuse(false);
  http.setConnectTimeout(cfg::kHttpConnectTimeoutMs);
  http.setTimeout(cfg::kHttpTimeoutMs);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);  // CDN hay chuyển hướng; vẫn chỉ HTTPS
  http.setUserAgent("Auhono/" AUHONO_FW_VERSION);

  const int status = http.GET();
  const int size = http.getSize();
  const esp_partition_t* target = esp_ota_get_next_update_partition(nullptr);
  if (status != 200 || size <= 0 || !target || static_cast<size_t>(size) > target->size) {
    Serial.printf("[ota] tai that bai: http=%d size=%d\n", status, size);
    http.end();
    return false;
  }

  if (!Update.begin(static_cast<size_t>(size), U_FLASH)) {  // xóa phân vùng đích: mất vài giây
    Serial.printf("[ota] Update.begin loi: %s\n", Update.errorString());
    http.end();
    return false;
  }
  platform.feedWatchdog();

  mbedtls_md_context_t md;
  mbedtls_md_init(&md);
  mbedtls_md_setup(&md, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 0);
  mbedtls_md_starts(&md);

  WiFiClient* stream = http.getStreamPtr();
  uint8_t buf[1024];
  size_t received = 0;
  const uint32_t deadline = millis() + cfg::kOtaDownloadTimeoutMs;
  bool ok = true;

  while (received < static_cast<size_t>(size)) {
    platform.feedWatchdog();
    if (static_cast<int32_t>(millis() - deadline) >= 0) { ok = false; Serial.println("[ota] het gio"); break; }
    const int avail = stream->available();
    if (avail <= 0) {
      if (!stream->connected()) { ok = false; Serial.println("[ota] mat ket noi"); break; }
      delay(5);
      continue;
    }
    size_t want = static_cast<size_t>(avail) < sizeof buf ? static_cast<size_t>(avail) : sizeof buf;
    if (want > static_cast<size_t>(size) - received) want = static_cast<size_t>(size) - received;  // không nhận thừa
    const int n = stream->readBytes(buf, want);
    if (n <= 0) { ok = false; break; }
    if (Update.write(buf, static_cast<size_t>(n)) != static_cast<size_t>(n)) {
      ok = false;
      Serial.printf("[ota] ghi flash loi: %s\n", Update.errorString());
      break;
    }
    mbedtls_md_update(&md, buf, static_cast<size_t>(n));  // băm đúng các byte vừa ghi
    received += static_cast<size_t>(n);
  }
  http.end();

  uint8_t digest[32];
  mbedtls_md_finish(&md, digest);
  mbedtls_md_free(&md);

  if (!ok || received != static_cast<size_t>(size)) {
    Update.abort();
    return false;
  }

  // Hai lớp kiểm chứng, TRƯỚC khi Update.end() đặt phân vùng khởi động.
  if (!auhono::constTimeEqual(digest, m.sha256, 32)) {
    Serial.println("[ota] SAI sha256: huy");
    Update.abort();
    return false;
  }
  if (!verifySignature(digest, m.signature)) {
    Serial.println("[ota] SAI chu ky: huy");
    Update.abort();
    return false;
  }
  platform.feedWatchdog();

  // end(false): đòi đã nhận đủ `size` byte; Update kiểm thêm magic byte của ảnh và ghi otadata.
  if (!Update.end(false)) {
    Serial.printf("[ota] Update.end loi: %s\n", Update.errorString());
    return false;
  }
  return true;
}

}  // namespace

OtaOutcome otaCheckAndUpdate(auhono::DeviceClient& client, auhono::IPlatform& platform) {
  if (ESP.getFreeHeap() < cfg::kOtaMinFreeHeap) return OtaOutcome::CheckFailed;

  const std::string path = std::string("/v1/ota/check?current=") + AUHONO_FW_VERSION;
  // Phản hồi OTA không có trường "ok": không đòi (requireOkField = false), tự kiểm bằng parseOtaManifest.
  const auhono::ServerReply reply = client.call("GET", path, nullptr, 0, false);
  if (reply.kind != auhono::ReplyKind::Ok) return OtaOutcome::CheckFailed;

  auhono::OtaManifest manifest;
  const std::string& body = client.lastResponse().body;
  switch (auhono::parseOtaManifest(body.data(), body.size(), manifest)) {
    case auhono::OtaParse::NoUpdate: return OtaOutcome::NoUpdate;
    case auhono::OtaParse::Invalid:  return OtaOutcome::CheckFailed;
    case auhono::OtaParse::Update:   break;
  }
  if (manifest.version == AUHONO_FW_VERSION) return OtaOutcome::NoUpdate;

  Serial.printf("[ota] co ban moi %s, dang tai...\n", manifest.version.c_str());
  return downloadAndInstall(manifest, platform) ? OtaOutcome::Installed : OtaOutcome::Rejected;
}
