// Cấu hình TLS dùng chung cho mọi kết nối HTTPS của thiết bị (API và tải OTA).
#pragma once
#include <WiFiClientSecure.h>

const char* embeddedRootCAs();

/// Bật xác thực chứng chỉ máy chủ theo bộ CA gốc nhúng sẵn (certs/roots.pem).
///
/// `insecureRescue`: CHỈ dùng cho "OTA cứu hộ" (maintenance.h: TlsRescue) khi chuỗi chứng chỉ của server không còn khớp
/// bộ CA nhúng nhiều giờ liền — cách duy nhất để một firmware cũ nhận bộ CA mới là OTA. An toàn vì ảnh firmware được xác thực
/// bằng chữ ký ECDSA ĐỘC LẬP với TLS (và chỉ nhận phiên bản mới hơn); tuyệt đối không dùng cho việc gửi số đo.
///
/// Chỉ khi biên dịch với -DALLOW_INSECURE_TLS (dev, mặc định TẮT) mới bỏ qua xác thực ở MỌI kết nối.
/// Lưu ý: core Arduino-ESP32 2.0.x không kiểm tra HẠN chứng chỉ (CONFIG_MBEDTLS_HAVE_TIME_DATE tắt),
/// nhưng vẫn kiểm chuỗi tin cậy, tên miền và chữ ký. Nhờ vậy TLS cũng chạy được khi chưa có giờ.
inline void configureTls(WiFiClientSecure& client, bool insecureRescue = false) {
#ifdef ALLOW_INSECURE_TLS
#warning "ALLOW_INSECURE_TLS bat: KHONG xac thuc chung chi may chu. Chi dung khi phat trien!"
  (void)insecureRescue;
  client.setInsecure();
#else
  if (insecureRescue) client.setInsecure();
  else client.setCACert(embeddedRootCAs());
#endif
}
