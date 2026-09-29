#include "auhono/portal_page.h"

#include "auhono/portal_form.h"

namespace auhono {

namespace {

const char kHead[] =
    "<!doctype html><html lang=\"vi\"><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    "<title>Cài đặt Auhono</title><style>"
    "body{font-family:system-ui,sans-serif;margin:0;background:#f4f6f8;color:#1c2833}"
    "main{max-width:26rem;margin:0 auto;padding:1rem}"
    "h1{font-size:1.3rem;margin:.5rem 0}"
    "p,li{line-height:1.45}"
    "label{display:block;margin:.9rem 0 .25rem;font-weight:600}"
    "input,select,button{width:100%;box-sizing:border-box;font-size:1rem;padding:.7rem;border:1px solid #9aa5b1;border-radius:.5rem;background:#fff}"
    "button{background:#0b6bcb;color:#fff;border:0;margin-top:1.2rem;font-weight:600}"
    "a.btn{display:block;text-align:center;margin-top:.8rem;color:#0b6bcb}"
    ".note{background:#fff8e1;border:1px solid #f0d78c;border-radius:.5rem;padding:.6rem .8rem;font-size:.92rem}"
    ".err{background:#fdecea;border:1px solid #f5a9a3;border-radius:.5rem;padding:.6rem .8rem;color:#8a1c12}"
    ".ok{background:#e8f5e9;border:1px solid #a5d6a7;border-radius:.5rem;padding:.6rem .8rem;color:#1b5e20}"
    ".id{color:#5f6b7a;font-size:.9rem}"
    "</style>";

const char kFoot[] = "</main></body></html>";

const char* reasonPhrase(int code) {
  switch (code) {
    case 200: return "OK";
    case 302: return "Found";
    case 303: return "See Other";
    case 400: return "Bad Request";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 408: return "Request Timeout";
    case 413: return "Payload Too Large";
    case 414: return "URI Too Long";
    case 431: return "Request Header Fields Too Large";
    case 501: return "Not Implemented";
    case 503: return "Service Unavailable";
    default:  return "Error";
  }
}

std::string statusLine(int code) {
  return "HTTP/1.1 " + std::to_string(code) + " " + reasonPhrase(code) + "\r\n";
}

const char kCommonHeaders[] =
    "Connection: close\r\n"
    "Cache-Control: no-store\r\n"
    "X-Content-Type-Options: nosniff\r\n"
    "Referrer-Policy: no-referrer\r\n";

}  // namespace

std::string wifiStatusMessage(const PortalView& v) {
  if (v.savedSsid.empty()) return std::string();
  const std::string name = sanitizeUtf8(v.savedSsid);
  if (v.wifiConnected) return "Thiết bị đang kết nối tốt với Wi-Fi \"" + name + "\".";
  switch (v.wifiFail) {
    case WifiFail::NoApFound:
      return "Không tìm thấy Wi-Fi \"" + name + "\". Kiểm tra tên Wi-Fi, modem đã bật chưa, và Wi-Fi phải ở băng tần 2.4 GHz "
             "(thiết bị KHÔNG dùng được Wi-Fi 5 GHz).";
    case WifiFail::AuthFailed:
      return "Thấy Wi-Fi \"" + name + "\" nhưng kết nối bị từ chối: có thể đã đổi/sai mật khẩu. Hãy nhập lại mật khẩu bên dưới.";
    case WifiFail::Other:
    case WifiFail::None:
      return "Thiết bị đang thử kết nối Wi-Fi \"" + name + "\"...";
  }
  return std::string();
}

std::string renderPortalPage(const PortalView& v) {
  std::string h = kHead;
  if (v.scanning) h += "<meta http-equiv=\"refresh\" content=\"4\">";  // tự tải lại trong lúc quét
  h += "</head><body><main><h1>Cài đặt Wi-Fi cho Auhono</h1>";
  h += "<p class=\"id\">Mã thiết bị: <b>" + htmlEscape(v.deviceId.empty() ? std::string("chưa nạp") : v.deviceId) +
       "</b> &middot; phiên bản " + htmlEscape(v.fwVersion) + "</p>";

  const std::string status = wifiStatusMessage(v);
  if (!status.empty()) h += std::string("<p class=\"") + (v.wifiConnected ? "ok" : "note") + "\">" + htmlEscape(status) + "</p>";

  h += "<p class=\"note\">Thiết bị chỉ dùng Wi-Fi <b>2.4 GHz</b>. Nếu không thấy Wi-Fi của quán trong danh sách, "
       "hãy bật băng tần 2.4 GHz trên modem (không dùng tên mạng chỉ có 5 GHz). Nếu điện thoại báo \"Wi-Fi không có Internet\", "
       "hãy chọn giữ kết nối.</p>";
  if (!v.errorText.empty()) h += "<p class=\"err\">" + htmlEscape(v.errorText) + "</p>";

  h += "<form method=\"post\" action=\"/save\" autocomplete=\"off\">";
  h += "<input type=\"hidden\" name=\"t\" value=\"" + htmlEscape(v.csrfToken) + "\">";
  h += "<label for=\"pick\">Chọn Wi-Fi của quán</label><select id=\"pick\" name=\"pick\">";
  if (v.scanning) {
    h += "<option value=\"\">Đang quét...</option>";
  } else {
    h += "<option value=\"\">-- chọn Wi-Fi --</option>";
    for (const PortalNetwork& n : v.networks) {
      h += "<option value=\"" + ssidToken(n.ssid) + "\">" + htmlEscape(sanitizeUtf8(n.ssid)) + " (" + std::to_string(n.rssi) +
           " dBm)</option>";
    }
  }
  h += "</select><a class=\"btn\" href=\"/rescan\">Quét lại</a>";
  h += "<label for=\"ssid\">Hoặc nhập tên Wi-Fi (mạng ẩn)</label>"
       "<input id=\"ssid\" name=\"ssid\" value=\"" + htmlEscape(sanitizeUtf8(v.typedSsid)) + "\" autocapitalize=\"off\">";
  h += "<label for=\"pass\">Mật khẩu Wi-Fi</label>"
       "<input id=\"pass\" name=\"pass\" type=\"password\" maxlength=\"63\" autocapitalize=\"off\">";
  h += "<button type=\"submit\">Lưu và kết nối</button></form>";
  h += kFoot;
  return h;
}

std::string renderSavedPage(const std::string& ssid) {
  std::string h = kHead;
  h += "</head><body><main><h1>Đã lưu</h1><p>Thiết bị đang kết nối tới Wi-Fi <b>" + htmlEscape(sanitizeUtf8(ssid)) +
       "</b>. Wi-Fi \"Auhono\" sẽ tắt trong giây lát.</p>"
       "<p>Đèn sáng liên tục nghĩa là đã kết nối thành công. Nếu đèn nháy chậm quá 2 phút, "
       "hãy kiểm tra lại mật khẩu: giữ nút trên thiết bị 5 giây để mở lại trang này.</p>";
  h += kFoot;
  return h;
}

std::string buildPageResponse(int status, const std::string& html, bool headOnly) {
  std::string r = statusLine(status);
  r += "Content-Type: text/html; charset=utf-8\r\n";
  r += "Content-Length: " + std::to_string(html.size()) + "\r\n";
  r += kCommonHeaders;
  // Không JS, không tài nguyên ngoài, form chỉ gửi về chính nó, không cho nhúng khung.
  r += "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'\r\n";
  r += "\r\n";
  if (!headOnly) r += html;
  return r;
}

std::string buildRedirectResponse(const std::string& location) {
  static const char kBody[] = "Auhono: mo trang cai dat Wi-Fi.";
  std::string r = statusLine(302);
  r += "Location: " + location + "\r\n";
  r += "Content-Type: text/plain\r\n";
  r += "Content-Length: " + std::to_string(sizeof kBody - 1) + "\r\n";
  r += kCommonHeaders;
  r += "\r\n";
  r += kBody;
  return r;
}

std::string buildErrorResponse(int status) {
  const std::string body = std::to_string(status) + " " + reasonPhrase(status) + "\n";
  std::string r = statusLine(status);
  r += "Content-Type: text/plain\r\n";
  r += "Content-Length: " + std::to_string(body.size()) + "\r\n";
  r += kCommonHeaders;
  r += "\r\n";
  r += body;
  return r;
}

}  // namespace auhono
