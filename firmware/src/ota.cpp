#include "ota.h"

#include <Arduino.h>
#include <HTTPClient.h>
#include <Update.h>
#include <WiFiClientSecure.h>
#include <esp_ota_ops.h>
#include <esp_partition.h>
#include <mbedtls/ecp.h>
#include <mbedtls/md.h>
#include <mbedtls/pk.h>

#include <string.h>

#include <string>
#include <vector>

#include "auhono/hex.h"
#include "auhono/maintenance.h"
#include "auhono/server_reply.h"
#include "config.h"
#include "tls_util.h"

// Khóa công khai ECDSA P-256 (PEM) nhúng lúc build từ keys/ota_public.pem. Khóa BÍ MẬT không bao giờ ở đây.
extern const uint8_t ota_public_pem_start[] asm("_binary_keys_ota_public_pem_start");

// Nhãn phiên bản nhúng trong ảnh (được ký cùng ảnh). `used`: không bị linker loại. auhono::FwTagScanner tìm nó khi tải.
extern const char kFwVersionTag[];
const char kFwVersionTag[] __attribute__((used)) = "AUHONO-FWVER:" AUHONO_FW_VERSION ";";

namespace {

/// Kiểm chữ ký ECDSA P-256/SHA-256 (DER) trên `digest` (SHA-256 của toàn bộ file .bin).
bool verifySignature(const uint8_t digest[32], const std::vector<uint8_t>& sigDer) {
  mbedtls_pk_context pk;
  mbedtls_pk_init(&pk);
  const char* pem = reinterpret_cast<const char*>(ota_public_pem_start);
  bool ok = false;
  // +1: mbedtls đòi độ dài PEM gồm cả '\0' cuối (embed_txtfiles đã thêm '\0').
  if (mbedtls_pk_parse_public_key(&pk, ota_public_pem_start, strlen(pem) + 1) == 0 && mbedtls_pk_can_do(&pk, MBEDTLS_PK_ECDSA) &&
      mbedtls_pk_get_bitlen(&pk) == 256 && mbedtls_pk_ec(pk)->grp.id == MBEDTLS_ECP_DP_SECP256R1) {  // đúng P-256, không phải đường cong 256 bit khác
    ok = mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, digest, 32, sigDer.data(), sigDer.size()) == 0;
  }
  mbedtls_pk_free(&pk);
  return ok;
}

/// Mã dung lượng flash (0=1MB,1=2MB,2=4MB...) trong ảnh ĐANG CHẠY: ảnh mới không được đòi flash lớn hơn.
uint8_t runningFlashSizeCode() {
  uint8_t code = 2;  // 4 MB (partitions.csv)
  const esp_partition_t* run = esp_ota_get_running_partition();
  uint8_t hdr[4];
  if (run && esp_partition_read(run, 0, hdr, sizeof hdr) == ESP_OK && hdr[0] == 0xE9) code = static_cast<uint8_t>(hdr[3] >> 4);
  return code;
}

bool tickOk(OtaContext& ctx) { return !ctx.tick || ctx.tick(ctx.user); }

/// Chờ tối thiểu `want` byte (hoặc tới khi hết dữ liệu/thời hạn), đọc vào `buf`. Trả số byte đã đọc.
size_t readAtLeast(WiFiClient* stream, uint8_t* buf, size_t want, uint32_t timeoutMs, OtaContext& ctx, auhono::IPlatform& platform) {
  size_t got = 0;
  const uint32_t deadline = millis() + timeoutMs;
  while (got < want && static_cast<int32_t>(millis() - deadline) < 0) {
    platform.feedWatchdog();
    if (!tickOk(ctx)) return got;
    const int avail = stream->available();
    if (avail > 0) {
      const size_t n = stream->readBytes(buf + got, want - got < static_cast<size_t>(avail) ? want - got : static_cast<size_t>(avail));
      if (n == 0) break;
      got += n;
    } else if (!stream->connected()) {
      break;
    } else {
      delay(5);
    }
  }
  return got;
}

