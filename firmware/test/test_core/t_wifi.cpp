// Wi-Fi: cấu hình lưu bền (CRC, nửa vời), phân loại lý do rớt mạng, khi nào mở cổng, đèn LED, trang cấu hình (XSS,
// SSID tiếng Việt/emoji/dấu nháy/không phải UTF-8), định tuyến captive portal.
#include <unity.h>

#include <cstring>
#include <string>

#include "auhono/http_request.h"
#include "auhono/led.h"
#include "auhono/portal_form.h"
#include "auhono/portal_page.h"
#include "auhono/portal_routes.h"
#include "auhono/wifi_creds.h"
#include "auhono/wifi_policy.h"

using namespace auhono;

// ── Lưu Wi-Fi: mất điện giữa lúc ghi, đọc lại phải kiểm ────────────────────

static void test_creds_roundtrip_varied_ssids() {
  const char* ssids[] = {"QuanCaPhe", "Quán Cà Phê Nắng", "Tiệm \"Hải Sản\" 'Bà Ba'", "a", "  spaces  ", "wifi<script>&",
                         "\xF0\x9F\x8D\xA6" "Kem" "\xF0\x9F\x8D\xA6"};
  for (const char* s : ssids) {
    WifiCreds in;
    in.ssid = s;
    in.password = "matkhau123";
    uint8_t buf[kWifiCredsMaxEncoded];
    const size_t n = encodeWifiCreds(in, buf, sizeof buf);
    TEST_ASSERT_TRUE(n > 0);
    WifiCreds out;
    TEST_ASSERT_TRUE(decodeWifiCreds(buf, n, out));
    TEST_ASSERT_EQUAL_STRING(in.ssid.c_str(), out.ssid.c_str());
    TEST_ASSERT_EQUAL_STRING("matkhau123", out.password.c_str());
  }
}

static void test_creds_open_network_and_limits() {
  WifiCreds open;
  open.ssid = "CafeMienPhi";   // mạng mở: mật khẩu rỗng, KHÔNG được thừa hưởng mật khẩu cũ
  uint8_t buf[kWifiCredsMaxEncoded];
  size_t n = encodeWifiCreds(open, buf, sizeof buf);
  WifiCreds out;
  out.password = "matkhau-cu";
  TEST_ASSERT_TRUE(decodeWifiCreds(buf, n, out));
  TEST_ASSERT_TRUE(out.password.empty());
  // 32 byte SSID + 63 byte mật khẩu: đúng biên
  WifiCreds big;
  big.ssid = std::string(32, 'S');
  big.password = std::string(63, 'p');
  n = encodeWifiCreds(big, buf, sizeof buf);
  TEST_ASSERT_EQUAL_UINT(kWifiCredsMaxEncoded, n);
  TEST_ASSERT_TRUE(decodeWifiCreds(buf, n, out));
  // Ngoài chuẩn: từ chối ngay lúc mã hóa
  big.ssid = std::string(33, 'S');
  TEST_ASSERT_EQUAL_UINT(0, encodeWifiCreds(big, buf, sizeof buf));
  big.ssid = "ok"; big.password = "1234567";
  TEST_ASSERT_EQUAL_UINT(0, encodeWifiCreds(big, buf, sizeof buf));
  big.password = std::string(64, 'p');
  TEST_ASSERT_EQUAL_UINT(0, encodeWifiCreds(big, buf, sizeof buf));
  big.ssid = ""; big.password = "12345678";
  TEST_ASSERT_EQUAL_UINT(0, encodeWifiCreds(big, buf, sizeof buf));
}

