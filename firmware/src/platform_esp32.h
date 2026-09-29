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

/// Nguồn ngẫu nhiên phần cứng (chỉ là ngẫu nhiên THẬT khi Wi-Fi/BT đang bật; bọc bằng auhono::MixedRandom để rải
/// nhịp giữa các máy ngay từ lúc khởi động).
class EspRandom : public auhono::IRandom {
 public:
  uint32_t next() override;
};

/// millis, giờ đơn điệu, đồng hồ (NTP/server), watchdog.
class EspPlatform : public auhono::IPlatform {
 public:
  /// Đăng ký callback SNTP và cấu hình watchdog. Gọi một lần ở setup().
  void begin();
  /// Bắt đầu đồng bộ NTP (gọi khi đã có Wi-Fi; gọi lại nhiều lần vô hại).
  void startNtp();
  bool ntpStarted() const { return ntpStarted_; }

  uint32_t millis() override { return ::millis(); }
  uint32_t monoSeconds() override;
  uint32_t unixNow() override;
  bool clockTrusted() override { return trusted_; }
  void setUnix(uint32_t t) override;
  void feedWatchdog() override;

  // Được gọi từ callback SNTP (task khác) nên trạng thái là volatile.
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
/// Mỗi request một kết nối mới (5 phút/lần, không đáng giữ socket), giới hạn kích thước phản hồi, KHÔNG theo chuyển hướng
/// (không bao giờ gửi chữ ký sang máy chủ khác), và từ chối mở TLS khi heap không đủ (auhono::tlsHeapOk).
class HttpsTransport : public auhono::IHttp {
 public:
  auhono::HttpResponse perform(const auhono::HttpRequest& req) override;

  /// Chế độ cứu hộ OTA: không xác thực chứng chỉ (xem tls_util.h). Chỉ bật quanh việc kiểm tra + tải OTA.
  void setInsecureRescue(bool on) { insecureRescue_ = on; }
  /// Lần perform gần nhất bị bỏ vì heap không đủ mở TLS? (đọc rồi xóa)
  bool takeHeapLow() { const bool v = heapLow_; heapLow_ = false; return v; }

 private:
  bool insecureRescue_ = false;
  bool heapLow_ = false;
};

/// Bộ CA gốc dạng PEM đã nhúng (kết thúc bằng '\0'); dùng chung cho API và tải OTA.
const char* embeddedRootCAs();
