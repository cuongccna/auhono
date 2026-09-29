#include "portal.h"

#include <DNSServer.h>
#include <WebServer.h>
#include <WiFi.h>

#include <algorithm>

#include "auhono/portal_form.h"
#include "config.h"

namespace {

WebServer* g_server = nullptr;
DNSServer* g_dns = nullptr;

constexpr size_t kMaxNetworks = 20;
constexpr uint32_t kSavedGraceMs = 2000;

// Trang dùng CSS nội tuyến, không JavaScript. CSP bên dưới chặn mọi thứ ngoài ra.
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
    ".id{color:#5f6b7a;font-size:.9rem}"
    "</style>";

const char kFoot[] = "</main></body></html>";

}  // namespace

void Portal::start(const std::string& deviceId, uint32_t nowMs) {
  if (active_) return;
  deviceId_ = deviceId;
  startedAt_ = nowMs;
  saved_ = false;
  networks_.clear();

  // AP + STA: STA chỉ dùng để quét Wi-Fi xung quanh.
  WiFi.persistent(false);
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(auhono::apSsid(deviceId_).c_str(), nullptr, 1, 0, 4);  // mở, kênh 1, tối đa 4 máy
  delay(100);

  g_dns = new DNSServer();
  g_dns->start(53, "*", WiFi.softAPIP());  // mọi tên miền -> chính thiết bị (captive portal)

  g_server = new WebServer(80);
  g_server->on("/", HTTP_GET, [this]() { handleRoot(); });
  g_server->on("/save", HTTP_POST, [this]() { handleSave(); });
  g_server->on("/rescan", HTTP_GET, [this]() { handleRescan(); });
  g_server->onNotFound([this]() { handleRedirect(); });  // /generate_204, /hotspot-detect.html, ...
  g_server->begin();

  WiFi.scanNetworks(true);  // quét không chặn; kết quả lấy ở pollScan()
  scanning_ = true;
  active_ = true;
}

void Portal::stop() {
  if (!active_) return;
  if (g_server) { g_server->stop(); delete g_server; g_server = nullptr; }
  if (g_dns) { g_dns->stop(); delete g_dns; g_dns = nullptr; }
  WiFi.scanDelete();
  WiFi.softAPdisconnect(true);
  scanning_ = false;
  active_ = false;
}

void Portal::loop(uint32_t) {
  if (!active_) return;
  g_dns->processNextRequest();
  g_server->handleClient();
  pollScan();
}

void Portal::pollScan() {
  if (!scanning_) return;
  const int n = WiFi.scanComplete();
  if (n == WIFI_SCAN_RUNNING) return;
  scanning_ = false;
  networks_.clear();
  if (n > 0) {
    for (int i = 0; i < n && networks_.size() < kMaxNetworks * 2; i++) {
      std::string ssid = WiFi.SSID(i).c_str();
      if (auhono::validateSsid(ssid) != auhono::FormError::None) continue;  // bỏ tên rỗng/ẩn/lạ
      networks_.push_back({ssid, WiFi.RSSI(i)});
    }
    // Mạnh nhất trước; bỏ trùng tên (nhiều băng/bộ phát cùng SSID).
    std::sort(networks_.begin(), networks_.end(), [](const Network& a, const Network& b) { return a.rssi > b.rssi; });
    std::vector<Network> unique;
    for (const Network& net : networks_) {
      const bool dup = std::any_of(unique.begin(), unique.end(), [&](const Network& u) { return u.ssid == net.ssid; });
      if (!dup && unique.size() < kMaxNetworks) unique.push_back(net);
    }
    networks_.swap(unique);
  }
  WiFi.scanDelete();
}

