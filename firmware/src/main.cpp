// Auhono: cảm biến nhiệt độ tủ đông (ESP32-C3 + DS18B20).
//
// Toàn bộ logic không phụ thuộc phần cứng nằm trong lib/auhono_core (có test chạy trên máy). File này chỉ "dán" các phần
// với phần cứng: Wi-Fi, HTTPS, NVS, DS18B20, OTA, cổng cấu hình, LED, và điều phối theo chính sách của lõi.
//
// Vòng lặp chính (không chặn lâu, luôn nuôi watchdog):
//   nút bấm -> Wi-Fi -> cổng cấu hình -> đồng hồ -> đo -> gửi -> OTA -> bảo trì -> đèn LED
//
// Nguyên tắc thiết kế (xem README, bảng "Tình huống thực tế"):
//   - số đo đóng dấu bằng GIỜ ĐƠN ĐIỆU (giây từ lúc khởi động), đổi sang giờ unix lúc gửi => số đo sau mất điện, trước khi có NTP,
//     vẫn được gửi với giờ đúng, và NTP/clock_skew chỉnh giờ giữa chừng không làm sai dữ liệu;
//   - mọi so sánh thời gian dùng phép trừ uint32 (an toàn khi millis() tràn 49,7 ngày);
//   - không thao tác nào chặn quá vài chục giây (mọi thời hạn cộng lại < watchdog 120 s).
#include <Arduino.h>
#include <esp_ota_ops.h>
#include <esp_partition.h>
#include <esp_system.h>
#include <WiFi.h>
#include <sdkconfig.h>

#include <memory>

#include "auhono/ap_credentials.h"
#include "auhono/button.h"
#include "auhono/heartbeat.h"
#include "auhono/jitter_random.h"
#include "auhono/led.h"
#include "auhono/maintenance.h"
#include "auhono/ota_policy.h"
#include "auhono/plausibility.h"
#include "auhono/portal_form.h"
#include "auhono/readings.h"
#include "auhono/retry_policy.h"
#include "auhono/time_policy.h"
#include "auhono/uploader.h"
#include "auhono/wifi_policy.h"
#include "config.h"
#include "ota.h"
#include "platform_esp32.h"
#include "portal.h"
#include "sensor.h"
#include "status_led.h"
#include "storage.h"
#include "wifi_manager.h"

#ifdef SET_LOOP_TASK_STACK_SIZE
SET_LOOP_TASK_STACK_SIZE(16 * 1024);  // TLS + kiểm chữ ký + OTA cần nhiều stack hơn mặc định 8 KB
#endif

// Rollback OTA: mặc định core Arduino tự "xác nhận" bản mới ngay lúc khởi động (như vậy rollback vô nghĩa). Trả true để DỜI
// việc xác nhận tới khi bản mới liên lạc được với server (xem markAppValid()). Core 2.0.17 dịch với CONFIG_APP_ROLLBACK_ENABLE=y
// và bootloader dựng sẵn của nó có mã rollback (CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y); nếu vì lý do nào đó không, lớp
// rollback MỀM bằng sổ cài (OtaLedger) vẫn hoạt động.
#ifdef CONFIG_APP_ROLLBACK_ENABLE
extern "C" bool verifyRollbackLater() { return true; }
#endif

// ── Đối tượng toàn cục ─────────────────────────────────────────────────────
static MbedCrypto g_crypto;
static EspRandom g_hwRng;
static auhono::MixedRandom g_rng(g_hwRng, 0x9E3779B9u);  // hạt giống riêng từng máy được trộn thêm sau khi có mã thiết bị
static EspPlatform g_platform;
static NvsSeqStore g_seqStore;
static auhono::SeqCounter g_seq(g_seqStore, cfg::kSeqStride);
static HttpsTransport g_http;

static auhono::ReadingBuffer g_buffer(cfg::kBufferCapacity);  // 1440 x 8 B = 11,5 KB (RAM; mất khi mất điện)
static auhono::Thresholds g_thresholds;
static auhono::UploadPolicy g_policy(cfg::kUploadPeriodMs, cfg::kImmediateMinIntervalMs);
static auhono::RetryScheduler g_retry(g_rng);
static auhono::Backoff g_timeBackoff(g_rng);
static auhono::SensorHealth g_health;
static auhono::SensorWatch g_watch;      // lần cuối có số đo hợp lệ (nhịp tim khi đầu dò hỏng >= 5 phút)
static auhono::ReadingFilter g_filter;
static auhono::ButtonGesture g_button;
static auhono::TlsRescue g_rescue;

static NvsOtaStore g_otaStore;
static auhono::OtaLedger g_ota(g_otaStore);

static WifiManager g_wifi(g_rng);
static Portal g_portal;
static Sensor g_sensor;
static StatusLed g_led;

