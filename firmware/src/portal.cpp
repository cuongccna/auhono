#include "portal.h"

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiServer.h>
#include <WiFiUdp.h>
#include <esp_random.h>

#include <algorithm>
#include <vector>

#include "auhono/dns_reply.h"
#include "auhono/hex.h"
#include "auhono/http_request.h"
#include "auhono/portal_form.h"
#include "auhono/portal_page.h"
#include "auhono/portal_routes.h"
#include "auhono/url_form.h"
#include "config.h"

namespace {
constexpr size_t kMaxNetworks = 20;
constexpr uint32_t kScanTimeoutMs = 15000;
}  // namespace

struct Portal::Impl {
  struct Slot {
    WiFiClient client;
    auhono::HttpRequestParser parser;
    uint32_t startMs = 0;
    bool used = false;
  };

  explicit Impl(const IPAddress& ip) : apIp(ip), server(ip, 80, 4) {}

  IPAddress apIp;
  std::string apIpStr;
  WiFiServer server;   // chỉ lắng nghe trên IP của AP
  WiFiUDP udp;         // DNS, cũng chỉ trên IP của AP
  Slot slots[cfg::kPortalMaxClients];

  std::string deviceId, fwVersion, csrf;
  std::vector<auhono::PortalNetwork> networks;
  bool scanning = false;
  uint32_t scanStartedAt = 0;

  bool saved = false;
  uint32_t savedAt = 0;
  auhono::WifiCreds pending;

  bool byUser = false;
  uint32_t startedAt = 0;
  uint32_t lastActivity = 0;

  std::string statusSsid;
  bool statusConnected = false;
  auhono::WifiFail statusFail = auhono::WifiFail::None;

  // ── DNS ──
  void serviceDns() {
    const uint8_t ip4[4] = {apIp[0], apIp[1], apIp[2], apIp[3]};
    for (int i = 0; i < 4; i++) {  // tối đa 4 gói mỗi vòng: không để một luồng gói làm nghẽn loop()
      const int n = udp.parsePacket();
      if (n <= 0) break;
      uint8_t in[512];
      if (n > static_cast<int>(sizeof in)) { udp.flush(); continue; }
      const int r = udp.read(in, static_cast<size_t>(n));
      udp.flush();
      if (r <= 0) continue;
      uint8_t out[512];
      const size_t m = auhono::buildDnsReply(in, static_cast<size_t>(r), ip4, out, sizeof out);
      if (m == 0) continue;
      udp.beginPacket(udp.remoteIP(), udp.remotePort());
      udp.write(out, m);
      udp.endPacket();
    }
  }

  // ── Quét Wi-Fi (không đồng bộ) ──
  void startScan(uint32_t nowMs) {
    if (scanning) return;
    if (WiFi.status() != WL_CONNECTED) WiFi.disconnect(false);  // quét thất bại nếu STA đang dở dang kết nối
    networks.clear();
    const int16_t r = WiFi.scanNetworks(true);                  // không chặn
    scanning = (r == WIFI_SCAN_RUNNING);
    scanStartedAt = nowMs;
  }

  void pollScan(uint32_t nowMs) {
    if (!scanning) return;
    const int16_t n = WiFi.scanComplete();
    if (n == WIFI_SCAN_RUNNING) {
      if (static_cast<uint32_t>(nowMs - scanStartedAt) > kScanTimeoutMs) { WiFi.scanDelete(); scanning = false; }
      return;
    }
    scanning = false;
    networks.clear();
    if (n > 0) {
      std::vector<auhono::PortalNetwork> all;
      for (int i = 0; i < n && all.size() < kMaxNetworks * 3; i++) {
        std::string ssid = WiFi.SSID(static_cast<uint8_t>(i)).c_str();
        if (auhono::validateSsid(ssid) != auhono::FormError::None) continue;  // bỏ tên rỗng (ẩn)/lạ
        all.push_back({ssid, static_cast<int>(WiFi.RSSI(static_cast<uint8_t>(i)))});
      }
      // Mạnh nhất trước; bỏ trùng tên (nhiều băng/bộ phát cùng SSID).
      std::sort(all.begin(), all.end(), [](const auhono::PortalNetwork& a, const auhono::PortalNetwork& b) { return a.rssi > b.rssi; });
      for (const auto& net : all) {
        const bool dup = std::any_of(networks.begin(), networks.end(), [&](const auhono::PortalNetwork& u) { return u.ssid == net.ssid; });
        if (!dup && networks.size() < kMaxNetworks) networks.push_back(net);
      }
    }
    WiFi.scanDelete();
  }

