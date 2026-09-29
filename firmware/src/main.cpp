// Auhono: cảm biến nhiệt độ tủ đông (ESP32-C3 + DS18B20).
//
// Toàn bộ logic không phụ thuộc phần cứng nằm trong lib/auhono_core (có test chạy trên máy).
// File này chỉ "dán" các phần với phần cứng: Wi-Fi, HTTPS, NVS, DS18B20, OTA, cổng cấu hình, LED.
//
// Vòng lặp chính (không chặn lâu, luôn nuôi watchdog):
//   nút bấm -> Wi-Fi -> cổng cấu hình -> đồng hồ -> đo -> gửi -> OTA -> đèn LED
#include <Arduino.h>
#include <esp_ota_ops.h>
#include <sdkconfig.h>

#include <memory>

#include "auhono/button.h"
#include "auhono/led.h"
#include "auhono/portal_form.h"
#include "auhono/readings.h"
#include "auhono/time_policy.h"
#include "auhono/uploader.h"
#include "config.h"
#include "ota.h"
#include "platform_esp32.h"
#include "portal.h"
#include "sensor.h"
#include "status_led.h"
#include "storage.h"
#include "wifi_manager.h"

#ifdef SET_LOOP_TASK_STACK_SIZE
SET_LOOP_TASK_STACK_SIZE(12 * 1024);  // TLS + kiểm chữ ký cần nhiều stack hơn mặc định 8 KB
#endif

// Rollback OTA: mặc định core Arduino tự "xác nhận" bản mới ngay lúc khởi động (như vậy rollback vô
// nghĩa). Trả true để DỜI việc xác nhận tới khi bản mới liên lạc được với server (xem markAppValid()).
#ifdef CONFIG_APP_ROLLBACK_ENABLE
extern "C" bool verifyRollbackLater() { return true; }
#endif

// ── Đối tượng toàn cục ─────────────────────────────────────────────────────
static MbedCrypto g_crypto;
static EspRandom g_rng;
static EspPlatform g_platform;
static NvsSeqStore g_seqStore;
static auhono::SeqCounter g_seq(g_seqStore, cfg::kSeqStride);
static HttpsTransport g_http;

static auhono::ReadingBuffer g_buffer(cfg::kBufferCapacity);  // 1440 x 8 B = 11,5 KB (RAM; mất khi mất điện)
static auhono::Thresholds g_thresholds;
static auhono::UploadPolicy g_policy(cfg::kUploadPeriodMs, cfg::kImmediateMinIntervalMs);
static auhono::Backoff g_uploadBackoff(g_rng);
static auhono::SensorHealth g_health;
static auhono::ButtonGesture g_button;

static WifiManager g_wifi(g_rng);
static Portal g_portal;
static Sensor g_sensor;
static StatusLed g_led;

static Identity g_identity;
static std::unique_ptr<auhono::Signer> g_signer;
static std::unique_ptr<auhono::DeviceClient> g_client;
static std::unique_ptr<auhono::ReadingsUploader> g_uploader;

// ── Trạng thái vận hành ────────────────────────────────────────────────────
static bool g_hasWifiCreds = false;
static auhono::UploadStatus g_uploadStatus = auhono::UploadStatus::Unknown;
static bool g_serverContact = false;      // đã có ít nhất một phản hồi 200 từ lúc khởi động
static uint32_t g_lastContactMs = 0;
static bool g_appPendingVerify = false;   // bản OTA mới chưa được xác nhận
static bool g_appMarkedValid = false;

static uint32_t g_nextSampleAt = 0;
static uint32_t g_conversionReadyAt = 0;
static bool g_conversionPending = false;

static uint32_t g_wifiUpAt = 0;
static uint32_t g_nextTimeFallbackAt = 0;
static uint32_t g_nextOtaAt = 0;

// ── Tiện ích ───────────────────────────────────────────────────────────────

static bool reached(uint32_t now, uint32_t deadline) { return static_cast<int32_t>(now - deadline) >= 0; }

static void startPortal(uint32_t now) {
  if (g_portal.active()) return;
  Serial.println("[portal] mo Wi-Fi cau hinh");
  g_wifi.stop();
  g_portal.start(g_identity.deviceId, now);
}

static void stopPortalAndResume(uint32_t now) {
  g_portal.stop();
  const WifiCreds creds = loadWifiCreds();
  g_hasWifiCreds = creds.present();
  if (g_hasWifiCreds) g_wifi.begin(creds, now);
}

/// Xác nhận bản firmware hiện tại là tốt (hủy rollback) sau lần liên lạc thành công đầu tiên.
static void markAppValid() {
  if (g_appMarkedValid || !g_appPendingVerify) return;
  if (esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) {
    g_appMarkedValid = true;
    Serial.println("[ota] ban moi da duoc xac nhan");
  }
}

// ── Xử lý các phần ─────────────────────────────────────────────────────────