static Identity g_identity;
static std::string g_apPassword;           // mật khẩu WPA2 của AP cấu hình, suy ra từ khóa (KHÔNG BAO GIỜ in ra log/trang)
static const char* g_rstToken = "unknown"; // lý do reset của chip dạng từ khóa ngắn cho diag.rst
static std::unique_ptr<auhono::Signer> g_signer;
static std::unique_ptr<auhono::DeviceClient> g_client;
static std::unique_ptr<auhono::ReadingsUploader> g_uploader;

// ── Trạng thái vận hành ────────────────────────────────────────────────────
static bool g_hasWifiCreds = false;
static auhono::UploadStatus g_uploadStatus = auhono::UploadStatus::Unknown;
static bool g_lastUploadOk = false;
static bool g_serverContact = false;      // đã có ít nhất một phản hồi hợp lệ từ server kể từ lúc khởi động
static uint32_t g_contactRefMs = 0;       // lần liên lạc thành công gần nhất, hoặc lúc Wi-Fi nối lại (cái nào muộn hơn)
static bool g_prevWifiUp = false;
static bool g_appPendingVerify = false;   // bản OTA mới chưa được xác nhận
static bool g_appMarkedValid = false;
static uint8_t g_recoveryStage = 0;

static uint32_t g_nextSampleAt = 0;
static uint32_t g_conversionReadyAt = 0;
static bool g_conversionPending = false;
static uint32_t g_confirmAt = 0;
static bool g_confirmPending = false;
static bool g_haveLast = false;
static int16_t g_lastCenti = 0;
static uint32_t g_lastReadingMono = 0;
static uint32_t g_lastSensorLogMs = 0;

static uint32_t g_wifiUpAt = 0;
static uint32_t g_nextTimeFallbackAt = 0;
static uint32_t g_nextOtaAt = 0;
static bool g_uploadGateArmed = false;

static uint32_t g_nextHeapCheckAt = 0;
static uint32_t g_nextHeapLogAt = 0;
static uint8_t g_critStrikes = 0;
static uint8_t g_lowStrikes = 0;
static uint32_t g_nextPortalStatusAt = 0;
static uint32_t g_nextHoldOffCheckAt = 0;
static uint32_t g_portalAutoCloseAt = 0;

// ── Tiện ích ───────────────────────────────────────────────────────────────

using auhono::reached;  // so sánh mốc thời gian an toàn khi millis() tràn (time_policy.h)

static const char* resetReasonText(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_POWERON:   return "cap dien";
    case ESP_RST_EXT:       return "chan RESET ngoai";
    case ESP_RST_SW:        return "phan mem (esp_restart)";
    case ESP_RST_PANIC:     return "PANIC/exception";
    case ESP_RST_INT_WDT:   return "watchdog ngat";
    case ESP_RST_TASK_WDT:  return "watchdog tac vu (loop dung)";
    case ESP_RST_WDT:       return "watchdog khac";
    case ESP_RST_DEEPSLEEP: return "deep sleep";
    case ESP_RST_BROWNOUT:  return "BROWNOUT (nguon sut ap)";
    default:                return "khong ro";
  }
}

static bool breachActive() {
  // Số đo gần nhất còn "tươi" (10 phút) và vượt ngưỡng: đang có báo động, ưu tiên gửi/cảnh báo hơn OTA/khởi động lại.
  if (!g_haveLast) return false;
  if (static_cast<uint32_t>(g_platform.monoSeconds() - g_lastReadingMono) > 600) return false;
  return g_thresholds.outOfRange(g_lastCenti);
}

/// Khởi động lại có LÝ DO: ghi NVS trước khi restart để log lần sau còn biết vì sao.
static void rebootWithReason(auhono::RebootReason why) {
  Serial.printf("[reboot] %s\n", auhono::rebootReasonText(why));
  saveRebootReason(why);
  delay(300);
  ESP.restart();
}

/// Xác nhận bản firmware hiện tại là tốt (hủy rollback) sau lần liên lạc thành công đầu tiên.
static void markAppValid() {
  g_ota.onConfirmed();
  if (g_appMarkedValid || !g_appPendingVerify) return;
  if (esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) {
    g_appMarkedValid = true;
    Serial.println("[ota] ban moi da duoc xac nhan");
  }
}

static void noteContact(uint32_t now) {
  g_serverContact = true;
  g_contactRefMs = now;
  g_recoveryStage = 0;
  markAppValid();
}

/// Rollback mềm: đặt lại khe khởi động về ảnh cũ (esp_ota_set_boot_partition tự xác thực ảnh) rồi khởi động lại.
static bool softRollback() {
  const esp_partition_t* other = esp_ota_get_next_update_partition(nullptr);
  if (!other || esp_ota_set_boot_partition(other) != ESP_OK) return false;
  rebootWithReason(auhono::RebootReason::Rollback);
  return true;
}