  // ── HTTP ──
  auhono::PortalView view(const std::string& errorText = std::string(), const std::string& typedSsid = std::string()) const {
    auhono::PortalView v;
    v.deviceId = deviceId;
    v.fwVersion = fwVersion;
    v.scanning = scanning;
    v.networks = networks;
    v.errorText = errorText;
    v.typedSsid = typedSsid;
    v.csrfToken = csrf;
    v.savedSsid = statusSsid;
    v.wifiConnected = statusConnected;
    v.wifiFail = statusFail;
    return v;
  }

  static void respond(Slot& s, const std::string& data) {
    const uint8_t* p = reinterpret_cast<const uint8_t*>(data.data());
    size_t left = data.size();
    const uint32_t deadline = millis() + 2000;
    while (left > 0 && static_cast<int32_t>(millis() - deadline) < 0) {
      const size_t w = s.client.write(p, left);
      if (w == 0) { delay(5); continue; }
      p += w;
      left -= w;
    }
    s.client.stop();
    s.used = false;
  }

  void handleSave(Slot& s, uint32_t nowMs) {
    if (saved) { respond(s, auhono::buildPageResponse(200, auhono::renderSavedPage(pending.ssid))); return; }

    std::vector<auhono::FormField> f;
    if (!auhono::parseUrlEncoded(s.parser.body(), f)) {
      respond(s, auhono::buildPageResponse(400, auhono::renderPortalPage(view("Dữ liệu gửi lên không hợp lệ."))));
      return;
    }
    // Token phiên: chặn trang web khác (mở trên chính điện thoại này) tự gửi form vào 192.168.4.1.
    const std::string tok = auhono::formValue(f, "t");
    if (tok.size() != csrf.size() ||
        !auhono::constTimeEqual(reinterpret_cast<const uint8_t*>(tok.data()), reinterpret_cast<const uint8_t*>(csrf.data()), csrf.size())) {
      respond(s, auhono::buildPageResponse(400, auhono::renderPortalPage(view("Trang đã hết hạn, vui lòng thử lại."))));
      return;
    }
    const std::string typed = auhono::formValue(f, "ssid");
    const std::string password = auhono::formValue(f, "pass");
    std::string ssid;
    auhono::FormError err = auhono::FormError::None;
    if (!auhono::resolveSsid(typed, auhono::formValue(f, "pick"), ssid)) err = auhono::FormError::SsidEmpty;
    if (err == auhono::FormError::None) err = auhono::validateSsid(ssid);
    if (err == auhono::FormError::None) err = auhono::validatePassword(password);
    if (err != auhono::FormError::None) {
      // Không phản hồi lại mật khẩu; chỉ giữ lại tên Wi-Fi đã gõ.
      respond(s, auhono::buildPageResponse(400, auhono::renderPortalPage(view(auhono::formErrorText(err), typed))));
      return;
    }
    pending.ssid = ssid;
    pending.password = password;
    saved = true;
    savedAt = nowMs;
    respond(s, auhono::buildPageResponse(200, auhono::renderSavedPage(ssid)));
  }

  void handleRequest(Slot& s, uint32_t nowMs) {
    lastActivity = nowMs;
    const auhono::HttpMethod m = s.parser.method();
    switch (auhono::routeRequest(m, s.parser.path(), s.parser.host(), apIpStr)) {
      case auhono::PortalRoute::Form:
        respond(s, auhono::buildPageResponse(200, auhono::renderPortalPage(view()), m == auhono::HttpMethod::Head));
        break;
      case auhono::PortalRoute::Rescan:
        startScan(nowMs);
        respond(s, auhono::buildRedirectResponse("http://" + apIpStr + "/"));
        break;
      case auhono::PortalRoute::Save:
        handleSave(s, nowMs);
        break;
      case auhono::PortalRoute::Redirect:
      default:
        // Mọi đường dẫn "thăm dò mạng" (Android/iOS/Windows...) và tên miền lạ: về trang cấu hình.
        respond(s, auhono::buildRedirectResponse("http://" + apIpStr + "/"));
        break;
    }
  }

