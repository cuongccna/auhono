#include <unity.h>

#include <string>

#include "auhono/button.h"
#include "auhono/led.h"
#include "auhono/portal_form.h"

using namespace auhono;

// ── HTML escape / kiểm tra form ────────────────────────────────────────────

static void test_html_escape_neutralizes_markup() {
  TEST_ASSERT_EQUAL_STRING("&lt;script&gt;alert(1)&lt;/script&gt;", htmlEscape("<script>alert(1)</script>").c_str());
  TEST_ASSERT_EQUAL_STRING("&quot; onmouseover=&quot;x&quot;", htmlEscape("\" onmouseover=\"x\"").c_str());
  TEST_ASSERT_EQUAL_STRING("&#39; onfocus=&#39;x&#39;", htmlEscape("' onfocus='x'").c_str());
  TEST_ASSERT_EQUAL_STRING("a&amp;b&amp;amp;", htmlEscape("a&b&amp;").c_str());  // escape đúng một lần
  TEST_ASSERT_EQUAL_STRING("Quán Cà Phê 1", htmlEscape("Quán Cà Phê 1").c_str());  // UTF-8 giữ nguyên
  TEST_ASSERT_EQUAL_STRING("ab", htmlEscape(std::string("a\r\n\0b\x1f", 6)).c_str());  // bỏ ký tự điều khiển
  TEST_ASSERT_EQUAL_STRING("", htmlEscape("").c_str());
}

static void test_escaped_output_has_no_raw_dangerous_chars() {
  const std::string evil = "\"><img src=x onerror=alert(1)>'&";
  const std::string out = htmlEscape(evil);
  for (char c : out) TEST_ASSERT_TRUE(c != '<' && c != '>' && c != '"' && c != '\'');
}

static void test_ssid_validation() {
  TEST_ASSERT_EQUAL(FormError::None, validateSsid("Quan Ca Phe"));
  TEST_ASSERT_EQUAL(FormError::None, validateSsid("Quán Phở 24"));  // UTF-8 nhiều byte
  TEST_ASSERT_EQUAL(FormError::None, validateSsid(std::string(32, 'a')));
  TEST_ASSERT_EQUAL(FormError::SsidEmpty, validateSsid(""));
  TEST_ASSERT_EQUAL(FormError::SsidTooLong, validateSsid(std::string(33, 'a')));
  TEST_ASSERT_EQUAL(FormError::SsidBadChar, validateSsid("ab\ncd"));
  TEST_ASSERT_EQUAL(FormError::SsidBadChar, validateSsid(std::string("ab\0cd", 5)));
  TEST_ASSERT_EQUAL(FormError::SsidBadChar, validateSsid("ab\x7f"));
}

static void test_password_validation() {
  TEST_ASSERT_EQUAL(FormError::None, validatePassword(""));  // mạng mở
  TEST_ASSERT_EQUAL(FormError::None, validatePassword("12345678"));
  TEST_ASSERT_EQUAL(FormError::None, validatePassword(std::string(63, 'x')));
  TEST_ASSERT_EQUAL(FormError::None, validatePassword("p@ss w0rd!"));  // dấu cách được phép
  TEST_ASSERT_EQUAL(FormError::PasswordTooShort, validatePassword("1234567"));
  TEST_ASSERT_EQUAL(FormError::PasswordTooLong, validatePassword(std::string(64, 'x')));
  TEST_ASSERT_EQUAL(FormError::PasswordBadChar, validatePassword("mật khẩu dài đủ"));
  TEST_ASSERT_EQUAL(FormError::PasswordBadChar, validatePassword("abcdefgh\n"));
}

static void test_form_error_texts_are_vietnamese_and_nonempty() {
  TEST_ASSERT_EQUAL_STRING("", formErrorText(FormError::None));
  for (FormError e : {FormError::SsidEmpty, FormError::SsidTooLong, FormError::SsidBadChar,
                      FormError::PasswordTooShort, FormError::PasswordTooLong, FormError::PasswordBadChar}) {
    TEST_ASSERT_TRUE(std::string(formErrorText(e)).size() > 10);
  }
}

static void test_pick_ssid_prefers_typed() {
  std::string out;
  TEST_ASSERT_TRUE(resolveSsid("Hidden", ssidToken("Listed"), out));
  TEST_ASSERT_EQUAL_STRING("Hidden", out.c_str());
  TEST_ASSERT_TRUE(resolveSsid("", ssidToken("Listed"), out));
  TEST_ASSERT_EQUAL_STRING("Listed", out.c_str());
}

static void test_ap_ssid_and_device_id() {
  TEST_ASSERT_EQUAL_STRING("Auhono-0001", apSsid("AUH-000001").c_str());
  TEST_ASSERT_EQUAL_STRING("Auhono-1234", apSsid("AUH-001234").c_str());
  TEST_ASSERT_EQUAL_STRING("Auhono-0000", apSsid("").c_str());
  TEST_ASSERT_EQUAL_STRING("Auhono-0000", apSsid("AB").c_str());
  TEST_ASSERT_TRUE(isValidDeviceId("AUH-000001"));
  TEST_ASSERT_FALSE(isValidDeviceId("auh-000001"));
  TEST_ASSERT_FALSE(isValidDeviceId("AB"));
  TEST_ASSERT_FALSE(isValidDeviceId(std::string(33, 'A')));
  TEST_ASSERT_FALSE(isValidDeviceId("AUH 000001"));
  TEST_ASSERT_FALSE(isValidDeviceId("AUH-000001\n"));
}

// ── LED ────────────────────────────────────────────────────────────────────

static LedInputs in(bool id, bool portal, bool wifi, bool sensor, UploadStatus up) {
  LedInputs i;
  i.hasIdentity = id; i.portalActive = portal; i.wifiConnected = wifi; i.sensorFault = sensor; i.upload = up;
  return i;
}