static void handleButton(uint32_t now) {
  switch (g_button.update(digitalRead(BUTTON_PIN) == LOW, now)) {
    case auhono::ButtonEvent::LongPress:      // giữ 5 s: mở cổng cấu hình
      startPortal(now);
      break;
    case auhono::ButtonEvent::VeryLongPress:  // giữ 15 s: xóa Wi-Fi đã lưu (giữ danh tính)
      Serial.println("[reset] xoa Wi-Fi da luu");
      clearWifiCreds();
      g_hasWifiCreds = false;
      startPortal(now);
      break;
    default:
      break;
  }
}

static void handlePortal(uint32_t now) {
  if (!g_portal.active()) return;
  g_portal.loop(now);

  WifiCreds saved;
  if (g_portal.takeSaved(saved, now)) {
    if (saveWifiCreds(saved)) Serial.println("[portal] da luu Wi-Fi moi");
    g_portal.stop();
    g_hasWifiCreds = true;
    g_wifi.begin(saved, now);
    g_uploadStatus = auhono::UploadStatus::Unknown;
    return;
  }
  if (g_portal.timedOut(now, cfg::kPortalTimeoutMs)) {
    Serial.println("[portal] het gio");
    if (g_hasWifiCreds) {
      stopPortalAndResume(now);  // quay lại thử Wi-Fi đã lưu, KHÔNG khởi động lại (giữ số đo trong RAM)
    } else {
      ESP.restart();             // chưa có Wi-Fi nào: khởi động lại cho sạch rồi mở lại cổng
    }
  }
}

static void handleClock(uint32_t now) {
  static bool prevTrusted = false;

  if (!g_wifi.connected()) { g_wifiUpAt = 0; return; }
  if (g_wifiUpAt == 0) {
    g_wifiUpAt = now ? now : 1;
    g_lastContactMs = now;  // "12 giờ không liên lạc" chỉ tính khi Wi-Fi đang nối (mất Wi-Fi lâu không gây khởi động lại)
  }
  g_platform.startNtp();

  // NTP không trả lời sau kNtpWaitMs: hỏi giờ từ server (GET /v1/time, không cần ký).
  if (!g_platform.clockTrusted() && g_client && reached(now, g_wifiUpAt + cfg::kNtpWaitMs) &&
      reached(now, g_nextTimeFallbackAt)) {
    g_nextTimeFallbackAt = now + cfg::kTimeFallbackRetryMs;
    Serial.println(g_client->syncTimeFromServer() ? "[time] lay gio tu server" : "[time] chua co gio");
  }

  // Vừa có giờ đáng tin: đo ngay (các số đo trước đó đã bị bỏ vì chưa biết giờ).
  const bool trusted = g_platform.clockTrusted();
  if (trusted && !prevTrusted) g_nextSampleAt = now;
  prevTrusted = trusted;
}

static void handleSampling(uint32_t now) {
  if (g_conversionPending && reached(now, g_conversionReadyAt)) {
    g_conversionPending = false;
    const float c = g_sensor.readCelsius();
    const auhono::ReadStatus st = auhono::classifyCelsius(c);
    g_health.onRead(st);
    if (st != auhono::ReadStatus::Ok) {
      Serial.printf("[sensor] bo so do loi (%d)\n", static_cast<int>(st));  // -127 / 85 / NaN: không ghi, không gửi
    } else if (!g_platform.clockTrusted()) {
      Serial.println("[sensor] chua co gio, bo so do");  // không ghi số đo khi chưa biết giờ
    } else {
      const int16_t centi = auhono::celsiusToCenti(c);
      g_buffer.push(auhono::Reading{g_platform.unixNow(), centi});
      g_policy.noteReading(g_thresholds.outOfRange(centi));
    }
  }
  if (reached(now, g_nextSampleAt)) {
    // Cộng dồn để không trôi nhịp; nếu bị trễ nhiều (vd. đang tải OTA) thì đo ngay rồi tính lại.
    g_nextSampleAt += cfg::kSampleIntervalMs;
    if (reached(now, g_nextSampleAt)) g_nextSampleAt = now + cfg::kSampleIntervalMs;
    g_sensor.startConversion();
    g_conversionPending = true;
    g_conversionReadyAt = now + cfg::kSensorConversionMs;
  }
}

static void handleUpload(uint32_t now) {
  if (!g_uploader || !g_wifi.connected() || !g_platform.clockTrusted()) return;

  const auhono::UploadReason reason = g_policy.poll(now, !g_buffer.empty());
  if (reason == auhono::UploadReason::None) return;

  const auhono::FlushResult f = g_uploader->flush();
  if (f.thresholdsChanged) saveThresholds(g_thresholds);  // chỉ ghi flash khi ngưỡng thật sự đổi
  if (f.reachedServer) {
    g_serverContact = true;
    g_lastContactMs = now;
    markAppValid();
  }

  if (f.ok) {
    g_uploadBackoff.reset();
    g_uploadStatus = auhono::UploadStatus::Ok;
    if (f.remaining > 0) g_policy.onFailure(now, 2000);  // còn dữ liệu (chạm giới hạn gói): gửi tiếp sớm
    else g_policy.onSuccess();
  } else {
    g_uploadStatus = auhono::UploadStatus::Failed;
    const uint32_t delay = g_uploadBackoff.nextDelayMs();  // 30 s -> 1 -> 2 -> 5 phút, ±20%
    g_policy.onFailure(now, delay);
    Serial.printf("[upload] loi (%d), thu lai sau %lu ms, con %u so do\n", static_cast<int>(f.lastKind),
                  static_cast<unsigned long>(delay), static_cast<unsigned>(f.remaining));
  }
}