static void test_creds_any_corruption_or_truncation_is_detected() {
  WifiCreds in;
  in.ssid = "Quán Cà Phê";
  in.password = "s3cret-pass";
  uint8_t buf[kWifiCredsMaxEncoded];
  const size_t n = encodeWifiCreds(in, buf, sizeof buf);
  WifiCreds out;
  // Cụt ở mọi độ dài (mất điện giữa lúc ghi nếu ghi không nguyên tử)
  for (size_t len = 0; len < n; len++) TEST_ASSERT_FALSE(decodeWifiCreds(buf, len, out));
  // Lật từng bit: luôn bị loại
  for (size_t i = 0; i < n; i++) {
    for (int b = 0; b < 8; b++) {
      uint8_t bad[kWifiCredsMaxEncoded];
      memcpy(bad, buf, n);
      bad[i] = static_cast<uint8_t>(bad[i] ^ (1u << b));
      TEST_ASSERT_FALSE(decodeWifiCreds(bad, n, out));
    }
  }
  // Dữ liệu thừa cuối
  uint8_t longer[kWifiCredsMaxEncoded + 1];
  memcpy(longer, buf, n);
  longer[n] = 0;
  TEST_ASSERT_FALSE(decodeWifiCreds(longer, n + 1, out));
  // Flash trống (0xFF) hoặc toàn 0
  uint8_t ff[40]; memset(ff, 0xFF, sizeof ff);
  uint8_t zero[40] = {0};
  TEST_ASSERT_FALSE(decodeWifiCreds(ff, sizeof ff, out));
  TEST_ASSERT_FALSE(decodeWifiCreds(zero, sizeof zero, out));
  TEST_ASSERT_FALSE(decodeWifiCreds(nullptr, 0, out));
}

// ── Lý do rớt mạng và khi nào mở cổng ──────────────────────────────────────

static void test_disconnect_reason_classification() {
  TEST_ASSERT_EQUAL(WifiFail::NoApFound, classifyDisconnectReason(201));    // NO_AP_FOUND: sai tên / chỉ 5 GHz / router tắt
  TEST_ASSERT_EQUAL(WifiFail::AuthFailed, classifyDisconnectReason(202));   // AUTH_FAIL
  TEST_ASSERT_EQUAL(WifiFail::AuthFailed, classifyDisconnectReason(15));    // 4WAY_HANDSHAKE_TIMEOUT (sai mật khẩu WPA2)
  TEST_ASSERT_EQUAL(WifiFail::AuthFailed, classifyDisconnectReason(204));   // HANDSHAKE_TIMEOUT
  TEST_ASSERT_EQUAL(WifiFail::None, classifyDisconnectReason(8));           // ASSOC_LEAVE: ta tự ngắt, không mang thông tin
  TEST_ASSERT_EQUAL(WifiFail::Other, classifyDisconnectReason(200));        // BEACON_TIMEOUT: mất tín hiệu
  TEST_ASSERT_EQUAL(WifiFail::Other, classifyDisconnectReason(2));          // AUTH_EXPIRE
  TEST_ASSERT_EQUAL(WifiFail::Other, classifyDisconnectReason(0));
}

static void test_portal_does_not_pop_up_while_router_boots() {
  const uint32_t min = 60u * 1000u;
  // Router mất điện khởi động lại 2-10 phút: KHÔNG mở cổng (dù lý do gì)
  for (uint32_t t = 0; t <= 10 * min; t += min) {
    TEST_ASSERT_FALSE(shouldOpenPortal(t, WifiFail::NoApFound, t));
    TEST_ASSERT_FALSE(shouldOpenPortal(t, WifiFail::Other, t));
  }
  TEST_ASSERT_FALSE(shouldOpenPortal(19 * min, WifiFail::NoApFound, 19 * min));
  TEST_ASSERT_TRUE(shouldOpenPortal(20 * min, WifiFail::NoApFound, 20 * min));   // 20 phút: mở
  TEST_ASSERT_TRUE(shouldOpenPortal(20 * min, WifiFail::Other, 0));
}

