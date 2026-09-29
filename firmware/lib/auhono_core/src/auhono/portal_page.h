// Trang HTML của cổng cấu hình + các hàm dựng phản hồi HTTP. Thuần túy (không phần cứng) nên test được XSS/escape
// trực tiếp trên HTML sinh ra.
//
// Quy tắc an toàn: KHÔNG có JavaScript; mọi chuỗi động (SSID quét được, giá trị người dùng nhập, mã thiết bị) đều
// qua htmlEscape; SSID trong <option value> là hex; CSP chặn mọi thứ ngoài CSS nội tuyến.
#pragma once
#include <string>
#include <vector>

#include "auhono/wifi_policy.h"

namespace auhono {

struct PortalNetwork {
  std::string ssid;  // byte thô như router phát
  int rssi = 0;
};

struct PortalView {
  std::string deviceId;      // rỗng nếu chưa nạp danh tính
  std::string fwVersion;
  bool scanning = false;
  std::vector<PortalNetwork> networks;
  std::string errorText;     // lỗi nhập liệu (tiếng Việt, đã đứng sẵn), rỗng nếu không
  std::string typedSsid;     // giữ lại giá trị đã gõ khi form bị từ chối (KHÔNG giữ mật khẩu)
  std::string csrfToken;     // token phiên của cổng (hex)
  // Trạng thái kết nối Wi-Fi đã lưu (cho chủ quán biết tại sao chưa lên mạng):
  std::string savedSsid;     // rỗng nếu chưa lưu mạng nào
  bool wifiConnected = false;
  WifiFail wifiFail = WifiFail::None;
};

/// Trang cấu hình chính.
std::string renderPortalPage(const PortalView& v);
/// Trang "Đã lưu".
std::string renderSavedPage(const std::string& ssid);
/// Thông điệp trạng thái Wi-Fi bằng tiếng Việt (chưa escape). Rỗng nếu không có gì để nói.
std::string wifiStatusMessage(const PortalView& v);

/// Toàn bộ phản hồi HTTP (dòng trạng thái + header + body). `html` được gửi với CSP nghiêm ngặt.
std::string buildPageResponse(int status, const std::string& html, bool headOnly = false);
/// Chuyển hướng 302 tới `location` (dùng cho mọi đường dẫn "thăm dò mạng" của Android/iOS/Windows).
std::string buildRedirectResponse(const std::string& location);
/// Phản hồi lỗi văn bản thuần (400/413/414/431/501/...).
std::string buildErrorResponse(int status);

}  // namespace auhono