static void handleOta(uint32_t now) {
  if (!g_client || !g_wifi.connected() || !g_serverContact || !reached(now, g_nextOtaAt)) return;
  g_nextOtaAt = now + cfg::kOtaCheckIntervalMs;  // đặt trước: lỗi cũng không hỏi dồn dập

  switch (otaCheckAndUpdate(*g_client, g_platform)) {
    case OtaOutcome::Installed:
      Serial.println("[ota] da cai, khoi dong lai");
      delay(500);
      ESP.restart();
      break;
    case OtaOutcome::Rejected:
      Serial.println("[ota] ban tai ve bi tu choi, giu ban hien tai");
      break;
    default:
      break;
  }
}

/// Lưới an toàn cuối: không liên lạc được server quá lâu (kể cả khi Wi-Fi báo "đã nối") thì khởi động lại;
/// và bản OTA mới không liên lạc được server trong kRollbackWindowMs thì quay về bản cũ.
static void handleSelfHeal(uint32_t now) {
  if (g_appPendingVerify && !g_appMarkedValid && reached(now, cfg::kRollbackWindowMs)) {
    Serial.println("[ota] ban moi khong lien lac duoc server: quay ve ban cu");
    esp_ota_mark_app_invalid_rollback_and_reboot();  // không trả về nếu có bản cũ hợp lệ
    g_appPendingVerify = false;                      // không rollback được: tiếp tục chạy như bình thường
  }
  if (g_uploader && g_wifi.connected() && static_cast<uint32_t>(now - g_lastContactMs) > cfg::kNoContactRestartMs) {
    Serial.println("[heal] qua lau khong lien lac duoc server: khoi dong lai");
    ESP.restart();
  }
}

// ── Arduino ────────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);
#if ARDUINO_USB_CDC_ON_BOOT
  Serial.setTxTimeoutMs(0);  // không cắm máy tính thì log bị bỏ, KHÔNG được chặn chương trình
#endif
  g_led.begin();
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  const uint32_t now = millis();

  storageBegin();
  g_platform.begin();  // callback NTP + watchdog

  g_identity = loadIdentity();
  g_thresholds = loadThresholds();
  Serial.printf("\nAuhono fw %s, thiet bi %s\n", AUHONO_FW_VERSION, g_identity.valid ? g_identity.deviceId.c_str() : "(chua nap danh tinh)");

  if (g_identity.valid) {
    g_seq.begin();
    g_signer.reset(new auhono::Signer(g_crypto, g_identity.deviceId, g_identity.key));
    g_client.reset(new auhono::DeviceClient(*g_signer, g_seq, g_platform, g_http));
    g_uploader.reset(new auhono::ReadingsUploader(*g_client, g_buffer, g_thresholds, g_platform, AUHONO_FW_VERSION));
    memset(g_identity.key, 0, sizeof g_identity.key);  // Signer đã giữ bản sao; xóa bản trong biến toàn cục
  }

  // Bản OTA mới đang chờ xác nhận?
  esp_ota_img_states_t state;
  if (esp_ota_get_state_partition(esp_ota_get_running_partition(), &state) == ESP_OK) {
    g_appPendingVerify = (state == ESP_OTA_IMG_PENDING_VERIFY);
  }

  g_sensor.begin();

  const WifiCreds creds = loadWifiCreds();
  g_hasWifiCreds = creds.present();
  if (g_hasWifiCreds) {
    g_wifi.begin(creds, now);
  } else {
    startPortal(now);  // lần đầu cắm điện: phát Wi-Fi cấu hình
  }
  g_nextSampleAt = now;
  g_lastContactMs = now;
}

void loop() {
  g_platform.feedWatchdog();
  const uint32_t now = millis();

  handleButton(now);
  g_wifi.loop(now);
  handlePortal(now);

  // Mất Wi-Fi đã lưu quá lâu (vd. đổi modem): mở lại cổng cấu hình để chủ quán tự sửa.
  if (!g_portal.active() && g_hasWifiCreds && g_wifi.disconnectedForMs(now) > cfg::kWifiFailToPortalMs) {
    g_wifi.resetDisconnectTimer(now);
    startPortal(now);
  }

  handleClock(now);
  handleSampling(now);
  handleUpload(now);
  handleOta(now);
  handleSelfHeal(now);

  auhono::LedInputs led;
  led.hasIdentity = g_identity.valid;
  led.portalActive = g_portal.active();
  led.wifiConnected = g_wifi.connected();
  led.sensorFault = g_health.faulty();
  led.upload = g_uploadStatus;
  g_led.update(now, led);

  delay(10);  // nhường CPU cho tác vụ Wi-Fi/lwIP
}