static void startPortal(uint32_t now, bool byUser) {
  if (g_portal.active()) return;
#ifndef ALLOW_OPEN_AP
  // Bản phát hành KHÔNG BAO GIỜ phát Wi-Fi mở: thiếu danh tính/khóa thì không có mật khẩu WPA2 => không mở AP.
  // Lỗi hiện bằng đèn "3 nháy ngắn" (thiếu danh tính) và log này.
  if (!g_identity.valid || g_apPassword.empty()) {
    Serial.println("[portal] LOI: chua nap danh tinh/khoa, khong co mat khau WPA2 nen KHONG mo Wi-Fi cau hinh. Chay tools/flash_identity.py");
    return;
  }
#endif
  Serial.println("[portal] mo Wi-Fi cau hinh (WPA2)");
  if (!g_portal.start(g_identity.valid ? g_identity.deviceId : std::string(), g_apPassword, AUHONO_FW_VERSION, now, byUser)) return;
  g_portalAutoCloseAt = 0;
  g_nextPortalStatusAt = 0;
}

static void stopPortal(uint32_t now) {
  g_portal.stop();
  g_wifi.setHoldOff(false);
  g_wifi.resetDisconnectTimer(now);  // đếm lại từ đầu trước khi tự mở lại
  if (g_hasWifiCreds && !g_wifi.active()) g_wifi.begin(loadWifiCreds(), now);  // vd. sau khi xóa Wi-Fi rồi cấu hình lại
}

// ── Xử lý các phần ─────────────────────────────────────────────────────────

static void handleButton(uint32_t now) {
  switch (g_button.update(digitalRead(BUTTON_PIN) == LOW, now)) {
    case auhono::ButtonEvent::LongPress:      // giữ 5 s: mở cổng cấu hình (STA vẫn tiếp tục thử nối Wi-Fi đã lưu)
      startPortal(now, true);
      break;
    case auhono::ButtonEvent::VeryLongPress:  // giữ >= 15 s rồi NHẢ: xóa Wi-Fi đã lưu (giữ danh tính)
      Serial.println("[reset] xoa Wi-Fi da luu");
      clearWifiCreds();
      g_hasWifiCreds = false;
      g_wifi.stop();
      startPortal(now, true);
      break;
    default:
      break;
  }
}

static void handlePortal(uint32_t now) {
  if (g_portal.active()) {
    g_portal.loop(now);

    if (reached(now, g_nextPortalStatusAt)) {  // trạng thái Wi-Fi hiện lên trang (1 s một lần)
      g_nextPortalStatusAt = now + 1000;
      g_portal.setStatus(g_wifi.creds().ssid, g_wifi.connected(), g_wifi.lastFail());
    }
    if (reached(now, g_nextHoldOffCheckAt)) {  // có điện thoại đang dùng AP hoặc đang quét: tạm dừng thử nối để không nhảy kênh
      g_nextHoldOffCheckAt = now + 500;
      g_wifi.setHoldOff(g_portal.stationCount() > 0 || g_portal.scanning());
    }

    auhono::WifiCreds saved;
    if (g_portal.takeSaved(saved, now)) {
      if (saveWifiCreds(saved)) Serial.println("[portal] da luu Wi-Fi moi");
      else Serial.println("[portal] CANH BAO: khong ghi duoc Wi-Fi vao flash, dung tam trong RAM");
      g_portal.stop();
      g_wifi.setHoldOff(false);
      g_hasWifiCreds = true;
      g_wifi.begin(saved, now);
      g_uploadStatus = auhono::UploadStatus::Unknown;
      return;
    }

    if (!g_hasWifiCreds) {
      g_portal.touch(now);  // chưa có Wi-Fi nào: thiết bị chưa làm gì khác được, cổng mở cho tới khi được cấu hình
    } else if (g_portal.idleTimedOut(now)) {
      Serial.println("[portal] het gio, tiep tuc thu Wi-Fi da luu");
      stopPortal(now);  // KHÔNG khởi động lại: giữ số đo trong RAM
    } else if (!g_portal.byUser() && g_wifi.connected() && g_portal.stationCount() == 0) {
      // Cổng tự mở vì mất Wi-Fi, nay Wi-Fi đã về và không ai đang cấu hình: đóng sau một lúc.
      if (g_portalAutoCloseAt == 0) g_portalAutoCloseAt = now ? now : 1;
      if (static_cast<uint32_t>(now - g_portalAutoCloseAt) >= cfg::kPortalAutoCloseGraceMs) {
        Serial.println("[portal] Wi-Fi da ve, dong cong");
        stopPortal(now);
      }
    } else {
      g_portalAutoCloseAt = 0;
    }
    return;
  }

  // Cổng đóng: mất Wi-Fi đã lưu đủ lâu (mặc định 20 phút; sớm hơn — 5 phút — nếu router THẤY nhưng từ chối, tức đổi mật khẩu)
  // thì mở lại để chủ quán tự sửa mà không cần cáp/nút.
  if (g_hasWifiCreds && auhono::shouldOpenPortal(g_wifi.disconnectedForMs(now), g_wifi.lastFail(), g_wifi.failStableMs(now))) {
    g_wifi.resetDisconnectTimer(now);
    startPortal(now, false);
  }
}

