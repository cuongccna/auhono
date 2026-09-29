// Cài đặt các giao diện của auhono_core bằng API ESP32/Arduino.
#pragma once
#include <Arduino.h>

#include <string>

#include "auhono/backoff.h"
#include "auhono/crypto_iface.h"
#include "auhono/device_client.h"
#include "auhono/seq_counter.h"

/// SHA-256 / HMAC-SHA256 bằng mbedtls có sẵn trong core Arduino.
class MbedCrypto : public auhono::ICrypto {
 public:
  void sha256(const uint8_t* data, size_t len, uint8_t out[32]) override;
  void hmacSha256(const uint8_t* key, size_t keyLen, const uint8_t* msg, size_t msgLen, uint8_t out[32]) override;
};

class EspRandom : public auhono::IRandom {
 public:
  uint32_t next() override;  // esp_random(): phần cứng, dùng RF khi Wi-Fi bật
};

/// millis, đồng hồ (NTP/server), watchdog.
class EspPlatform : public auhono::IPlatform {
 public:
  /// Đăng ký callback SNTP và cấu hình watchdog. Gọi một lần ở setup().
  void begin();
  /// Bắt đầu đồng bộ NTP (gọi khi đã có Wi-Fi; gọi lại nhiều lần vô hại).
  void startNtp();
  bool ntpStarted() const { return ntpStarted_; }

  uint32_t millis() override { return ::millis(); }
  uint32_t unixNow() override;
  bool clockTrusted() override { return trusted_; }
  void setUnix(uint32_t t) override;
  void feedWatchdog() override;

  // Được gọi từ callback SNTP (task khác) nên là volatile.
  void onNtpSynced();

 private:
  volatile bool trusted_ = false;
  bool ntpStarted_ = false;
};

/// Lưu trần seq bền vững trong NVS (namespace "auh", khóa "seq").
class NvsSeqStore : public auhono::ISeqStore {
 public:
  bool load(uint64_t& value) override;
  bool save(uint64_t value) override;
};

/// HTTPS tới AUHONO_SERVER_URL: xác thực chứng chỉ máy chủ bằng bộ CA gốc nhúng sẵn (certs/roots.pem).
/// Mỗi request một kết nối mới (5 phút/lần, không đáng giữ socket) và giới hạn kích thước phản hồi.
class HttpsTransport : public auhono::IHttp {
 public:
  auhono::HttpResponse perform(const auhono::HttpRequest& req) override;
};

/// Bộ CA gốc dạng PEM đã nhúng (kết thúc bằng '\0'); dùng chung cho API và tải OTA.
const char* embeddedRootCAs();