static void test_portal_opens_sooner_when_router_alive_but_rejects_password() {
  const uint32_t min = 60u * 1000u;
  TEST_ASSERT_FALSE(shouldOpenPortal(4 * min, WifiFail::AuthFailed, 4 * min));
  TEST_ASSERT_TRUE(shouldOpenPortal(5 * min, WifiFail::AuthFailed, 5 * min));   // đổi mật khẩu wifi: 5 phút
  // Nhưng lý do vừa mới đổi sang "sai mật khẩu" thì chưa vội (chưa ổn định)
  TEST_ASSERT_FALSE(shouldOpenPortal(8 * min, WifiFail::AuthFailed, 30 * 1000));
  TEST_ASSERT_FALSE(shouldOpenPortal(8 * min, WifiFail::NoApFound, 8 * min));
}

// ── LED ────────────────────────────────────────────────────────────────────

static void test_led_wifi_failure_patterns_are_distinct() {
  LedInputs in;
  in.hasIdentity = true;
  in.wifiConnected = false;
  in.wifiFail = WifiFail::NoApFound;
  TEST_ASSERT_EQUAL(LedState::WifiNotFound, selectLedState(in));
  in.wifiFail = WifiFail::AuthFailed;
  TEST_ASSERT_EQUAL(LedState::WifiAuthFailed, selectLedState(in));
  in.wifiFail = WifiFail::None;
  TEST_ASSERT_EQUAL(LedState::Connecting, selectLedState(in));
  in.wifiFail = WifiFail::Other;
  TEST_ASSERT_EQUAL(LedState::Connecting, selectLedState(in));
  // Mọi trạng thái có mẫu nhấp nháy khác nhau trong 10 giây (không hai trạng thái nào trùng)
  const LedState all[] = {LedState::NoIdentity, LedState::Setup, LedState::Connecting, LedState::WifiNotFound, LedState::WifiAuthFailed,
                          LedState::Online, LedState::ServerProblem, LedState::SensorFault, LedState::WipeArmed};
  const size_t n = sizeof all / sizeof all[0];
  for (size_t a = 0; a < n; a++) {
    for (size_t b = a + 1; b < n; b++) {
      bool differ = false;
      for (uint32_t t = 0; t < 10000 && !differ; t += 10) differ = ledOn(all[a], t) != ledOn(all[b], t);
      TEST_ASSERT_TRUE_MESSAGE(differ, "hai trạng thái LED trùng mẫu");
    }
  }
}

static void test_led_priority_sensor_fault_over_wifi_and_wipe_over_all() {
  LedInputs in;
  in.wifiConnected = false;
  in.wifiFail = WifiFail::AuthFailed;
  in.sensorFault = true;
  TEST_ASSERT_EQUAL(LedState::SensorFault, selectLedState(in));  // "probe fault" hiện rõ, chủ quán cắm lại đầu dò trước
  in.portalActive = true;
  TEST_ASSERT_EQUAL(LedState::Setup, selectLedState(in));
  in.wipeArmed = true;
  TEST_ASSERT_EQUAL(LedState::WipeArmed, selectLedState(in));
  in.wipeArmed = false; in.portalActive = false; in.sensorFault = false;
  in.wifiConnected = true; in.upload = UploadStatus::Ok;
  TEST_ASSERT_EQUAL(LedState::Online, selectLedState(in));
}

// ── SSID: token hex, UTF-8, giới hạn theo BYTE ─────────────────────────────

static void test_ssid_limit_is_bytes_not_characters() {
  // 10 chữ có dấu 3 byte = 30 byte: hợp lệ; 11 chữ = 33 byte: quá dài dù chỉ có 11 "ký tự"
  std::string s30, s33;
  for (int i = 0; i < 10; i++) s30 += "\xE1\xBA\xA1";  // "ạ"
  s33 = s30 + "\xE1\xBA\xA1";
  TEST_ASSERT_EQUAL(FormError::None, validateSsid(s30));
  TEST_ASSERT_EQUAL(FormError::SsidTooLong, validateSsid(s33));
  // emoji 4 byte: 8 con = 32 byte hợp lệ, 9 con không
  std::string e8, e9;
  for (int i = 0; i < 8; i++) e8 += "\xF0\x9F\x8D\xA6";
  e9 = e8 + "\xF0\x9F\x8D\xA6";
  TEST_ASSERT_EQUAL(FormError::None, validateSsid(e8));
  TEST_ASSERT_EQUAL(FormError::SsidTooLong, validateSsid(e9));
}