static void handleClock(uint32_t now) {
  static bool prevTrusted = false;

  const bool up = g_wifi.connected();
  if (up && !g_prevWifiUp) g_contactRefMs = now;  // "không liên lạc được" chỉ tính từ lúc Wi-Fi nối
  g_prevWifiUp = up;
  if (!up) { g_wifiUpAt = 0; return; }
  if (g_wifiUpAt == 0) g_wifiUpAt = now ? now : 1;
  g_platform.startNtp();

  // NTP không trả lời sau kNtpWaitMs (UDP/123 bị router chặn...): hỏi giờ từ server qua HTTPS (GET /v1/time, không cần ký;
  // TLS đã xác thực server nên tin được). Thử lại với backoff, không dồn dập.
  if (!g_platform.clockTrusted() && g_client && reached(now, g_wifiUpAt + cfg::kNtpWaitMs) && reached(now, g_nextTimeFallbackAt)) {
    if (g_client->syncTimeFromServer()) {
      Serial.println("[time] lay gio tu server");
      g_timeBackoff.reset();
      g_nextTimeFallbackAt = now + 60000;
    } else {
      g_nextTimeFallbackAt = now + g_timeBackoff.nextDelayMs();
      Serial.println("[time] chua co gio");
    }
  }

  const bool trusted = g_platform.clockTrusted();
  if (trusted && !prevTrusted) Serial.printf("[time] da co gio, con %u so do dang cho gui\n", static_cast<unsigned>(g_buffer.size()));
  prevTrusted = trusted;
}

static void logSensorProblem(const SensorSample& s, uint32_t now) {
  if (static_cast<uint32_t>(now - g_lastSensorLogMs) < 60000 && g_lastSensorLogMs != 0) return;  // không xả log
  g_lastSensorLogMs = now ? now : 1;
  const char* why = !s.busPresent ? "khong thay cam bien (dut day/rut dau do/thieu tro keo 4,7k)"
                    : s.status == auhono::Ds18Status::BadCrc ? "CRC sai (nhieu/cap dai)"
                    : s.status == auhono::Ds18Status::BadLayout ? "du lieu rac"
                    : s.status == auhono::Ds18Status::PowerOnValue ? "gia tri 85 do luc cap dien"
                    : "ngoai dai do";
  Serial.printf("[sensor] LOI: %s (%u lan lien tiep)\n", why, static_cast<unsigned>(g_health.consecutiveBad()));
}

static void onSensorResult(const SensorSample& s, uint32_t now) {
  const uint32_t mono = g_platform.monoSeconds();
  if (s.status != auhono::Ds18Status::Ok) {  // không ghi, không gửi: thiết bị im lặng -> server báo "mất kết nối"; đèn báo lỗi đầu dò
    g_filter.onSensorError();
    g_confirmPending = false;
    g_health.onBad();
    logSensorProblem(s, now);
    return;
  }
  switch (g_filter.onSample(s.centi, mono)) {
    case auhono::Verdict::Accept: {
      g_health.onGood();
      g_watch.onValidReading(mono);
      g_buffer.push(auhono::Reading{mono, s.centi});
      g_haveLast = true;
      g_lastCenti = s.centi;
      g_lastReadingMono = mono;
      g_policy.noteReading(g_thresholds.outOfRange(s.centi));
      char num[12];
      auhono::formatCenti(s.centi, num, sizeof num);
      Serial.printf("[sensor] %s C (con %u so do)\n", num, static_cast<unsigned>(g_buffer.size()));
      break;
    }
    case auhono::Verdict::Confirm:  // nghi ngờ (nhảy lớn/số đo đầu tiên): đo lại sau vài giây thay vì chờ 1 phút
      g_confirmPending = true;
      g_confirmAt = now + auhono::ReadingFilter::kConfirmDelayMs;
      break;
    case auhono::Verdict::Reject:
      g_health.onBad();
      Serial.println("[sensor] bo so do nhieu (khong on dinh)");
      break;
  }
}

static void startConversion(uint32_t now) {
  g_sensor.startConversion();
  g_conversionPending = true;
  g_conversionReadyAt = now + cfg::kSensorConversionMs;
}

