#include "platform_esp32.h"

#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFiClientSecure.h>
#include <esp_random.h>
#include <esp_sntp.h>
#include <esp_system.h>
#include <esp_task_wdt.h>
#include <esp_timer.h>
#include <mbedtls/md.h>
#include <mbedtls/x509.h>
#include <sys/time.h>
#include <time.h>

#include "auhono/maintenance.h"
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

static EspPlatform* g_platformInstance = nullptr;

static void ntpCallback(struct timeval*) {
  if (g_platformInstance) g_platformInstance->onNtpSynced();
}

void EspPlatform::begin() {
  g_platformInstance = this;
  sntp_set_time_sync_notification_cb(ntpCallback);

  // Task watchdog: loop() phải gọi feedWatchdog() ít nhất mỗi kWdtTimeoutS giây, nếu không chip tự reset.
  // Core Arduino đã khởi tạo TWDT (IDF 4.4) với timeout 5 s và chưa đăng ký tác vụ nào (CONFIG_ESP_TASK_WDT_CHECK_IDLE_TASK_CPU0
  // tắt) nên deinit được, rồi init lại với timeout dài hơn: một request HTTPS tệ nhất (DNS + TCP + TLS + đọc) có thể mất ~1 phút.
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
  configTime(0, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com");  // chuỗi tĩnh: lwIP giữ con trỏ
}

void EspPlatform::onNtpSynced() {
  // Chỉ tin khi giờ thật sự hợp lý (phòng server NTP trả rác).
  if (auhono::isPlausibleUnix(static_cast<uint64_t>(time(nullptr)))) trusted_ = true;
}

uint32_t EspPlatform::monoSeconds() {
  // esp_timer_get_time(): micro giây 64 bit từ lúc khởi động, không tràn, không bị settimeofday/NTP làm nhảy.
  return static_cast<uint32_t>(esp_timer_get_time() / 1000000LL);
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
  if (size > 0) body.reserve(static_cast<size_t>(size));
  const uint32_t deadline = ::millis() + cfg::kBodyReadTimeoutMs;
  uint8_t buf[256];
  while (body.size() < cfg::kMaxResponseBytes && static_cast<int32_t>(::millis() - deadline) < 0) {
    esp_task_wdt_reset();
    if (size >= 0 && body.size() >= static_cast<size_t>(size)) break;
    const int avail = stream->available();
    if (avail > 0) {
      const int n = static_cast<int>(stream->readBytes(buf, static_cast<size_t>(avail) < sizeof buf ? static_cast<size_t>(avail) : sizeof buf));
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

  // Không mở phiên TLS mới khi heap không đủ hoặc bị phân mảnh: thất bại sớm, sạch (main đếm để khởi động lại có lý do)
  // còn hơn để mbedtls hết bộ nhớ giữa chừng.
  if (!auhono::tlsHeapOk(ESP.getFreeHeap(), ESP.getMaxAllocHeap())) {
    heapLow_ = true;
    Serial.printf("[http] heap khong du mo TLS (free %u, khoi lon nhat %u)\n", static_cast<unsigned>(ESP.getFreeHeap()),
                  static_cast<unsigned>(ESP.getMaxAllocHeap()));
    return out;  // status 0 => lỗi mạng
  }

  WiFiClientSecure client;
  configureTls(client, insecureRescue_);  // xác thực chứng chỉ (hoặc setInsecure khi -DALLOW_INSECURE_TLS / cứu hộ OTA)
  client.setHandshakeTimeout(cfg::kTlsHandshakeTimeoutS);  // giây

  HTTPClient http;
  const String url = String(AUHONO_SERVER_URL) + req.pathAndQuery.c_str();  // String duy nhất trên đường nóng: ~70 byte, giải phóng ngay
  if (!http.begin(client, url)) return out;
  http.setReuse(false);
  http.useHTTP10(true);  // tránh "Transfer-Encoding: chunked": phản hồi có độ dài xác định
  http.setConnectTimeout(cfg::kHttpConnectTimeoutMs);
  http.setTimeout(cfg::kHttpTimeoutMs);
  http.setUserAgent("Auhono/" AUHONO_FW_VERSION);
  http.addHeader("Accept-Encoding", "identity");  // không gzip: ta không giải nén

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
  } else {
    // Kết nối không thiết lập được. Nếu lý do là xác thực chứng chỉ thất bại (CA gốc đổi/bị can thiệp) thì báo lên:
    // nhiều lần liên tiếp sẽ mở "OTA cứu hộ" (maintenance.h).
    char errBuf[64];
    out.certError = client.lastError(errBuf, sizeof errBuf) == MBEDTLS_ERR_X509_CERT_VERIFY_FAILED;
  }
  http.end();
  return out;
}