static void test_ssid_token_is_exact_and_strict() {
  const std::string raw = std::string("Qu\xE1n \"A\" <b>\xFF\xFE", 14);  // kèm byte không phải UTF-8
  const std::string tok = ssidToken(raw);
  for (char c : tok) TEST_ASSERT_TRUE((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'));  // không thể chứa ký tự nguy hiểm
  std::string back;
  TEST_ASSERT_TRUE(ssidFromToken(tok, back));
  TEST_ASSERT_TRUE(back == raw);                                  // đúng từng byte
  TEST_ASSERT_FALSE(ssidFromToken("", back));
  TEST_ASSERT_FALSE(ssidFromToken("zz", back));
  TEST_ASSERT_FALSE(ssidFromToken("abc", back));                  // lẻ
  TEST_ASSERT_FALSE(ssidFromToken(std::string(66, 'a'), back));   // > 32 byte
  std::string out;
  TEST_ASSERT_FALSE(resolveSsid("", "", out));
  TEST_ASSERT_FALSE(resolveSsid("", "nothex", out));
  TEST_ASSERT_TRUE(resolveSsid("Typed", "", out));
  TEST_ASSERT_EQUAL_STRING("Typed", out.c_str());
}

static void test_sanitize_utf8() {
  TEST_ASSERT_EQUAL_STRING("Quán Cà Phê", sanitizeUtf8("Quán Cà Phê").c_str());
  TEST_ASSERT_EQUAL_STRING("\xF0\x9F\x8D\xA6", sanitizeUtf8("\xF0\x9F\x8D\xA6").c_str());
  TEST_ASSERT_EQUAL_STRING("a?b", sanitizeUtf8("a\xFF" "b").c_str());                 // byte lạ
  TEST_ASSERT_EQUAL_STRING("a??b", sanitizeUtf8("a\xE1\xBA" "b").c_str());          // chuỗi cụt giữa chừng
  TEST_ASSERT_EQUAL_STRING("??", sanitizeUtf8("\xC0\x80").c_str());                   // mã hóa quá dài
  TEST_ASSERT_EQUAL_STRING("???", sanitizeUtf8("\xED\xA0\x80").c_str());              // surrogate
  TEST_ASSERT_EQUAL_STRING("????", sanitizeUtf8("\xF4\x90\x80\x80").c_str());         // > U+10FFFF
  TEST_ASSERT_EQUAL_STRING("??", sanitizeUtf8("\xE1\xBA").c_str());                 // cụt ở cuối
  for (int b = 0; b < 256; b++) {                                                      // không bao giờ tràn/crash
    std::string s(1, static_cast<char>(b));
    s += static_cast<char>(b);
    (void)sanitizeUtf8(s);
  }
}

// ── Trang cấu hình: XSS ────────────────────────────────────────────────────

static PortalView baseView() {
  PortalView v;
  v.deviceId = "AUH-000001";
  v.fwVersion = "1.0.0";
  v.csrfToken = "0123abcd";
  return v;
}

static bool containsRaw(const std::string& html, const char* needle) { return html.find(needle) != std::string::npos; }

static void test_page_escapes_hostile_ssids_everywhere() {
  PortalView v = baseView();
  v.networks.push_back({"\"><script>alert(1)</script>", -40});
  v.networks.push_back({"'onmouseover='alert(1)", -50});
  v.networks.push_back({"</option></select><img src=x onerror=alert(2)>", -55});
  v.networks.push_back({"Quán Cà Phê \xF0\x9F\x8D\xA6", -60});
  v.networks.push_back({"bad\xFF\xFEutf8", -70});
  v.typedSsid = "\"><svg onload=alert(3)>";
  v.savedSsid = "<b>x</b>";
  v.errorText = "<i>lỗi</i>";
  v.deviceId = "<script>";
  v.wifiFail = WifiFail::AuthFailed;
  const std::string html = renderPortalPage(v);
  TEST_ASSERT_FALSE(containsRaw(html, "<script"));
  TEST_ASSERT_FALSE(containsRaw(html, "<img"));
  TEST_ASSERT_FALSE(containsRaw(html, "<svg"));
  TEST_ASSERT_FALSE(containsRaw(html, "<b>x"));
  TEST_ASSERT_FALSE(containsRaw(html, "<i>l"));
  // (chữ "onerror=alert" vẫn có thể hiện ra như VĂN BẢN đã escape trong &lt;img ...&gt;; vô hại vì không có '<' thô nào)
  for (size_t i = 0; i + 1 < html.size(); i++) {
    // Mọi '<' thô trong trang phải mở một thẻ do CHÍNH TA viết (chữ cái, '/', hoặc '!'), không phải từ dữ liệu ngoài
    if (html[i] == '<') TEST_ASSERT_TRUE((html[i + 1] >= 'a' && html[i + 1] <= 'z') || html[i + 1] == '/' || html[i + 1] == '!');
  }
  // SSID tiếng Việt và emoji hiển thị nguyên vẹn
  TEST_ASSERT_TRUE(containsRaw(html, "Quán Cà Phê \xF0\x9F\x8D\xA6"));
  // Byte lạ được thay bằng '?', không làm hỏng trang (trang vẫn kết thúc đúng)
  TEST_ASSERT_TRUE(containsRaw(html, "bad??utf8"));
  TEST_ASSERT_TRUE(html.size() > 100 && html.compare(html.size() - 21, 21, "</main></body></html>") == 0);
  // Không JavaScript, không tài nguyên ngoài
  TEST_ASSERT_FALSE(containsRaw(html, "<script"));
  TEST_ASSERT_FALSE(containsRaw(html, "http://"));
  TEST_ASSERT_FALSE(containsRaw(html, "https://"));
}

static void test_page_option_values_are_hex_tokens_only() {
  PortalView v = baseView();
  v.networks.push_back({"a\"b", -40});
  const std::string html = renderPortalPage(v);
  const std::string tok = ssidToken("a\"b");
  TEST_ASSERT_TRUE(containsRaw(html, ("<option value=\"" + tok + "\">").c_str()));
  TEST_ASSERT_FALSE(containsRaw(html, "value=\"a\"b\""));
}

static void test_page_never_contains_secrets() {
  PortalView v = baseView();
  v.typedSsid = "MyWifi";
  const std::string html = renderPortalPage(v);
  TEST_ASSERT_TRUE(containsRaw(html, "AUH-000001"));           // mã thiết bị (in trên nhãn) được phép
  TEST_ASSERT_TRUE(containsRaw(html, "name=\"pass\""));
  TEST_ASSERT_FALSE(containsRaw(html, "name=\"pass\" value"));  // ô mật khẩu không bao giờ được điền sẵn
  TEST_ASSERT_TRUE(containsRaw(html, "type=\"password\""));
}

static void test_page_status_messages_distinguish_causes() {
  PortalView v = baseView();
  v.savedSsid = "QuanA";
  v.wifiFail = WifiFail::NoApFound;
  std::string m = wifiStatusMessage(v);
  TEST_ASSERT_TRUE(m.find("2.4 GHz") != std::string::npos);
  TEST_ASSERT_TRUE(m.find("Không tìm thấy") != std::string::npos);
  v.wifiFail = WifiFail::AuthFailed;
  m = wifiStatusMessage(v);
  TEST_ASSERT_TRUE(m.find("mật khẩu") != std::string::npos);
  v.wifiConnected = true;
  TEST_ASSERT_TRUE(wifiStatusMessage(v).find("kết nối tốt") != std::string::npos);
  v.savedSsid.clear();
  TEST_ASSERT_TRUE(wifiStatusMessage(v).empty());
}

static void test_page_scanning_state_and_saved_page() {
  PortalView v = baseView();
  v.scanning = true;
  std::string html = renderPortalPage(v);
  TEST_ASSERT_TRUE(containsRaw(html, "http-equiv=\"refresh\""));
  TEST_ASSERT_TRUE(containsRaw(html, "Đang quét"));
  v.scanning = false;
  html = renderPortalPage(v);
  TEST_ASSERT_FALSE(containsRaw(html, "http-equiv=\"refresh\""));
  const std::string saved = renderSavedPage("<i>Tiệm</i>");
  TEST_ASSERT_FALSE(containsRaw(saved, "<i>"));
  TEST_ASSERT_TRUE(containsRaw(saved, "Đã lưu"));
}

// ── Định tuyến captive portal (Android / iOS / Windows) ─────────────────────

static void test_captive_probes_from_all_platforms_are_redirected() {
  const char* apIp = "192.168.4.1";
  struct Probe { const char* host; const char* path; };
  const Probe probes[] = {
      {"connectivitycheck.gstatic.com", "/generate_204"}, {"clients3.google.com", "/generate_204"},
      {"www.google.com", "/gen_204"},                       {"captive.apple.com", "/hotspot-detect.html"},
      {"captive.apple.com", "/library/test/success.html"},  {"www.msftconnecttest.com", "/connecttest.txt"},
      {"www.msftncsi.com", "/ncsi.txt"},                    {"www.msftconnecttest.com", "/redirect"},
      {"detectportal.firefox.com", "/success.txt"},         {"nmcheck.gnome.org", "/check_network_status.txt"},
      {"anything.example", "/"}};
  for (const Probe& p : probes) {
    TEST_ASSERT_EQUAL_MESSAGE(static_cast<int>(PortalRoute::Redirect),
                              static_cast<int>(routeRequest(HttpMethod::Get, p.path, p.host, apIp)), p.host);
  }
  // Cùng đường dẫn nhưng Host là IP của thiết bị: đường dẫn lạ vẫn về trang chính
  TEST_ASSERT_EQUAL(PortalRoute::Redirect, routeRequest(HttpMethod::Get, "/generate_204", apIp, apIp));
  TEST_ASSERT_TRUE(isCaptiveProbePath("/generate_204"));
  TEST_ASSERT_TRUE(isCaptiveProbePath("/hotspot-detect.html"));
  TEST_ASSERT_FALSE(isCaptiveProbePath("/save"));
}

static void test_portal_own_routes() {
  const char* ip = "192.168.4.1";
  TEST_ASSERT_EQUAL(PortalRoute::Form, routeRequest(HttpMethod::Get, "/", ip, ip));
  TEST_ASSERT_EQUAL(PortalRoute::Form, routeRequest(HttpMethod::Head, "/", "192.168.4.1:80", ip));
  TEST_ASSERT_EQUAL(PortalRoute::Save, routeRequest(HttpMethod::Post, "/save", ip, ip));
  TEST_ASSERT_EQUAL(PortalRoute::Rescan, routeRequest(HttpMethod::Get, "/rescan", ip, ip));
  // Sai phương thức -> chuyển hướng, không xử lý
  TEST_ASSERT_EQUAL(PortalRoute::Redirect, routeRequest(HttpMethod::Get, "/save", ip, ip));
  TEST_ASSERT_EQUAL(PortalRoute::Redirect, routeRequest(HttpMethod::Post, "/", ip, ip));
  TEST_ASSERT_EQUAL(PortalRoute::Redirect, routeRequest(HttpMethod::Other, "/", ip, ip));
  // POST /save từ trang web KHÁC (Host lạ / DNS rebinding): không bao giờ vào Save
  TEST_ASSERT_EQUAL(PortalRoute::Redirect, routeRequest(HttpMethod::Post, "/save", "evil.example", ip));
  TEST_ASSERT_EQUAL(PortalRoute::Redirect, routeRequest(HttpMethod::Post, "/save", "", ip));
  TEST_ASSERT_TRUE(isPortalHost("192.168.4.1", ip));
  TEST_ASSERT_FALSE(isPortalHost("192.168.4.10", ip));
  TEST_ASSERT_FALSE(isPortalHost("192.168.4.1.evil.com", ip));
}

static void test_redirect_and_page_responses_are_well_formed() {
  const std::string r = buildRedirectResponse("http://192.168.4.1/");
  TEST_ASSERT_TRUE(r.rfind("HTTP/1.1 302 Found\r\n", 0) == 0);
  TEST_ASSERT_TRUE(r.find("Location: http://192.168.4.1/\r\n") != std::string::npos);
  TEST_ASSERT_TRUE(r.find("Connection: close\r\n") != std::string::npos);
  TEST_ASSERT_TRUE(r.find("Cache-Control: no-store\r\n") != std::string::npos);
  // Không bao giờ giả "Success"/204 (làm điện thoại tưởng đã có Internet và không hiện popup)
  TEST_ASSERT_TRUE(r.find("Success") == std::string::npos);
  TEST_ASSERT_TRUE(r.find(" 204") == std::string::npos);
  // Content-Length khớp thân
  const size_t hdrEnd = r.find("\r\n\r\n") + 4;
  const size_t cl = std::stoul(r.substr(r.find("Content-Length: ") + 16));
  TEST_ASSERT_EQUAL_UINT(r.size() - hdrEnd, cl);

  const std::string p = buildPageResponse(200, "<p>x</p>");
  TEST_ASSERT_TRUE(p.find("Content-Security-Policy: default-src 'none'") != std::string::npos);
  TEST_ASSERT_TRUE(p.find("Content-Length: 8\r\n") != std::string::npos);
  TEST_ASSERT_TRUE(p.size() > 8 && p.compare(p.size() - 8, 8, "<p>x</p>") == 0);
  const std::string head = buildPageResponse(200, "<p>x</p>", true);
  TEST_ASSERT_TRUE(head.find("Content-Length: 8\r\n") != std::string::npos);
  TEST_ASSERT_TRUE(head.find("<p>x</p>") == std::string::npos);   // HEAD không có thân
  TEST_ASSERT_TRUE(buildErrorResponse(413).find("413 Payload Too Large") != std::string::npos);
}

void run_wifi_tests() {
  RUN_TEST(test_creds_roundtrip_varied_ssids);
  RUN_TEST(test_creds_open_network_and_limits);
  RUN_TEST(test_creds_any_corruption_or_truncation_is_detected);
  RUN_TEST(test_disconnect_reason_classification);
  RUN_TEST(test_portal_does_not_pop_up_while_router_boots);
  RUN_TEST(test_portal_opens_sooner_when_router_alive_but_rejects_password);
  RUN_TEST(test_led_wifi_failure_patterns_are_distinct);
  RUN_TEST(test_led_priority_sensor_fault_over_wifi_and_wipe_over_all);
  RUN_TEST(test_ssid_limit_is_bytes_not_characters);
  RUN_TEST(test_ssid_token_is_exact_and_strict);
  RUN_TEST(test_sanitize_utf8);
  RUN_TEST(test_page_escapes_hostile_ssids_everywhere);
  RUN_TEST(test_page_option_values_are_hex_tokens_only);
  RUN_TEST(test_page_never_contains_secrets);
  RUN_TEST(test_page_status_messages_distinguish_causes);
  RUN_TEST(test_page_scanning_state_and_saved_page);
  RUN_TEST(test_captive_probes_from_all_platforms_are_redirected);
  RUN_TEST(test_portal_own_routes);
  RUN_TEST(test_redirect_and_page_responses_are_well_formed);
}