static void handleSampling(uint32_t now) {
  if (g_conversionPending && reached(now, g_conversionReadyAt)) {
    g_conversionPending = false;
    onSensorResult(g_sensor.read(), now);
  }
  if (g_conversionPending) return;
  if (g_confirmPending && reached(now, g_confirmAt)) {  // đo lại để xác nhận số đo nghi ngờ (không dời nhịp đo chính)
    g_confirmPending = false;
    startConversion(now);
    return;
  }
  if (reached(now, g_nextSampleAt)) {
    // Cộng dồn để không trôi nhịp; nếu bị trễ nhiều (vd. đang tải OTA) thì đo ngay rồi tính lại.
    g_nextSampleAt += cfg::kSampleIntervalMs;
    if (reached(now, g_nextSampleAt)) g_nextSampleAt = now + cfg::kSampleIntervalMs;
    g_confirmPending = false;
    startConversion(now);
  }
}

/// Chẩn đoán kèm mọi gói (docs/PROTOCOL.md "diag"): đầu dò, số giây từ số đo hợp lệ cuối, lý do reset, RSSI, heap, uptime.
static auhono::Diag makeDiag() {
  const uint32_t mono = g_platform.monoSeconds();
  auhono::Diag d;
  d.hasSensor = true;
  d.sensorFault = g_watch.faulty(mono);
  d.hasFaultS = true;
  d.faultS = g_watch.secondsSinceValid(mono);
  strncpy(d.rst, g_rstToken, sizeof d.rst - 1);
  if (g_wifi.connected()) { d.hasRssi = true; d.rssi = static_cast<int>(WiFi.RSSI()); }
  d.hasHeap = true;
  d.heap = ESP.getFreeHeap();
  d.hasUp = true;
  d.up = mono;
  return d;
}

/// Cập nhật trạng thái/chính sách theo kết quả một lần gửi (gói số đo hoặc nhịp tim).
static void applyResult(uint32_t now, const auhono::FlushResult& f) {
  if (f.thresholdsChanged) saveThresholds(g_thresholds);  // chỉ ghi flash khi ngưỡng thật sự đổi
  if (f.staleDropped > 0 || f.discardedReadings > 0 || f.serverDroppedReadings > 0) {
    Serial.printf("[upload] bo: qua cu %u, bi server tu choi %u, server khong nhan %u\n", static_cast<unsigned>(f.staleDropped),
                  static_cast<unsigned>(f.discardedReadings), static_cast<unsigned>(f.serverDroppedReadings));
  }
  if (f.clockNotReady) {  // race hiếm: giờ vừa mất tính hợp lý; không tính là lỗi mạng
    g_policy.onFailure(now, 5000);
    return;
  }
  g_rescue.onAttempt(f.ok && f.reachedServer, f.certError, f.lastStatus > 0);
  if (g_http.takeHeapLow()) g_lowStrikes = g_lowStrikes < 255 ? g_lowStrikes + 1 : 255;
  if (f.reachedServer) noteContact(now);  // nhịp tim cũng là "đã liên lạc": không kích hoạt nối lại Wi-Fi/rollback vì đầu dò hỏng

  g_lastUploadOk = f.ok;
  if (f.ok) {
    g_retry.reset();
    g_uploadStatus = auhono::UploadStatus::Ok;
    if (f.remaining > 0) g_policy.onFailure(now, cfg::kUploadContinueMs);  // còn dữ liệu (chạm giới hạn gói/thời gian): gửi tiếp sớm
    else g_policy.onSuccess();
  } else {
    g_uploadStatus = auhono::UploadStatus::Failed;
    // 30 s -> 5 phút cho lỗi mạng/5xx; 5 phút -> 1 giờ cho 401/429/403/... (không gõ cửa server dồn dập)
    const uint32_t delayMs = g_retry.nextDelayMs(f.failClass);
    g_policy.onFailure(now, delayMs);
    Serial.printf("[upload] loi (loai %d, http %d), thu lai sau %lu ms, con %u so do\n", static_cast<int>(f.lastKind), f.lastStatus,
                  static_cast<unsigned long>(delayMs), static_cast<unsigned>(f.remaining));
  }
}

/// Gửi số đo trong bộ đệm (kèm diag). Dùng cho cả gửi định kỳ lẫn "gửi trước khi OTA".
static void flushAndApply(uint32_t now) {
  g_uploader->setDiag(makeDiag());
  applyResult(now, g_uploader->flush());
}

/// Nhịp tim: readings [] + diag (đầu dò hỏng >= 5 phút, bộ đệm rỗng). Không đụng tới bộ đệm.
static void heartbeatAndApply(uint32_t now) {
  Serial.printf("[heartbeat] dau do loi %lu s, gui nhip tim\n", static_cast<unsigned long>(g_watch.secondsSinceValid(g_platform.monoSeconds())));
  g_uploader->setDiag(makeDiag());
  applyResult(now, g_uploader->heartbeat());
}

