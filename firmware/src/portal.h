// Cổng cấu hình Wi-Fi (captive portal): thiết bị phát Wi-Fi mở "Auhono-XXXX", điện thoại tự bật trang cấu hình.
// Chủ quán chọn Wi-Fi của quán và nhập mật khẩu; lưu NVS (main.cpp).
//
// An toàn (xem lib/auhono_core: http_request, url_form, dns_reply, portal_page):
//  - KHÔNG dùng WebServer/DNSServer của Arduino (không giới hạn kích thước, đọc chặn, DNSServer tràn bộ đệm với gói dị dạng);
//    bộ phân tích HTTP/DNS tự viết, mọi kích thước bị chặn, thuần C++ đã fuzz trên máy;
//  - AP là WPA2-PSK, mật khẩu suy ra từ khóa thiết bị (in trên tem/QR); người đứng gần không đổi được Wi-Fi của thiết bị;
//  - máy chủ chỉ lắng nghe trên IP của AP (192.168.4.1), KHÔNG lộ ra mạng LAN của quán khi STA đang nối;
//  - mỗi kết nối phải xong trong kPortalRequestDeadlineMs (chống slowloris), tối đa kPortalMaxClients kết nối cùng lúc,
//    tối đa 4 điện thoại vào AP; không JavaScript, mọi chuỗi động đều escape, CSP nghiêm ngặt, token chống gửi chéo trang;
//  - không bao giờ chặn vòng lặp chính lâu (đọc từng đoạn nhỏ, quét Wi-Fi không đồng bộ).
#pragma once
#include <stdint.h>

#include <string>

#include "auhono/wifi_creds.h"
#include "auhono/wifi_policy.h"

class Portal {
 public:
  /// Mở AP WPA2-PSK + DNS + HTTP. `apPassword`: 8..63 ký tự (auhono::deriveApPassword); KHÔNG bao giờ được in ra log/trang.
  /// Mật khẩu rỗng/sai chuẩn => từ chối mở AP (không bao giờ mở Wi-Fi mở), trừ khi biên dịch với -DALLOW_OPEN_AP (chỉ để phát triển).
  /// `byUser`: do người dùng giữ nút (không tự đóng khi Wi-Fi nối lại). false nếu không mở được AP.
  bool start(const std::string& deviceId, const std::string& apPassword, const std::string& fwVersion, uint32_t nowMs, bool byUser);
  void stop();
  bool active() const { return impl_ != nullptr; }

  /// Gọi trong loop() khi active().
  void loop(uint32_t nowMs);

  /// Người dùng đã gửi form hợp lệ? Nếu có: trả thông tin mạng (một lần) — main lưu NVS và kết nối.
  /// Đợi ~2 s sau khi trả trang "Đã lưu" để điện thoại kịp nhận trang trước khi AP tắt.
  bool takeSaved(auhono::WifiCreds& out, uint32_t nowMs);

  /// Trạng thái Wi-Fi đã lưu để hiển thị trên trang (vì sao chưa nối được).
  void setStatus(const std::string& savedSsid, bool connected, auhono::WifiFail fail);

  bool byUser() const;
  uint8_t stationCount() const;   // số điện thoại đang kết nối vào AP
  bool scanning() const;
  /// Không ai dùng > kPortalIdleTimeoutMs, hoặc mở quá kPortalHardCapMs.
  bool idleTimedOut(uint32_t nowMs) const;
  void touch(uint32_t nowMs);     // coi như vừa có hoạt động (dùng khi chưa có Wi-Fi lưu: cổng không bao giờ tự đóng)

 private:
  struct Impl;
  Impl* impl_ = nullptr;
};
