// Định tuyến của cổng cấu hình (captive portal).
//
// Điện thoại/máy tính "thăm dò" xem có Internet không bằng cách tải một URL cố định:
//   Android:  connectivitycheck.gstatic.com/generate_204, /gen_204   (mong đợi HTTP 204)
//   iOS/macOS: captive.apple.com/hotspot-detect.html, /library/test/success.html (mong đợi "Success")
//   Windows:  www.msftconnecttest.com/connecttest.txt, /ncsi.txt, /redirect
//   Firefox:  detectportal.firefox.com/success.txt ; Linux NM: nmcheck.gnome.org/check_network_status.txt
// Nhờ DNS "bắt mọi tên" các tên miền đó trỏ về thiết bị. Nhận được phản hồi KHÁC kỳ vọng (ở đây: 302 về trang cấu hình)
// thì hệ điều hành hiện thông báo "Đăng nhập vào mạng Wi-Fi" và mở trang cấu hình. Vì vậy: mọi yêu cầu có Host không
// phải IP của thiết bị, hoặc đường dẫn lạ, đều được 302 về http://<IP>/ (KHÔNG BAO GIỜ trả "Success"/204 giả).
#pragma once
#include <string>

#include "auhono/http_request.h"

namespace auhono {

enum class PortalRoute : unsigned char {
  Form,      // GET/HEAD /
  Save,      // POST /save
  Rescan,    // GET /rescan
  Redirect,  // mọi thứ khác -> 302 về trang cấu hình
};

/// Host là chính thiết bị? ("192.168.4.1" hoặc "192.168.4.1:80", không phân biệt hoa thường).
bool isPortalHost(const std::string& host, const std::string& apIp);

PortalRoute routeRequest(HttpMethod method, const std::string& path, const std::string& host, const std::string& apIp);

/// Đường dẫn thăm dò mạng đã biết (để tài liệu/test; định tuyến vẫn chuyển hướng cả đường dẫn chưa biết).
bool isCaptiveProbePath(const std::string& path);

}  // namespace auhono