static void handleUpload(uint32_t now) {
  if (!g_uploader || !g_wifi.connected() || !g_platform.clockTrusted()) return;

  if (!g_uploadGateArmed) {  // lần đầu sau khởi động có thể gửi: rải ngẫu nhiên 0-20 s theo từng máy (thundering herd)
    g_uploadGateArmed = true;
    const uint32_t jitter = g_rng.next() % cfg::kUploadStartJitterMaxMs;
    g_policy.delayStart(now, jitter);
    Serial.printf("[upload] gui lan dau sau %lu ms\n", static_cast<unsigned long>(jitter));
  }

  // Đầu dò hỏng >= 5 phút cũng là "có việc gửi" (nhịp tim): dùng đúng lịch định kỳ 5 phút + trễ ngẫu nhiên + backoff của UploadPolicy.
  // Còn số đo trong bộ đệm thì gói số đo (kèm diag) đi trước; nhịp tim chỉ khi bộ đệm rỗng.
  const bool heartbeatWanted = g_watch.faulty(g_platform.monoSeconds());
  const auhono::UploadReason reason = g_policy.poll(now, !g_buffer.empty() || heartbeatWanted);
  if (reason == auhono::UploadReason::None) return;
  if (!g_buffer.empty()) flushAndApply(now);
  else heartbeatAndApply(now);
}

/// Gọi liên tục khi đang tải OTA (vòng lặp chính bị chiếm): giữ nhịp đo. Trả false để HỦY tải khi vừa có số đo vượt ngưỡng.
static bool otaTick(void*) {
  const uint32_t now = millis();
  handleSampling(now);
  auhono::LedInputs led;
  led.hasIdentity = g_identity.valid;
  led.wifiConnected = g_wifi.connected();
  led.upload = g_uploadStatus;
  g_led.update(now, led);
  return !breachActive();
}

static void handleOta(uint32_t now) {
  if (!g_client || !g_wifi.connected() || !g_platform.clockTrusted() || !reached(now, g_nextOtaAt)) return;
  const bool needConfirm = g_appPendingVerify && !g_appMarkedValid;
  const bool rescue = g_rescue.rescueAllowed();
  // Kiểm tra định kỳ chỉ sau khi đã liên lạc được server; riêng bản mới chờ xác nhận thì dùng chính yêu cầu kiểm tra
  // (có ký) làm bằng chứng liên lạc, kể cả khi cảm biến hỏng và không có số đo nào để gửi.
  if (!g_serverContact && !needConfirm && !rescue) return;
  if (g_platform.monoSeconds() < 30) return;

  g_nextOtaAt = now + cfg::kOtaCheckIntervalMs;  // đặt trước: lỗi cũng không hỏi dồn dập

  // "Gửi trước, cài sau": trước khi kiểm tra OTA (6 giờ một lần) gửi nốt số đo đang chờ qua kênh BÌNH THƯỜNG (đã xác thực).
  // Nếu không, bộ đệm hầu như luôn có 1-5 số đo giữa hai lần gửi 5 phút và cửa ngõ OTA (còn số đo chưa gửi => hoãn) có thể hoãn
  // mãi mãi. Không bao giờ gửi số đo khi đang ở chế độ cứu hộ (kênh không xác thực chứng chỉ).
  if (!rescue && g_uploader && !g_buffer.empty() && g_uploadGateArmed && !g_policy.startDelayPending(now)) flushAndApply(now);

  if (rescue) Serial.println("[ota] CHE DO CUU HO: chung chi TLS hong keo dai, chi kiem tra/tai OTA (co chu ky) khong xac thuc chung chi");
  g_http.setInsecureRescue(rescue);
  g_client->setAllowClockAdopt(!rescue);  // kênh không xác thực chứng chỉ: kẻ đứng giữa không được đặt giờ của thiết bị

  OtaContext ctx;
  ctx.bufferCount = g_buffer.size();
  ctx.breachActive = breachActive();
  ctx.lastUploadOk = g_lastUploadOk;
  ctx.uptimeS = g_platform.monoSeconds();
  ctx.portalActive = g_portal.active();
  ctx.ledger = &g_ota;
  ctx.tick = otaTick;
  const OtaOutcome outcome = otaCheckAndUpdate(*g_client, g_platform, ctx, rescue);
  g_http.setInsecureRescue(false);
  g_client->setAllowClockAdopt(true);

  const auhono::HttpResponse& last = g_client->lastResponse();
  if (rescue) g_rescue.onAttempt(ctx.contacted, last.certError, last.status > 0);
  if (ctx.contacted) noteContact(now);

  switch (outcome) {
    case OtaOutcome::Installed:
      rebootWithReason(auhono::RebootReason::OtaInstalled);
      break;
    case OtaOutcome::Deferred:
      g_nextOtaAt = now + cfg::kOtaDeferredRetryMs;  // gửi số đo trước, hỏi lại sớm
      break;
    case OtaOutcome::CheckFailed:
      g_nextOtaAt = now + ((needConfirm || rescue) ? cfg::kOtaDeferredRetryMs * 2 : cfg::kOtaCheckIntervalMs / 6);
      break;
    case OtaOutcome::Rejected:
      Serial.println("[ota] khong cai duoc, giu ban hien tai");
      break;
    default:
      break;
  }
}