static void test_led_state_selection() {
  TEST_ASSERT_EQUAL(LedState::Online, selectLedState(in(true, false, true, false, UploadStatus::Ok)));
  TEST_ASSERT_EQUAL(LedState::ServerProblem, selectLedState(in(true, false, true, false, UploadStatus::Failed)));
  TEST_ASSERT_EQUAL(LedState::Connecting, selectLedState(in(true, false, false, false, UploadStatus::Ok)));
  TEST_ASSERT_EQUAL(LedState::Connecting, selectLedState(in(true, false, true, false, UploadStatus::Unknown)));
  TEST_ASSERT_EQUAL(LedState::Setup, selectLedState(in(true, true, true, false, UploadStatus::Ok)));
  TEST_ASSERT_EQUAL(LedState::SensorFault, selectLedState(in(true, false, true, true, UploadStatus::Ok)));
  TEST_ASSERT_EQUAL(LedState::SensorFault, selectLedState(in(true, false, false, true, UploadStatus::Unknown)));
  TEST_ASSERT_EQUAL(LedState::NoIdentity, selectLedState(in(false, true, true, true, UploadStatus::Ok)));  // ưu tiên cao nhất
}

static int onCount(LedState s, uint32_t periodMs) {
  int n = 0;
  for (uint32_t t = 0; t < periodMs; t++) n += ledOn(s, t) ? 1 : 0;
  return n;
}

static int transitions(LedState s, uint32_t periodMs) {
  int n = 0;
  bool prev = ledOn(s, periodMs - 1);
  for (uint32_t t = 0; t < periodMs; t++) {
    bool cur = ledOn(s, t);
    if (cur && !prev) n++;  // đếm số lần sáng lên
    prev = cur;
  }
  return n;
}

static void test_led_patterns() {
  TEST_ASSERT_EQUAL_INT(2000, onCount(LedState::Online, 2000));            // sáng liên tục
  TEST_ASSERT_EQUAL_INT(1000, onCount(LedState::Connecting, 2000));        // 1 s sáng / 1 s tắt
  TEST_ASSERT_EQUAL_INT(1, transitions(LedState::Connecting, 2000));
  TEST_ASSERT_EQUAL_INT(10, transitions(LedState::Setup, 2000));           // nhanh: 5 nháy/giây
  TEST_ASSERT_EQUAL_INT(2, transitions(LedState::ServerProblem, 2000));    // nháy đôi
  TEST_ASSERT_EQUAL_INT(3, transitions(LedState::NoIdentity, 2500));       // ba nháy
  TEST_ASSERT_EQUAL_INT(1500 - 250, onCount(LedState::SensorFault, 1500)); // sáng, tắt ngắn
  TEST_ASSERT_TRUE(onCount(LedState::SensorFault, 1500) > 1000);           // khác kiểu "nháy" thường
}

static void test_led_patterns_are_periodic() {
  for (LedState s : {LedState::Setup, LedState::Connecting, LedState::ServerProblem, LedState::SensorFault, LedState::NoIdentity}) {
    for (uint32_t t = 0; t < 5000; t += 37) TEST_ASSERT_EQUAL(ledOn(s, t), ledOn(s, t + 30000));  // chu kỳ chia hết 30 s
  }
}

// ── Nút bấm ────────────────────────────────────────────────────────────────

static void test_button_gestures() {
  ButtonGesture b;
  TEST_ASSERT_EQUAL(ButtonEvent::None, b.update(false, 0));
  TEST_ASSERT_EQUAL(ButtonEvent::None, b.update(true, 1000));
  TEST_ASSERT_EQUAL(ButtonEvent::None, b.update(true, 5999));
  TEST_ASSERT_EQUAL(ButtonEvent::LongPress, b.update(true, 6000));   // 5 s
  TEST_ASSERT_EQUAL(ButtonEvent::None, b.update(true, 7000));        // chỉ phát một lần
  TEST_ASSERT_EQUAL(ButtonEvent::VeryLongPress, b.update(true, 16000));  // 15 s
  TEST_ASSERT_EQUAL(ButtonEvent::None, b.update(true, 20000));
  TEST_ASSERT_EQUAL(ButtonEvent::None, b.update(false, 21000));
  // Nhả ra rồi nhấn lại: bắt đầu tính lại
  TEST_ASSERT_EQUAL(ButtonEvent::None, b.update(true, 22000));
  TEST_ASSERT_EQUAL(ButtonEvent::None, b.update(true, 26999));
  TEST_ASSERT_EQUAL(ButtonEvent::LongPress, b.update(true, 27000));
}

static void test_button_short_press_does_nothing() {
  ButtonGesture b;
  b.update(true, 100);
  TEST_ASSERT_EQUAL(ButtonEvent::None, b.update(true, 2000));
  TEST_ASSERT_EQUAL(ButtonEvent::None, b.update(false, 2100));
}

void run_portal_led_tests() {
  RUN_TEST(test_html_escape_neutralizes_markup);
  RUN_TEST(test_escaped_output_has_no_raw_dangerous_chars);
  RUN_TEST(test_ssid_validation);
  RUN_TEST(test_password_validation);
  RUN_TEST(test_form_error_texts_are_vietnamese_and_nonempty);
  RUN_TEST(test_pick_ssid_prefers_typed);
  RUN_TEST(test_ap_ssid_and_device_id);
  RUN_TEST(test_led_state_selection);
  RUN_TEST(test_led_patterns);
  RUN_TEST(test_led_patterns_are_periodic);
  RUN_TEST(test_button_gestures);
  RUN_TEST(test_button_short_press_does_nothing);
}
