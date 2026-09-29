#include "platform_esp32.h"

#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFiClientSecure.h>
#if __has_include(<esp_random.h>)
#include <esp_random.h>
#endif
#include <esp_system.h>
#include <esp_sntp.h>
#include <esp_task_wdt.h>
#include <mbedtls/md.h>
#include <sys/time.h>
#include <time.h>

#include "auhono/time_policy.h"
#include "config.h"
#include "tls_util.h"

// ── Mật mã ─────────────────────────────────────────────────────────────────

void MbedCrypto::sha256(const uint8_t* data, size_t len, uint8_t out[32]) {
  mbedtls_md(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), data, len, out);
}

void MbedCrypto::hmacSha256(const uint8_t* key, size_t keyLen, const uint8_t* msg, size_t msgLen, uint8_t out[32]) {
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), key, keyLen, msg, msgLen, out);
}

uint32_t EspRandom::next() { return esp_random(); }

// ── Đồng hồ & watchdog ─────────────────────────────────────────────────────

static EspPlatform* g_platform = nullptr;

static void ntpCallback(struct timeval*) {
  if (g_platform) g_platform->onNtpSynced();
}

void EspPlatform::begin() {
  g_platform = this;
  sntp_set_time_sync_notification_cb(ntpCallback);

  // Task watchdog: loop() phải gọi feedWatchdog() ít nhất mỗi kWdtTimeoutS giây, nếu không chip tự reset.
  // Core Arduino đã khởi tạo TWDT với timeout 5 s nên phải deinit rồi init lại với timeout dài hơn
  // (một lần kết nối TLS có thể chiếm vài giây).
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t wdt = {};
  wdt.timeout_ms = cfg::kWdtTimeoutS * 1000;
  wdt.trigger_panic = true;
  if (esp_task_wdt_reconfigure(&wdt) != ESP_OK) esp_task_wdt_init(&wdt);
#else
  esp_task_wdt_deinit();
  if (esp_task_wdt_init(cfg::kWdtTimeoutS, true) != ESP_OK) Serial.println("[wdt] init loi");
#endif
  esp_task_wdt_add(nullptr);  // đăng ký task hiện tại (loopTask)
}

void EspPlatform::startNtp() {
  if (ntpStarted_) return;
  ntpStarted_ = true;
  configTime(0, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com");
}

void EspPlatform::onNtpSynced() {
  // Chỉ tin khi giờ thật sự hợp lý (phòng server NTP trả rác).
  if (auhono::isPlausibleUnix(static_cast<uint64_t>(time(nullptr)))) trusted_ = true;
}

uint32_t EspPlatform::unixNow() {
  const time_t t = time(nullptr);
  return t > 0 ? static_cast<uint32_t>(t) : 0;
}

void EspPlatform::setUnix(uint32_t t) {
  struct timeval tv = {static_cast<time_t>(t), 0};
  settimeofday(&tv, nullptr);
  trusted_ = true;
}

void EspPlatform::feedWatchdog() { esp_task_wdt_reset(); }

// ── seq trong NVS ──────────────────────────────────────────────────────────

bool NvsSeqStore::load(uint64_t& value) {
  Preferences p;
  if (!p.begin("auh", true)) return false;
  const bool has = p.isKey("seq");
  if (has) value = p.getULong64("seq", 0);
  p.end();
  return has;
}

bool NvsSeqStore::save(uint64_t value) {
  Preferences p;
  if (!p.begin("auh", false)) return false;
  const bool ok = p.putULong64("seq", value) == sizeof(uint64_t);
  p.end();
  return ok;
}

// ── HTTPS ──────────────────────────────────────────────────────────────────

extern const uint8_t roots_pem_start[] asm("_binary_certs_roots_pem_start");

const char* embeddedRootCAs() { return reinterpret_cast<const char*>(roots_pem_start); }

/// Đọc body có giới hạn kích thước và thời gian (không dùng getString() để không phình heap).
static std::string readBody(HTTPClient& http, int size) {
  std::string body;
  WiFiClient* stream = http.getStreamPtr();
  if (!stream) return body;
  const uint32_t deadline = ::millis() + cfg::kHttpTimeoutMs;
  uint8_t buf[256];
  while (body.size() < cfg::kMaxResponseBytes && static_cast<int32_t>(::millis() - deadline) < 0) {
    if (size >= 0 && body.size() >= static_cast<size_t>(size)) break;
    const int avail = stream->available();
    if (avail > 0) {
      const int n = stream->readBytes(buf, avail < static_cast<int>(sizeof buf) ? avail : sizeof buf);
      if (n <= 0) break;
      body.append(reinterpret_cast<const char*>(buf), static_cast<size_t>(n));
    } else if (!stream->connected()) {
      break;
    } else {
      delay(5);
    }
  }
  return body;
}

auhono::HttpResponse HttpsTransport::perform(const auhono::HttpRequest& req) {
  auhono::HttpResponse out;

  WiFiClientSecure client;
  configureTls(client);  // xác thực chứng chỉ (hoặc setInsecure khi -DALLOW_INSECURE_TLS)
  client.setHandshakeTimeout(15);

  HTTPClient http;
  const String url = String(AUHONO_SERVER_URL) + req.pathAndQuery.c_str();
  if (!http.begin(client, url)) return out;  // status 0 => lỗi mạng
  http.setReuse(false);
  http.useHTTP10(true);  // tránh "Transfer-Encoding: chunked": phản hồi luôn có độ dài xác định
  http.setConnectTimeout(cfg::kHttpConnectTimeoutMs);
  http.setTimeout(cfg::kHttpTimeoutMs);
  http.setUserAgent("Auhono/" AUHONO_FW_VERSION);

  if (req.hasSignature) {
    http.addHeader("X-Device-Id", req.headers.deviceId.c_str());
    http.addHeader("X-Timestamp", req.headers.timestamp.c_str());
    http.addHeader("X-Seq", req.headers.seq.c_str());
    http.addHeader("X-Signature", req.headers.signature.c_str());
  }
  if (req.bodyLen > 0) http.addHeader("Content-Type", "application/json");

  int status;
  if (req.method == "POST") {
    // Gửi ĐÚNG vùng byte đã ký (không qua String/định dạng lại).
    status = http.POST(const_cast<uint8_t*>(req.body), req.bodyLen);
  } else {
    status = http.GET();
  }

  out.status = status;
  if (status > 0) {
    const int size = http.getSize();  // -1 nếu server đóng kết nối để báo hết body (HTTP/1.0)
    if (size < 0 || static_cast<size_t>(size) <= cfg::kMaxResponseBytes) out.body = readBody(http, size);
    // Phản hồi quá lớn so với dự kiến: bỏ body, chỉ dùng mã trạng thái.
  }
  http.end();
  return out;
}