/// Tải, ghi flash và kiểm chứng. true = ĐÃ CÀI (Update.end() thành công).
bool downloadAndInstall(const auhono::OtaManifest& m, auhono::IPlatform& platform, OtaContext& ctx, bool insecureRescue) {
  if (!auhono::tlsHeapOk(ESP.getFreeHeap(), ESP.getMaxAllocHeap())) {
    Serial.println("[ota] heap khong du, bo qua");
    return false;
  }

  WiFiClientSecure client;
  configureTls(client, insecureRescue);
  client.setHandshakeTimeout(cfg::kTlsHandshakeTimeoutS);

  HTTPClient http;
  if (!http.begin(client, m.url.c_str())) return false;
  http.useHTTP10(true);  // cần Content-Length, không chunked
  http.setReuse(false);
  http.setConnectTimeout(cfg::kHttpConnectTimeoutMs);
  http.setTimeout(cfg::kHttpTimeoutMs);
  // CDN (GitHub Releases, R2...) hay chuyển hướng 301/302: theo, tối đa 4 lần. HTTPClient chỉ theo chuyển hướng CÙNG giao thức
  // (https -> https; xem HTTPClient::setURL) và không gửi header của thiết bị (ta không đặt header ký ở request này).
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.setRedirectLimit(4);
  http.setUserAgent("Auhono/" AUHONO_FW_VERSION);
  http.addHeader("Accept-Encoding", "identity");

  const int status = http.GET();
  const int size = http.getSize();
  const esp_partition_t* target = esp_ota_get_next_update_partition(nullptr);
  if (status != 200 || size <= static_cast<int>(auhono::kImageHeaderCheckLen) || !target || static_cast<size_t>(size) > target->size) {
    // 404/403 (URL sai/hết hạn), thiếu Content-Length, ảnh quá nhỏ hoặc LỚN HƠN khe OTA: không tải.
    Serial.printf("[ota] tai that bai: http=%d size=%d\n", status, size);
    http.end();
    return false;
  }

  WiFiClient* stream = http.getStreamPtr();
  platform.feedWatchdog();

  // 1. Đọc và kiểm tra đầu ảnh TRƯỚC khi đụng vào flash.
  uint8_t head[64];
  const size_t headWant = static_cast<size_t>(size) < sizeof head ? static_cast<size_t>(size) : sizeof head;
  const size_t headGot = readAtLeast(stream, head, headWant, cfg::kOtaFirstBytesTimeoutMs, ctx, platform);
  if (headGot < headWant) { Serial.println("[ota] thieu du lieu dau anh"); http.end(); return false; }
  const auhono::ImageCheck ic = auhono::checkImageHeader(head, headGot, runningFlashSizeCode());
  if (ic != auhono::ImageCheck::Ok) {
    Serial.printf("[ota] anh khong hop le: %s\n", auhono::imageCheckText(ic));
    http.end();
    return false;
  }

  if (!Update.begin(static_cast<size_t>(size), U_FLASH)) {  // Arduino Update xóa từng sector khi ghi, bootloader không thấy ảnh cho tới Update.end()
    Serial.printf("[ota] Update.begin loi: %s\n", Update.errorString());
    http.end();
    return false;
  }

  mbedtls_md_context_t md;
  mbedtls_md_init(&md);
  mbedtls_md_setup(&md, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 0);
  mbedtls_md_starts(&md);
  auhono::FwTagScanner tag;
  size_t received = 0;
  bool ok = true;

  // Ghi + băm + dò nhãn đúng các byte đã đọc.
  auto consume = [&](uint8_t* p, size_t n) -> bool {
    if (Update.write(p, n) != n) {
      Serial.printf("[ota] ghi flash loi: %s\n", Update.errorString());
      return false;
    }
    mbedtls_md_update(&md, p, n);
    tag.feed(p, n);
    received += n;
    return true;
  };
  ok = consume(head, headGot);

  uint8_t buf[1024];
  const uint32_t deadline = millis() + cfg::kOtaDownloadTimeoutMs;
  while (ok && received < static_cast<size_t>(size)) {
    platform.feedWatchdog();
    if (static_cast<int32_t>(millis() - deadline) >= 0) { ok = false; Serial.println("[ota] het gio"); break; }
    if (!tickOk(ctx)) { ok = false; Serial.println("[ota] huy: uu tien gui/canh bao"); break; }
    const int avail = stream->available();
    if (avail <= 0) {
      if (!stream->connected()) { ok = false; Serial.println("[ota] mat ket noi"); break; }
      delay(5);
      continue;
    }
    size_t want = static_cast<size_t>(avail) < sizeof buf ? static_cast<size_t>(avail) : sizeof buf;
    if (want > static_cast<size_t>(size) - received) want = static_cast<size_t>(size) - received;  // không nhận thừa
    const size_t n = stream->readBytes(buf, want);
    if (n == 0) { ok = false; break; }
    ok = consume(buf, n);
  }
  http.end();  // đóng TLS sớm để trả heap trước khi kiểm chứng

  uint8_t digest[32];
  mbedtls_md_finish(&md, digest);
  mbedtls_md_free(&md);

  if (!ok || received != static_cast<size_t>(size)) {  // đứt giữa chừng / cụt / hết giờ / hủy
    Update.abort();
    return false;
  }

  // Ba lớp kiểm chứng, TRƯỚC khi Update.end() đặt phân vùng khởi động.
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
  // Nhãn phiên bản TRONG ảnh (đã được ký) phải khớp manifest và mới hơn bản đang chạy: chặn phát lại ảnh cũ đã ký.
  if (!tag.found() || tag.conflicting() || tag.version() != m.version ||
      auhono::compareVersions(AUHONO_FW_VERSION, tag.version()) != auhono::VersionOrder::Newer) {
    Serial.printf("[ota] nhan phien ban trong anh sai/thieu (%s): huy\n", tag.found() ? tag.version().c_str() : "khong co");
    Update.abort();
    return false;
  }
  platform.feedWatchdog();

  // Ghi sổ TRƯỚC khi kích hoạt: không ghi được sổ thì không cài (không chặn nổi vòng lặp OTA).
  if (!ctx.ledger || !ctx.ledger->beforeInstall(m.version)) {
    Serial.println("[ota] khong ghi duoc so cai: huy");
    Update.abort();
    return false;
  }

  // end(false): đòi đã nhận đủ `size` byte; Update kiểm magic byte rồi esp_ota_set_boot_partition() xác thực toàn bộ ảnh
  // (checksum + SHA-256 nối đuôi) và ghi otadata.
  if (!Update.end(false)) {
    Serial.printf("[ota] Update.end loi: %s\n", Update.errorString());
    return false;
  }
  return true;
}

}  // namespace