std::string Portal::renderForm(const std::string& errorText, const std::string& typedSsid) const {
  using auhono::htmlEscape;
  std::string h = kHead;
  if (scanning_) h += "<meta http-equiv=\"refresh\" content=\"4\">";  // tự tải lại trong lúc quét
  h += "</head><body><main><h1>Cài đặt Wi-Fi cho Auhono</h1>";
  h += "<p class=\"id\">Mã thiết bị: <b>" + htmlEscape(deviceId_.empty() ? "chưa nạp" : deviceId_) + "</b> &middot; phiên bản " +
       htmlEscape(AUHONO_FW_VERSION) + "</p>";
  h += "<p class=\"note\">Thiết bị chỉ dùng Wi-Fi <b>2.4 GHz</b>. Nếu không thấy Wi-Fi của quán trong danh sách, "
       "hãy bật băng tần 2.4 GHz trên modem (không dùng tên mạng chỉ có 5 GHz).</p>";
  if (!errorText.empty()) h += "<p class=\"err\">" + htmlEscape(errorText) + "</p>";

  h += "<form method=\"post\" action=\"/save\" autocomplete=\"off\">";
  h += "<label for=\"pick\">Chọn Wi-Fi của quán</label><select id=\"pick\" name=\"pick\">";
  if (scanning_) {
    h += "<option value=\"\">Đang quét...</option>";
  } else {
    h += "<option value=\"\">-- chọn Wi-Fi --</option>";
    for (const Network& n : networks_) {
      h += "<option value=\"" + htmlEscape(n.ssid) + "\">" + htmlEscape(n.ssid) + " (" + std::to_string(n.rssi) + " dBm)</option>";
    }
  }
  h += "</select><a class=\"btn\" href=\"/rescan\">Quét lại</a>";
  h += "<label for=\"ssid\">Hoặc nhập tên Wi-Fi (mạng ẩn)</label>"
       "<input id=\"ssid\" name=\"ssid\" maxlength=\"32\" value=\"" + htmlEscape(typedSsid) + "\" autocapitalize=\"off\">";
  h += "<label for=\"pass\">Mật khẩu Wi-Fi</label>"
       "<input id=\"pass\" name=\"pass\" type=\"password\" maxlength=\"63\" autocapitalize=\"off\">";
  h += "<button type=\"submit\">Lưu và kết nối</button></form>";
  h += kFoot;
  return h;
}

void Portal::sendPage(int code, const std::string& html) {
  // Tiêu đề bảo mật: không JS, không tài nguyên ngoài, không lưu cache, không lộ referrer.
  g_server->sendHeader("Content-Security-Policy",
                       "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  g_server->sendHeader("X-Content-Type-Options", "nosniff");
  g_server->sendHeader("Referrer-Policy", "no-referrer");
  g_server->sendHeader("Cache-Control", "no-store");
  g_server->send(code, "text/html; charset=utf-8", html.c_str());
}

void Portal::handleRoot() { sendPage(200, renderForm("", "")); }

void Portal::handleRescan() {
  if (!scanning_) {
    WiFi.scanNetworks(true);
    scanning_ = true;
  }
  g_server->sendHeader("Location", "/");
  g_server->send(303, "text/plain", "");
}

void Portal::handleSave() {
  if (saved_) {  // đã lưu rồi, đang chờ chuyển mạng
    sendPage(200, "Đã lưu.");
    return;
  }
  // Đầu vào đã được thư viện WebServer giải mã URL; kiểm tra độ dài/ký tự ở đây.
  const std::string typed = g_server->arg("ssid").c_str();
  const std::string picked = g_server->arg("pick").c_str();
  const std::string password = g_server->arg("pass").c_str();
  const std::string ssid = auhono::pickSsid(typed, picked);

  auhono::FormError err = auhono::validateSsid(ssid);
  if (err == auhono::FormError::None) err = auhono::validatePassword(password);
  if (err != auhono::FormError::None) {
    sendPage(400, renderForm(auhono::formErrorText(err), typed));  // không phản hồi lại mật khẩu
    return;
  }

  pending_.ssid = ssid;
  pending_.password = password;
  saved_ = true;
  savedAt_ = millis();

  std::string h = kHead;
  h += "</head><body><main><h1>Đã lưu</h1><p>Thiết bị đang kết nối tới Wi-Fi <b>" + auhono::htmlEscape(ssid) +
       "</b>. Wi-Fi \"Auhono\" sẽ tắt trong giây lát.</p>"
       "<p>Đèn sáng liên tục nghĩa là đã kết nối thành công. Nếu đèn nháy chậm quá 2 phút, "
       "hãy kiểm tra lại mật khẩu: giữ nút trên thiết bị 5 giây để mở lại trang này.</p>";
  h += kFoot;
  sendPage(200, h);
}

void Portal::handleRedirect() {
  // Trình duyệt kiểm tra kết nối (Android/iOS/Windows) hỏi các đường dẫn lạ: đưa về trang cấu hình.
  g_server->sendHeader("Location", "http://192.168.4.1/");
  g_server->send(302, "text/plain", "");
}

bool Portal::takeSaved(WifiCreds& out, uint32_t nowMs) {
  if (!saved_ || static_cast<uint32_t>(nowMs - savedAt_) < kSavedGraceMs) return false;
  out = pending_;
  pending_ = WifiCreds();
  saved_ = false;
  return true;
}
