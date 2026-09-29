// Cấu hình TLS dùng chung cho mọi kết nối HTTPS của thiết bị (API và tải OTA).
#pragma once
#include <WiFiClientSecure.h>

const char* embeddedRootCAs();

/// Bật xác thực chứng chỉ máy chủ theo bộ CA gốc nhúng sẵn (certs/roots.pem).
/// Chỉ khi biên dịch với -DALLOW_INSECURE_TLS (dev, mặc định TẮT) mới bỏ qua xác thực.
/// Lưu ý: core Arduino-ESP32 2.0.x không kiểm tra HẠN chứng chỉ (mbedtls không bật HAVE_TIME_DATE),
/// nhưng vẫn kiểm chuỗi tin cậy, tên miền và chữ ký.
inline void configureTls(WiFiClientSecure& client) {
#ifdef ALLOW_INSECURE_TLS
#warning "ALLOW_INSECURE_TLS bat: KHONG xac thuc chung chi may chu. Chi dung khi phat trien!"
  client.setInsecure();
#else
  client.setCACert(embeddedRootCAs());
#endif
}
