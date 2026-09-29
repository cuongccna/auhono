// Cổng cấu hình Wi-Fi (captive portal): thiết bị phát Wi-Fi mở "Auhono-XXXX", điện thoại tự bật
// trang cấu hình. Chủ quán chọn Wi-Fi của quán và nhập mật khẩu; lưu vào NVS.
//
// An toàn: không có JavaScript; mọi chuỗi động đều qua htmlEscape; giới hạn độ dài đầu vào;
// CSP chặn mọi tài nguyên ngoài; tối đa 4 điện thoại kết nối; tự đóng sau kPortalTimeoutMs.
#pragma once
#include <stdint.h>

#include <string>
#include <vector>

#include "storage.h"

class Portal {
 public:
  /// Mở AP + DNS + web server. `deviceId` hiển thị trên trang (đã escape); rỗng nếu chưa nạp danh tính.
  void start(const std::string& deviceId, uint32_t nowMs);
  void stop();
  bool active() const { return active_; }

  /// Gọi trong loop() khi active().
  void loop(uint32_t nowMs);

  /// Người dùng đã gửi form hợp lệ? Nếu có: trả thông tin mạng (một lần) — main lưu NVS và kết nối.
  /// Đợi ~2 s sau khi trả trang "Đã lưu" để điện thoại kịp nhận trang trước khi AP tắt.
  bool takeSaved(WifiCreds& out, uint32_t nowMs);

  bool timedOut(uint32_t nowMs, uint32_t timeoutMs) const {
    return active_ && static_cast<uint32_t>(nowMs - startedAt_) >= timeoutMs;
  }

 private:
  struct Network {
    std::string ssid;
    int rssi;
  };

  void handleRoot();
  void handleSave();
  void handleRescan();
  void handleRedirect();
  void sendPage(int code, const std::string& html);
  std::string renderForm(const std::string& errorText, const std::string& typedSsid) const;
  void pollScan();

  bool active_ = false;
  uint32_t startedAt_ = 0;
  std::string deviceId_;
  std::vector<Network> networks_;
  bool scanning_ = false;

  bool saved_ = false;
  uint32_t savedAt_ = 0;
  WifiCreds pending_;
};