OtaOutcome otaCheckAndUpdate(auhono::DeviceClient& client, auhono::IPlatform& platform, OtaContext& ctx, bool insecureRescue) {
  const std::string path = std::string("/v1/ota/check?current=") + AUHONO_FW_VERSION;
  // Phản hồi OTA không có trường "ok": không đòi (requireOkField = false), tự kiểm bằng parseOtaManifest.
  const auhono::ServerReply reply = client.call("GET", path, nullptr, 0, false);
  if (reply.kind != auhono::ReplyKind::Ok) return OtaOutcome::CheckFailed;
  ctx.contacted = true;  // HTTP 200 có chữ ký hợp lệ: TLS + HMAC + seq + giờ đều đúng

  auhono::OtaManifest manifest;
  const std::string& body = client.lastResponse().body;
  switch (auhono::parseOtaManifest(body.data(), body.size(), manifest)) {
    case auhono::OtaParse::NoUpdate: return OtaOutcome::NoUpdate;
    case auhono::OtaParse::Invalid:  return OtaOutcome::CheckFailed;
    case auhono::OtaParse::Update:   break;
  }

  switch (auhono::compareVersions(AUHONO_FW_VERSION, manifest.version)) {
    case auhono::VersionOrder::Same:    return OtaOutcome::NoUpdate;
    case auhono::VersionOrder::Invalid: return OtaOutcome::CheckFailed;
    case auhono::VersionOrder::Older:
      // Server đề nghị bản CŨ HƠN: hạ cấp/phát lại. Không bao giờ chấp nhận (muốn "lùi" thì phát hành bản số cao hơn).
      Serial.printf("[ota] tu choi ha cap: %s -> %s\n", AUHONO_FW_VERSION, manifest.version.c_str());
      return OtaOutcome::Rejected;
    case auhono::VersionOrder::Newer:   break;
  }

  if (!ctx.ledger || !ctx.ledger->mayInstall(manifest.version)) {
    Serial.printf("[ota] bo qua %s: da cai %u lan ma khong duoc xac nhan\n", manifest.version.c_str(),
                  static_cast<unsigned>(auhono::kMaxInstallsPerVersion));
    return OtaOutcome::Blocked;
  }

  auhono::OtaGateInputs gate;
  gate.bufferCount = ctx.bufferCount;
  gate.breachActive = ctx.breachActive;
  gate.lastUploadOk = ctx.lastUploadOk;
  gate.uptimeS = ctx.uptimeS;
  gate.portalActive = ctx.portalActive;
  gate.freeHeap = ESP.getFreeHeap();
  gate.maxBlock = ESP.getMaxAllocHeap();
  const auhono::OtaDeferral defer = auhono::otaGate(gate);
  if (defer != auhono::OtaDeferral::None) {
    Serial.printf("[ota] co ban %s nhung hoan: %s\n", manifest.version.c_str(), auhono::otaDeferralText(defer));
    return OtaOutcome::Deferred;
  }

  Serial.printf("[ota] co ban moi %s, dang tai...\n", manifest.version.c_str());
  return downloadAndInstall(manifest, platform, ctx, insecureRescue) ? OtaOutcome::Installed : OtaOutcome::Rejected;
}