  void serviceClients(uint32_t nowMs) {
    // Nhận kết nối mới (tối đa 4 mỗi vòng); hết chỗ thì từ chối ngay.
    for (int i = 0; i < 4; i++) {
      WiFiClient c = server.available();
      if (!c) break;
      Slot* spare = nullptr;
      for (Slot& s : slots) if (!s.used) { spare = &s; break; }
      if (!spare) { c.stop(); continue; }
      c.setTimeout(2);  // giây: giới hạn ghi/đọc socket
      spare->client = c;
      spare->parser.reset();
      spare->startMs = nowMs;
      spare->used = true;
    }
    for (Slot& s : slots) {
      if (!s.used) continue;
      if (static_cast<uint32_t>(nowMs - s.startMs) > cfg::kPortalRequestDeadlineMs) {  // quá chậm/treo: slowloris
        respond(s, auhono::buildErrorResponse(408));
        continue;
      }
      const int avail = s.client.available();
      if (avail > 0) {
        uint8_t buf[256];
        const int n = s.client.read(buf, static_cast<size_t>(avail < static_cast<int>(sizeof buf) ? avail : static_cast<int>(sizeof buf)));
        if (n > 0) s.parser.feed(buf, static_cast<size_t>(n));
      } else if (!s.client.connected()) {
        s.client.stop();
        s.used = false;
        continue;
      }
      if (s.parser.state() == auhono::HttpRequestParser::State::Done) handleRequest(s, nowMs);
      else if (s.parser.state() == auhono::HttpRequestParser::State::Error)
        respond(s, auhono::buildErrorResponse(auhono::httpStatusFor(s.parser.error())));
    }
  }
};

bool Portal::start(const std::string& deviceId, const std::string& fwVersion, uint32_t nowMs, bool byUser) {
  if (impl_) return true;

  WiFi.persistent(false);
  WiFi.mode(WIFI_AP_STA);  // AP để cấu hình + STA để quét (và để tiếp tục thử nối Wi-Fi đã lưu nếu có)
  const std::string ssid = auhono::apSsid(deviceId);
  if (!WiFi.softAP(ssid.c_str(), nullptr, 1, 0, 4)) {  // Wi-Fi mở, kênh 1 (tự theo kênh STA khi đã nối), tối đa 4 điện thoại
    Serial.println("[portal] khong mo duoc AP");
    WiFi.softAPdisconnect(true);
    return false;
  }
  delay(100);  // chờ AP có IP

  IPAddress ip = WiFi.softAPIP();
  if (ip == IPAddress(static_cast<uint32_t>(0))) ip = IPAddress(192, 168, 4, 1);
  Impl* impl = new Impl(ip);
  impl->apIpStr = ip.toString().c_str();
  impl->deviceId = deviceId;
  impl->fwVersion = fwVersion;
  impl->byUser = byUser;
  impl->startedAt = nowMs;
  impl->lastActivity = nowMs;
  uint8_t rnd[8];
  for (uint8_t& b : rnd) b = static_cast<uint8_t>(esp_random());
  impl->csrf = auhono::toHex(rnd, sizeof rnd);
  impl->server.begin();
  impl->udp.begin(ip, 53);
  impl_ = impl;
  impl_->startScan(nowMs);
  return true;
}

void Portal::stop() {
  if (!impl_) return;
  impl_->server.stop();
  impl_->udp.stop();
  for (Impl::Slot& s : impl_->slots) if (s.used) s.client.stop();
  WiFi.scanDelete();
  WiFi.softAPdisconnect(true);
  delete impl_;
  impl_ = nullptr;
}

void Portal::loop(uint32_t nowMs) {
  if (!impl_) return;
  impl_->serviceDns();
  impl_->serviceClients(nowMs);
  impl_->pollScan(nowMs);
}

bool Portal::takeSaved(auhono::WifiCreds& out, uint32_t nowMs) {
  if (!impl_ || !impl_->saved || static_cast<uint32_t>(nowMs - impl_->savedAt) < cfg::kSavedGraceMs) return false;
  out = impl_->pending;
  impl_->pending = auhono::WifiCreds();
  impl_->saved = false;
  return true;
}

void Portal::setStatus(const std::string& savedSsid, bool connected, auhono::WifiFail fail) {
  if (!impl_) return;
  impl_->statusSsid = savedSsid;
  impl_->statusConnected = connected;
  impl_->statusFail = fail;
}

bool Portal::byUser() const { return impl_ && impl_->byUser; }
uint8_t Portal::stationCount() const { return impl_ ? WiFi.softAPgetStationNum() : 0; }
bool Portal::scanning() const { return impl_ && impl_->scanning; }

bool Portal::idleTimedOut(uint32_t nowMs) const {
  if (!impl_) return false;
  return static_cast<uint32_t>(nowMs - impl_->lastActivity) >= cfg::kPortalIdleTimeoutMs ||
         static_cast<uint32_t>(nowMs - impl_->startedAt) >= cfg::kPortalHardCapMs;
}

void Portal::touch(uint32_t nowMs) {
  if (!impl_) return;
  impl_->lastActivity = nowMs;
  impl_->startedAt = nowMs;
}
