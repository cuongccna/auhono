#include "wifi_manager.h"

#include <WiFi.h>

#include "auhono/time_policy.h"
#include "config.h"

namespace {

// Ghi từ tác vụ sự kiện của Arduino, đọc từ loop(): chỉ là một byte + một bộ đếm (ghi nguyên tử trên RISC-V 32 bit).
volatile uint8_t s_lastReason = 0;
volatile uint32_t s_eventSeq = 0;
bool s_eventsRegistered = false;
bool s_lowPower = false;

void onStaDisconnected(arduino_event_id_t, arduino_event_info_t info) {
  s_lastReason = info.wifi_sta_disconnected.reason;
  s_eventSeq = s_eventSeq + 1;
}

void applyTxPower() {
  // Phải gọi SAU khi driver Wi-Fi đã chạy (sau WiFi.begin). Có thể giảm công suất bằng -DAUHONO_WIFI_TX_POWER=WIFI_POWER_11dBm
  // (giảm dòng đỉnh khi cục sạc yếu gây brownout) — đổi lại tầm phủ sóng ngắn hơn.
  if (s_lowPower) {
    WiFi.setTxPower(WIFI_POWER_8_5dBm);
    return;
  }
#ifdef AUHONO_WIFI_TX_POWER
  WiFi.setTxPower(AUHONO_WIFI_TX_POWER);
#endif
}

}  // namespace

void WifiManager::setLowPower(bool low) { s_lowPower = low; }

void WifiManager::begin(const auhono::WifiCreds& creds, uint32_t nowMs) {
  creds_ = creds;
  active_ = creds.present();
  connected_ = false;
  lastFail_ = auhono::WifiFail::None;
  failSince_ = 0;
  downSince_ = nowMs;
  backoff_.reset();
  seenEventSeq_ = s_eventSeq;
  if (!active_) return;

  if (!s_eventsRegistered) {
    WiFi.onEvent(onStaDisconnected, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
    s_eventsRegistered = true;
  }
  WiFi.persistent(false);       // PHẢI trước lần khởi tạo Wi-Fi đầu tiên: không để thư viện ghi flash mỗi lần kết nối
  WiFi.setAutoReconnect(false); // nhịp thử do ta điều khiển (backoff bên dưới)
  WiFi.begin(creds_.ssid.c_str(), creds_.password.empty() ? nullptr : creds_.password.c_str());  // giữ nguyên AP nếu đang mở
  applyTxPower();
  nextAttemptAt_ = nowMs + backoff_.nextDelayMs();
}

void WifiManager::stop() {
  active_ = false;
  connected_ = false;
  if (WiFi.getMode() & WIFI_MODE_STA) WiFi.disconnect(false);
}

void WifiManager::consumeEvents(uint32_t nowMs) {
  const uint32_t seq = s_eventSeq;
  if (seq == seenEventSeq_) return;
  seenEventSeq_ = seq;
  const auhono::WifiFail f = auhono::classifyDisconnectReason(s_lastReason);
  if (f == auhono::WifiFail::None) return;  // ASSOC_LEAVE do chính ta ngắt: không ghi đè lý do thật trước đó
  if (f != lastFail_) { lastFail_ = f; failSince_ = nowMs ? nowMs : 1; }  // 0 = chưa có
}

void WifiManager::loop(uint32_t nowMs) {
  if (!active_) return;
  consumeEvents(nowMs);

  const bool up = WiFi.status() == WL_CONNECTED;  // = đã có IP (không chỉ đã kết hợp với AP)
  if (up) {
    if (!connected_) {
      backoff_.reset();
      lastFail_ = auhono::WifiFail::None;
      failSince_ = 0;
      Serial.printf("[wifi] da ket noi, RSSI %d dBm\n", static_cast<int>(WiFi.RSSI()));
    }
    connected_ = true;
    return;
  }

  if (connected_) {  // vừa rớt mạng (mất IP/DHCP hết hạn/router tắt): thử lại sớm, rồi mới tăng dần
    connected_ = false;
    downSince_ = nowMs;
    backoff_.reset();
    nextAttemptAt_ = nowMs + 3000;
    Serial.println("[wifi] mat ket noi");
  }
  if (holdOff_) return;
  if (auhono::reached(nowMs, nextAttemptAt_)) attempt(nowMs);
}

void WifiManager::attempt(uint32_t nowMs) {
  // Cùng cách Arduino tự làm khi nối lại: disconnect() rồi begin(). Sự kiện ASSOC_LEAVE (8) do disconnect() sinh ra được bỏ qua.
  WiFi.disconnect(false);
  WiFi.begin(creds_.ssid.c_str(), creds_.password.empty() ? nullptr : creds_.password.c_str());
  applyTxPower();
  nextAttemptAt_ = nowMs + backoff_.nextDelayMs();
}

void WifiManager::forceReconnect(uint32_t nowMs) {
  if (!active_) return;
  Serial.println("[wifi] nut lai ket noi");
  connected_ = false;
  downSince_ = nowMs;
  WiFi.disconnect(false);
  backoff_.reset();
  nextAttemptAt_ = nowMs + 500;
}

void WifiManager::restartDriver(uint32_t nowMs) {
  if (!active_) return;
  if (WiFi.getMode() & WIFI_MODE_AP) { forceReconnect(nowMs); return; }  // đang có người cấu hình: đừng tắt sóng
  Serial.println("[wifi] khoi dong lai driver Wi-Fi");
  connected_ = false;
  downSince_ = nowMs;
  WiFi.disconnect(true);   // tắt STA => hạ driver
  delay(200);
  WiFi.mode(WIFI_OFF);
  delay(200);
  backoff_.reset();
  nextAttemptAt_ = nowMs + 500;  // attempt() -> WiFi.begin() sẽ bật lại STA
}

uint32_t WifiManager::disconnectedForMs(uint32_t nowMs) const {
  if (!active_ || connected_) return 0;
  return static_cast<uint32_t>(nowMs - downSince_);
}

uint32_t WifiManager::failStableMs(uint32_t nowMs) const {
  if (!active_ || connected_ || lastFail_ == auhono::WifiFail::None || failSince_ == 0) return 0;
  return static_cast<uint32_t>(nowMs - failSince_);
}

void WifiManager::resetDisconnectTimer(uint32_t nowMs) {
  downSince_ = nowMs;
  if (lastFail_ != auhono::WifiFail::None) failSince_ = nowMs ? nowMs : 1;
}