/// Lưới an toàn cuối cùng: heap, khởi động lại theo kế hoạch, cứu hộ kết nối, rollback bản OTA mới không sống được.
static void handleMaintenance(uint32_t now) {
  const uint32_t uptimeS = g_platform.monoSeconds();
  const bool wifiUp = g_wifi.connected();
  const uint32_t sinceContactS = wifiUp ? static_cast<uint32_t>(now - g_contactRefMs) / 1000 : 0;

  // 1. Heap: mỗi 30 s. "Không đủ mở TLS" kéo dài 10 phút, hoặc "nguy kịch" 3 lần liên tiếp -> khởi động lại có lý do.
  if (reached(now, g_nextHeapCheckAt)) {
    g_nextHeapCheckAt = now + cfg::kHeapCheckIntervalMs;
    const uint32_t freeHeap = ESP.getFreeHeap();
    const uint32_t maxBlock = ESP.getMaxAllocHeap();
    g_critStrikes = auhono::heapCritical(freeHeap, maxBlock) ? (g_critStrikes < 255 ? g_critStrikes + 1 : 255) : 0;
    if (auhono::tlsHeapOk(freeHeap, maxBlock)) g_lowStrikes = 0;
    else if (g_lowStrikes < 255) ++g_lowStrikes;
    if (reached(now, g_nextHeapLogAt)) {
      g_nextHeapLogAt = now + cfg::kHeapLogIntervalMs;
      Serial.printf("[heap] free %u, khoi lon nhat %u, thap nhat tu luc bat %u, uptime %lu s\n", static_cast<unsigned>(freeHeap),
                    static_cast<unsigned>(maxBlock), static_cast<unsigned>(ESP.getMinFreeHeap()), static_cast<unsigned long>(uptimeS));
    }
  }
  const bool heapBad = g_critStrikes >= auhono::kMaxLowHeapStrikes || g_lowStrikes >= cfg::kLowHeapStrikesNotCritical;

  // 2. Bản OTA mới chưa xác nhận mà không liên lạc được server: quay về bản cũ.
  if (g_appPendingVerify && !g_appMarkedValid) {
    const uint32_t wifiUpNoContactS = (wifiUp && !g_serverContact) ? sinceContactS : 0;
    if (auhono::shouldRollbackUnconfirmed(true, uptimeS, wifiUpNoContactS)) {
      Serial.println("[ota] ban moi khong lien lac duoc server: quay ve ban cu");
      saveRebootReason(auhono::RebootReason::Rollback);
      esp_ota_mark_app_invalid_rollback_and_reboot();  // không trả về nếu có bản cũ hợp lệ
      if (!softRollback()) g_appPendingVerify = false;  // không rollback được: tiếp tục chạy như bình thường
    }
  }

  // 3. Mất liên lạc với server dù Wi-Fi báo nối: leo thang không mất số đo (nối lại Wi-Fi 30 phút, khởi động lại driver 2 giờ).
  if (g_uploader && wifiUp) {
    switch (auhono::nextRecoveryStep(sinceContactS, g_recoveryStage)) {
      case auhono::RecoveryStep::CycleWifi: g_wifi.forceReconnect(now); break;
      case auhono::RecoveryStep::RestartWifiDriver: g_wifi.restartDriver(now); break;
      default: break;
    }
  }

  // 4. Khởi động lại có lý do (heap, 12 giờ không liên lạc, định kỳ 7/14 ngày khi rảnh).
  auhono::MaintenanceInputs in;
  in.uptimeS = uptimeS;
  in.bufferCount = g_buffer.size();
  in.lastUploadOk = g_lastUploadOk;
  in.sinceContactS = sinceContactS;
  in.wifiUp = wifiUp && g_uploader;
  in.breachActive = breachActive();
  in.portalActive = g_portal.active();
  in.otaBusy = false;  // OTA chạy đồng bộ trong handleOta(), nên khi tới đây không có OTA đang dở
  in.lowHeapStrikes = heapBad ? auhono::kMaxLowHeapStrikes : 0;
  const auhono::RebootReason why = auhono::decideReboot(in);
  if (why != auhono::RebootReason::None) rebootWithReason(why);
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

  // Lý do reset: cúp điện, brownout (cục sạc yếu), watchdog, panic... Nếu là brownout: giảm công suất phát Wi-Fi ở lần chạy này
  // (dòng đỉnh thấp hơn) để thoát vòng reset. Không ghi flash gì ở lúc khởi động ngoài việc xóa cờ "lý do chủ động" (nếu có).
  const esp_reset_reason_t rr = esp_reset_reason();
  g_rstToken = auhono::resetReasonToken(static_cast<int>(rr));
  const auhono::RebootReason why = takeRebootReason();
  g_identity = loadIdentity();
  Serial.printf("\nAuhono fw %s, thiet bi %s\n", AUHONO_FW_VERSION, g_identity.valid ? g_identity.deviceId.c_str() : "(chua nap danh tinh)");
  Serial.printf("[boot] ly do reset: %s%s%s\n", resetReasonText(rr), (rr == ESP_RST_SW && why != auhono::RebootReason::None) ? " - " : "",
                (rr == ESP_RST_SW && why != auhono::RebootReason::None) ? auhono::rebootReasonText(why) : "");
  if (rr == ESP_RST_BROWNOUT) {
    Serial.println("[boot] canh bao: nguon sut ap. Doi cuc sac >= 5V/1A, them tu 470uF gan bo mach. Giam cong suat Wi-Fi.");
    WifiManager::setLowPower(true);
  }
  Serial.printf("[boot] heap free %u, khoi lon nhat %u\n", static_cast<unsigned>(ESP.getFreeHeap()), static_cast<unsigned>(ESP.getMaxAllocHeap()));

  g_thresholds = loadThresholds();

  if (g_identity.valid) {
    // Hạt giống riêng từng máy: mã thiết bị + MAC, để 30 máy khởi động cùng lúc không trùng nhịp (backoff, trễ gửi đầu tiên).
    const uint64_t mac = ESP.getEfuseMac();
    uint8_t macBytes[8];
    for (int i = 0; i < 8; i++) macBytes[i] = static_cast<uint8_t>(mac >> (8 * i));
    g_rng.reseed(auhono::fnv1a32(reinterpret_cast<const uint8_t*>(g_identity.deviceId.data()), g_identity.deviceId.size(),
                                 auhono::fnv1a32(macBytes, sizeof macBytes)));

    g_seq.begin();
    g_signer.reset(new auhono::Signer(g_crypto, g_identity.deviceId, g_identity.key));
    g_client.reset(new auhono::DeviceClient(*g_signer, g_seq, g_platform, g_http));
    g_uploader.reset(new auhono::ReadingsUploader(*g_client, g_buffer, g_thresholds, g_platform, AUHONO_FW_VERSION));
    g_apPassword = auhono::deriveApPassword(g_crypto, g_identity.key);  // trước khi xóa khóa; giữ 10 ký tự trong RAM
    memset(g_identity.key, 0, sizeof g_identity.key);  // Signer đã giữ bản sao; xóa bản trong biến toàn cục
  }

  // OTA: bản mới đang chờ xác nhận? Rollback mềm nếu nó đã khởi động quá nhiều lần mà chưa liên lạc được server.
  esp_ota_img_states_t otaState;
  if (esp_ota_get_state_partition(esp_ota_get_running_partition(), &otaState) == ESP_OK) {
    g_appPendingVerify = (otaState == ESP_OTA_IMG_PENDING_VERIFY);
  }
  g_ota.load();
  if (g_ota.onBoot(AUHONO_FW_VERSION) == auhono::OtaLedger::BootVerdict::Rollback) {
    Serial.println("[ota] ban moi khoi dong nhieu lan ma chua xac nhan: rollback mem");
    if (!softRollback()) Serial.println("[ota] khong rollback duoc, tiep tuc chay");
  }

  g_sensor.begin();

  const WifiCreds creds = loadWifiCreds();
  g_hasWifiCreds = creds.present();
  if (g_hasWifiCreds) {
    g_wifi.begin(creds, now);
  } else {
    startPortal(now, false);  // lần đầu cắm điện: phát Wi-Fi cấu hình
  }
  g_nextSampleAt = now;      // đo NGAY (số đo sau khi có điện lại rất quan trọng); giờ unix chưa cần: số đo mang giờ đơn điệu
  g_contactRefMs = now;
  g_nextOtaAt = now;               // (không dựa vào giá trị khởi tạo 0: phép so sánh int32 chỉ đúng trong ~24,8 ngày)
  g_nextTimeFallbackAt = now;
  g_nextHeapCheckAt = now + cfg::kHeapCheckIntervalMs;
  g_nextHeapLogAt = now + cfg::kHeapLogIntervalMs;
}

void loop() {
  g_platform.feedWatchdog();
  const uint32_t now = millis();

  handleButton(now);
  g_wifi.loop(now);
  handlePortal(now);
  handleClock(now);
  handleSampling(now);
  handleUpload(now);
  handleOta(now);
  handleMaintenance(now);

  auhono::LedInputs led;
  led.hasIdentity = g_identity.valid;
  led.wipeArmed = g_button.wipeArmed();
  led.portalActive = g_portal.active();
  led.wifiConnected = g_wifi.connected();
  led.wifiFail = g_wifi.lastFail();
  led.sensorFault = g_health.faulty();
  led.upload = g_uploadStatus;
  g_led.update(now, led);

  delay(10);  // nhường CPU cho tác vụ Wi-Fi/lwIP
}
