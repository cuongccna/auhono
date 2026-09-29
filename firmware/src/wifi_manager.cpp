#include "wifi_manager.h"

#include <WiFi.h>

void WifiManager::begin(const WifiCreds& creds, uint32_t nowMs) {
  creds_ = creds;
  active_ = creds.present();
  connected_ = false;
  downSince_ = nowMs;
  backoff_.reset();
  if (!active_) return;

  WiFi.persistent(false);       // không để thư viện Wi-Fi ghi flash mỗi lần kết nối
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);  // tầng thấp tự nối lại khi rớt; backoff bên dưới là lưới an toàn
  WiFi.begin(creds_.ssid.c_str(), creds_.password.empty() ? nullptr : creds_.password.c_str());
  nextAttemptAt_ = nowMs + backoff_.nextDelayMs();
}

void WifiManager::stop() {
  active_ = false;
  connected_ = false;
  WiFi.setAutoReconnect(false);  // cổng cấu hình dùng STA chỉ để quét, không được tự nối
  WiFi.disconnect(false);
}

void WifiManager::loop(uint32_t nowMs) {
  if (!active_) return;
  const bool up = WiFi.status() == WL_CONNECTED;

  if (up) {
    if (!connected_) backoff_.reset();
    connected_ = true;
    return;
  }
  if (connected_) {  // vừa rớt mạng
    connected_ = false;
    downSince_ = nowMs;
    nextAttemptAt_ = nowMs + backoff_.nextDelayMs();
  }
  // Chưa nối được sau một khoảng backoff: chủ động thử lại (30 s -> 1 -> 2 -> 5 phút, ±20%).
  if (static_cast<int32_t>(nowMs - nextAttemptAt_) >= 0) {
    WiFi.disconnect(false);
    WiFi.begin(creds_.ssid.c_str(), creds_.password.empty() ? nullptr : creds_.password.c_str());
    nextAttemptAt_ = nowMs + backoff_.nextDelayMs();
  }
}

uint32_t WifiManager::disconnectedForMs(uint32_t nowMs) const {
  if (!active_ || connected_) return 0;
  return nowMs - downSince_;
}
