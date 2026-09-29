// Mật khẩu WPA2 của AP cấu hình (suy ra từ khóa thiết bị) + nhịp tim/diag.
#include <unity.h>

#include <cstring>
#include <random>
#include <string>
#include <vector>

#include "auhono/ap_credentials.h"
#include "auhono/backoff.h"
#include "auhono/device_client.h"
#include "auhono/hex.h"
#include "auhono/heartbeat.h"
#include "auhono/portal_form.h"
#include "auhono/readings.h"
#include "auhono/retry_policy.h"
#include "auhono/upload_policy.h"
#include "auhono/uploader.h"
#include "fakes.h"
#include "soft_crypto.h"

using namespace auhono;

// ── Feature A: mật khẩu AP ─────────────────────────────────────────────────

static const char* kKeyHex = "41bc43e33ceb8fd260f6888bcf8b89858310b99545a24ac3a6a76bb1b7b8a507";

static void test_ap_password_matches_protocol_vector() {
  SoftCrypto crypto;
  uint8_t key[32];
  TEST_ASSERT_TRUE(fromHex(kKeyHex, 64, key, sizeof key, nullptr));
  // HMAC(key, "ap-password:v1") = 7db6c1ac7f11f6a3dfc0... (PROTOCOL.md)
  uint8_t mac[32];
  softcrypto::hmacSha256(key, 32, reinterpret_cast<const uint8_t*>("ap-password:v1"), 14, mac);
  TEST_ASSERT_EQUAL_STRING("7db6c1ac7f11f6a3dfc0", toHex(mac, 10).c_str());
  TEST_ASSERT_EQUAL_STRING("XP1CZHP3Z0", deriveApPassword(crypto, key).c_str());
  TEST_ASSERT_EQUAL_STRING("Auhono-0001", apSsid("AUH-000001").c_str());
}

static void test_ap_password_alphabet_length_and_wpa2_validity() {
  SoftCrypto crypto;
  std::mt19937 rng(42);
  const std::string alphabet = kApPasswordAlphabet;
  TEST_ASSERT_EQUAL_UINT(32, alphabet.size());
  TEST_ASSERT_TRUE(alphabet.find_first_of("ILOU") == std::string::npos);
  std::string all;
  for (int i = 0; i < 2000; i++) {
    uint8_t key[32];
    for (auto& b : key) b = static_cast<uint8_t>(rng());
    const std::string pw = deriveApPassword(crypto, key);
    TEST_ASSERT_EQUAL_UINT(kApPasswordLen, pw.size());
    TEST_ASSERT_TRUE(pw.find_first_not_of(alphabet) == std::string::npos);
    TEST_ASSERT_EQUAL(FormError::None, validatePassword(pw));   // 8..63 ASCII: hợp lệ cho WPA2-PSK
    TEST_ASSERT_TRUE(pw.size() >= kMinPasswordLen && pw.size() <= kMaxPasswordLen);
    all += pw;
  }
  for (char c : alphabet) TEST_ASSERT_TRUE(all.find(c) != std::string::npos);   // phủ đủ 32 ký tự
  uint8_t zero[32] = {0}, one[32] = {0};
  one[31] = 1;
  TEST_ASSERT_EQUAL_UINT(kApPasswordLen, deriveApPassword(crypto, zero).size());
  TEST_ASSERT_TRUE(deriveApPassword(crypto, zero) != deriveApPassword(crypto, one));   // khóa khác => mật khẩu khác
  TEST_ASSERT_TRUE(deriveApPassword(crypto, one) == deriveApPassword(crypto, one));    // xác định
}

static void test_ap_ssid_defensive() {
  TEST_ASSERT_EQUAL_STRING("Auhono-1234", apSsid("AUH-001234").c_str());
  TEST_ASSERT_EQUAL_STRING("Auhono-0001", apSsid("X-0001").c_str());
  TEST_ASSERT_EQUAL_STRING("Auhono-H-12", apSsid("AUH-12").c_str());     // < 4 ký tự sau dấu '-': vẫn là 4 ký tự cuối như máy chủ
  TEST_ASSERT_EQUAL_STRING("Auhono-ABC", apSsid("ABC").c_str());         // mã 3 ký tự (tối thiểu hợp lệ): cả mã
  TEST_ASSERT_EQUAL_STRING("Auhono-0000", apSsid("").c_str());
  for (const char* id : {"", "A", "AB", "ABC", "AUH-1", "AUH-000001", "AUH-000001AUH-000001AUH-00"}) {
    TEST_ASSERT_EQUAL(FormError::None, validateSsid(apSsid(id)));         // SSID luôn hợp lệ (<= 32 byte, không rỗng)
  }
}

// ── Feature B: byte chính xác của body ─────────────────────────────────────

static std::string build(const char* fw, const WireReading* r, size_t n, const Diag* d) {
  char buf[1024];
  const size_t len = buildReadingsBody(buf, sizeof buf, fw, r, n, d);
  TEST_ASSERT_TRUE(len > 0);
  TEST_ASSERT_EQUAL_UINT(strlen(buf), len);
  return std::string(buf, len);
}

static Diag fullDiag() {
  Diag d;
  d.hasSensor = true; d.sensorFault = true;
  d.hasFaultS = true; d.faultS = 1200;
  strcpy(d.rst, "brownout");
  d.hasRssi = true; d.rssi = -71;
  d.hasHeap = true; d.heap = 84000;
  d.hasUp = true; d.up = 86400;
  return d;
}

static void test_diag_exact_bytes() {
  const Diag full = fullDiag();
  // Đúng ví dụ trong PROTOCOL.md
  TEST_ASSERT_EQUAL_STRING(
      "{\"fw\":\"1.0.0\",\"readings\":[],\"diag\":{\"sensor\":\"fault\",\"fault_s\":1200,\"rst\":\"brownout\",\"rssi\":-71,\"heap\":84000,\"up\":86400}}",
      build("1.0.0", nullptr, 0, &full).c_str());
  const WireReading r[] = {{1800000000u, -1950}, {1800000060u, 405}};
  Diag ok = fullDiag();
  ok.sensorFault = false; ok.faultS = 0;
  TEST_ASSERT_EQUAL_STRING(
      "{\"fw\":\"1.0.0\",\"readings\":[{\"t\":1800000000,\"c\":-19.5},{\"t\":1800000060,\"c\":4.05}],"
      "\"diag\":{\"sensor\":\"ok\",\"fault_s\":0,\"rst\":\"brownout\",\"rssi\":-71,\"heap\":84000,\"up\":86400}}",
      build("1.0.0", r, 2, &ok).c_str());
  // Không fw
  TEST_ASSERT_EQUAL_STRING("{\"readings\":[],\"diag\":{\"sensor\":\"fault\",\"fault_s\":1200,\"rst\":\"brownout\",\"rssi\":-71,\"heap\":84000,\"up\":86400}}",
                           build(nullptr, nullptr, 0, &full).c_str());
}

static void test_no_diag_keeps_legacy_bytes() {
  const WireReading r{1800000000u, -1950};
  // Vector PROTOCOL.md: không diag => byte y hệt trước (kể cả khi truyền con trỏ null hoặc diag rỗng)
  TEST_ASSERT_EQUAL_STRING("{\"readings\":[{\"t\":1800000000,\"c\":-19.5}]}", build(nullptr, &r, 1, nullptr).c_str());
  const Diag empty;
  TEST_ASSERT_EQUAL_STRING("{\"readings\":[{\"t\":1800000000,\"c\":-19.5}]}", build(nullptr, &r, 1, &empty).c_str());
  char buf[1024];
  TEST_ASSERT_EQUAL_UINT(0, buildReadingsBody(buf, sizeof buf, "1", nullptr, 0, nullptr));   // rỗng mà không diag: không hợp lệ
  TEST_ASSERT_EQUAL_UINT(0, buildReadingsBody(buf, sizeof buf, "1", nullptr, 0, &empty));
}

static void test_diag_partial_clamp_and_validation() {
  Diag d;
  d.hasRssi = true; d.rssi = -200;
  TEST_ASSERT_EQUAL_STRING("{\"readings\":[],\"diag\":{\"rssi\":-120}}", build(nullptr, nullptr, 0, &d).c_str());
  d.rssi = 15;
  TEST_ASSERT_EQUAL_STRING("{\"readings\":[],\"diag\":{\"rssi\":0}}", build(nullptr, nullptr, 0, &d).c_str());
  d.rssi = -120;
  TEST_ASSERT_EQUAL_STRING("{\"readings\":[],\"diag\":{\"rssi\":-120}}", build(nullptr, nullptr, 0, &d).c_str());
  d.rssi = -2147483647 - 1;   // INT_MIN: không tràn khi đổi dấu
  TEST_ASSERT_EQUAL_STRING("{\"readings\":[],\"diag\":{\"rssi\":-120}}", build(nullptr, nullptr, 0, &d).c_str());
  Diag f;
  f.hasFaultS = true; f.faultS = 0xFFFFFFFFu;
  TEST_ASSERT_EQUAL_STRING("{\"readings\":[],\"diag\":{\"fault_s\":2147483648}}", build(nullptr, nullptr, 0, &f).c_str());
  // rst sai định dạng bị bỏ (không bao giờ phá JSON), khóa còn lại vẫn có
  for (const char* bad : {"has space", "quo\"te", "back\\slash", "brown-out", "\n", "tiếng"}) {
    Diag e;
    e.hasUp = true; e.up = 5;
    strncpy(e.rst, bad, 16);
    e.rst[16] = 0;
    const std::string b = build("1", nullptr, 0, &e);
    TEST_ASSERT_EQUAL_STRING("{\"fw\":\"1\",\"readings\":[],\"diag\":{\"up\":5}}", b.c_str());
  }
  Diag only;
  strcpy(only.rst, "A_b9");
  TEST_ASSERT_EQUAL_STRING("{\"readings\":[],\"diag\":{\"rst\":\"A_b9\"}}", build(nullptr, nullptr, 0, &only).c_str());
  strcpy(only.rst, "0123456789abcdef");   // đúng 16 ký tự
  TEST_ASSERT_EQUAL_STRING("{\"readings\":[],\"diag\":{\"rst\":\"0123456789abcdef\"}}", build(nullptr, nullptr, 0, &only).c_str());
  TEST_ASSERT_TRUE(isValidRstToken("poweron") && !isValidRstToken("") && !isValidRstToken(nullptr));
}

static void test_diag_body_size_and_bounds() {
  WireReading many[kMaxBatch];
  for (auto& r : many) r = WireReading{4294967295u, -5500};
  const Diag d = fullDiag();
  char buf[1024];
  const size_t len = buildReadingsBody(buf, sizeof buf, "1.10.100-rc1+build", many, kMaxBatch, &d);
  TEST_ASSERT_TRUE(len > 0 && len < DeviceClient::kBodyCap);       // 20 số đo + diag vẫn vừa bộ đệm dựng body
  for (size_t cap = 0; cap < len; cap += 7) {                        // cắt cụt ở mọi cỡ: không ghi lố, không thành công giả
    std::vector<char> b(cap + 8, 'Z');
    TEST_ASSERT_EQUAL_UINT(0, buildReadingsBody(b.data(), cap, "1.10.100-rc1+build", many, kMaxBatch, &d));
    for (size_t i = cap; i < b.size(); i++) TEST_ASSERT_EQUAL_CHAR('Z', b[i]);
  }
}

static void test_reset_reason_tokens() {
  // esp_reset_reason_t của ESP-IDF v4.4.7 (esp_system.h): UNKNOWN 0, POWERON 1, EXT 2, SW 3, PANIC 4, INT_WDT 5, TASK_WDT 6, WDT 7,
  // DEEPSLEEP 8, BROWNOUT 9, SDIO 10
  TEST_ASSERT_EQUAL_STRING("unknown", resetReasonToken(0));
  TEST_ASSERT_EQUAL_STRING("poweron", resetReasonToken(1));
  TEST_ASSERT_EQUAL_STRING("ext", resetReasonToken(2));
  TEST_ASSERT_EQUAL_STRING("sw", resetReasonToken(3));
  TEST_ASSERT_EQUAL_STRING("panic", resetReasonToken(4));
  TEST_ASSERT_EQUAL_STRING("wdt", resetReasonToken(5));
  TEST_ASSERT_EQUAL_STRING("wdt", resetReasonToken(6));
  TEST_ASSERT_EQUAL_STRING("wdt", resetReasonToken(7));
  TEST_ASSERT_EQUAL_STRING("deepsleep", resetReasonToken(8));
  TEST_ASSERT_EQUAL_STRING("brownout", resetReasonToken(9));
  TEST_ASSERT_EQUAL_STRING("sdio", resetReasonToken(10));
  for (int c = -5; c < 300; c++) TEST_ASSERT_TRUE(isValidRstToken(resetReasonToken(c)));   // mọi mã đều ra từ khóa hợp lệ
  TEST_ASSERT_EQUAL_STRING("unknown", resetReasonToken(77));
}

// ── Feature B: chính sách nhịp tim (mô phỏng vòng lặp main) ─────────────────

namespace {

struct ConstHw : IRandom { uint32_t next() override { return 0x1234u; } };

struct Sim {
  SoftCrypto crypto;
  FakeSeqStore flash;
  FakePlatform plat;
  FakeHttp http;
  uint8_t key[32];
  Signer* signer;
  SeqCounter* seq;
  DeviceClient* client;
  ReadingBuffer buf{1440};
  Thresholds th;
  ReadingsUploader* up;
  UploadPolicy policy{300000, 60000};
  ConstHw hw;
  RetryScheduler retry{hw};
  SensorWatch watch;

  bool probeOk = true;
  int heartbeats = 0, batches = 0;
  std::vector<uint32_t> heartbeatAtS;
  size_t maxBody = 0;

  Sim() {
    for (int i = 0; i < 32; i++) key[i] = static_cast<uint8_t>(i + 1);
    signer = new Signer(crypto, "AUH-000001", key);
    seq = new SeqCounter(flash);
    seq->begin();
    client = new DeviceClient(*signer, *seq, plat, http);
    up = new ReadingsUploader(*client, buf, th, plat, "1.0.0");
    plat.trusted = true;
    plat.unix_ = 1800000000u;
  }
  ~Sim() { delete up; delete client; delete seq; delete signer; }

  Diag diagNow() {
    Diag d;
    const uint32_t s = plat.mono;
    d.hasSensor = true; d.sensorFault = watch.faulty(s);
    d.hasFaultS = true; d.faultS = watch.secondsSinceValid(s);
    strcpy(d.rst, "poweron");
    d.hasRssi = true; d.rssi = -60;
    d.hasHeap = true; d.heap = 100000;
    d.hasUp = true; d.up = s;
    return d;
  }

  /// Một vòng lặp mô phỏng: `secondsPerTick` giây trôi qua; đo mỗi 60 s khi đầu dò tốt; logic gửi y như main.cpp.
  void tick(uint32_t secondsPerTick) {
    plat.mono += secondsPerTick;
    plat.unix_ += secondsPerTick;
    plat.ms += secondsPerTick * 1000;
    if (probeOk && plat.mono % 60 < secondsPerTick) { buf.push(Reading{plat.mono, -1900}); watch.onValidReading(plat.mono); }
    const bool want = !buf.empty() || watch.faulty(plat.mono);
    if (policy.poll(plat.ms, want) == UploadReason::None) return;
    up->setDiag(diagNow());
    FlushResult f;
    const size_t before = http.log.size();
    const bool wasBuffered = !buf.empty();
    f = wasBuffered ? up->flush() : up->heartbeat();
    for (size_t i = before; i < http.log.size(); i++) if (http.log[i].body.size() > maxBody) maxBody = http.log[i].body.size();
    if (!wasBuffered) { ++heartbeats; heartbeatAtS.push_back(plat.mono); } else ++batches;
    if (f.ok) { retry.reset(); if (f.remaining > 0) policy.onFailure(plat.ms, 2000); else policy.onSuccess(); }
    else policy.onFailure(plat.ms, retry.nextDelayMs(f.failClass));
  }
};

}  // namespace

static void test_heartbeat_starts_after_5_minutes_without_valid_reading() {
  Sim s;
  s.plat.mono = 1000; s.plat.ms = 1000000;
  s.watch.onValidReading(1000);
  s.probeOk = false;
  for (int i = 0; i < 29; i++) s.tick(10);           // 290 s sau số đo hợp lệ cuối: chưa lỗi
  TEST_ASSERT_EQUAL_INT(0, s.heartbeats);
  TEST_ASSERT_FALSE(s.watch.faulty(s.plat.mono));
  for (int i = 0; i < 3; i++) s.tick(10);
  TEST_ASSERT_TRUE(s.watch.faulty(s.plat.mono));
  TEST_ASSERT_EQUAL_INT(1, s.heartbeats);
  const std::string& b = s.http.log.back().body;
  TEST_ASSERT_TRUE(b.find("\"readings\":[]") != std::string::npos);
  TEST_ASSERT_TRUE(b.find("\"sensor\":\"fault\"") != std::string::npos);
  TEST_ASSERT_TRUE(b.find("\"fault_s\":") != std::string::npos);
  TEST_ASSERT_TRUE(s.buf.empty());
}

static void test_exactly_one_heartbeat_per_5_minute_window_over_hours() {
  Sim s;
  s.watch.onValidReading(0);
  s.probeOk = false;
  const size_t sizeBefore = s.buf.size();
  for (int i = 0; i < 6 * 360; i++) s.tick(10);      // 6 giờ, vòng lặp 10 s
  TEST_ASSERT_TRUE(s.heartbeats >= 6 * 12 - 2 && s.heartbeats <= 6 * 12);   // 12/giờ
  for (size_t i = 1; i < s.heartbeatAtS.size(); i++) {
    const uint32_t gap = s.heartbeatAtS[i] - s.heartbeatAtS[i - 1];
    TEST_ASSERT_TRUE(gap >= 300);                     // không bao giờ dồn: 2 gói trong một khoảng 5 phút
    TEST_ASSERT_TRUE(gap <= 310);                     // và không bỏ lỡ (chỉ lệch tối đa một nhịp vòng lặp)
  }
  // Rò rỉ/tăng trưởng: bộ đệm không đổi, kích thước body bị chặn, mọi body y hệt cấu trúc
  TEST_ASSERT_EQUAL_UINT(sizeBefore, s.buf.size());
  TEST_ASSERT_TRUE(s.maxBody < 200);
  TEST_ASSERT_EQUAL_INT(0, s.batches);
  TEST_ASSERT_EQUAL_UINT(static_cast<size_t>(s.heartbeats), s.http.log.size());
  TEST_ASSERT_TRUE(s.seq->last() <= static_cast<uint64_t>(s.heartbeats) + 2);   // mỗi nhịp tim đúng một seq
}

static void test_heartbeat_jitter_start_delay_bounds() {
  for (uint32_t jitter : {0u, 1u, 9999u, 19999u}) {   // trễ ngẫu nhiên 0..20 s sau khởi động
    Sim s;
    s.probeOk = false;
    s.policy.delayStart(s.plat.ms, jitter);
    uint32_t first = 0;
    for (int i = 0; i < 400 && first == 0; i++) { s.tick(1); if (s.heartbeats) first = s.plat.mono; }
    TEST_ASSERT_TRUE(first >= 300 && first <= 300 + 20);   // không sớm hơn 5 phút lỗi; trễ thêm tối đa jitter + 1 tick
  }
}

static void test_heartbeat_failures_back_off_and_do_not_hammer() {
  Sim s;
  s.probeOk = false;
  for (int i = 0; i < 400; i++) s.http.script.push_back({503, ""});   // server chết 2 giờ
  for (int i = 0; i < 720; i++) s.tick(10);                           // 2 giờ
  // Backoff nhanh 30 s→60→120→300 s (±20%): rất ít lần thử so với 720 vòng, không bao giờ dồn dập
  TEST_ASSERT_TRUE(s.heartbeats <= 30);
  for (size_t i = 1; i < s.heartbeatAtS.size(); i++) TEST_ASSERT_TRUE(s.heartbeatAtS[i] - s.heartbeatAtS[i - 1] >= 20);
  TEST_ASSERT_TRUE(s.buf.empty());
}

static void test_recovery_returns_to_normal_reporting_with_diag_ok() {
  Sim s;
  s.watch.onValidReading(0);
  s.probeOk = false;
  for (int i = 0; i < 360; i++) s.tick(10);           // 1 giờ lỗi
  const int hbBefore = s.heartbeats;
  TEST_ASSERT_TRUE(hbBefore > 5);
  s.probeOk = true;                                    // cắm lại đầu dò
  for (int i = 0; i < 360; i++) s.tick(10);           // 1 giờ bình thường
  TEST_ASSERT_TRUE(s.heartbeats <= hbBefore + 1);      // tối đa một nhịp tim nữa trong lúc nhận lại; sau đó không còn
  TEST_ASSERT_FALSE(s.watch.faulty(s.plat.mono));
  TEST_ASSERT_TRUE(s.batches >= 10);                   // gửi số đo bình thường mỗi 5 phút
  const std::string& b = s.http.log.back().body;
  TEST_ASSERT_TRUE(b.find("\"t\":") != std::string::npos);                  // có số đo
  TEST_ASSERT_TRUE(b.find("\"sensor\":\"ok\"") != std::string::npos);      // kèm diag ok
  TEST_ASSERT_TRUE(b.find("\"readings\":[]") == std::string::npos);
  // Không còn nhịp tim trong giờ cuối
  int lateHb = 0;
  for (uint32_t t : s.heartbeatAtS) if (t > s.plat.mono - 3000) ++lateHb;
  TEST_ASSERT_EQUAL_INT(0, lateHb);
}

static void test_buffered_readings_go_out_normally_before_heartbeats() {
  Sim s;
  s.watch.onValidReading(0);
  // Có sẵn số đo trong bộ đệm (vd. tích lũy lúc mất mạng) rồi đầu dò hỏng: gói số đo bình thường đi trước, mang diag
  for (int i = 0; i < 25; i++) s.buf.push(Reading{static_cast<uint32_t>(1000 + i * 60), -1900});
  s.plat.mono = 5000; s.plat.unix_ = 1800000000u + 5000; s.plat.ms = 5000000;
  s.watch.onValidReading(1000 + 24 * 60);
  s.probeOk = false;
  s.tick(1);
  TEST_ASSERT_EQUAL_INT(0, s.heartbeats);
  TEST_ASSERT_TRUE(s.buf.empty());                                            // đã gửi hết số đo
  TEST_ASSERT_TRUE(s.http.log[0].body.find("\"t\":") != std::string::npos);
  TEST_ASSERT_TRUE(s.http.log[0].body.find("\"diag\":") != std::string::npos);
}

static void test_heartbeat_never_touches_buffer_and_400_is_harmless() {
  Sim s;
  s.buf.push(Reading{s.plat.mono, -1900});     // vẫn có 1 số đo trong bộ đệm để chứng minh không bị đụng tới
  s.up->setDiag(s.diagNow());
  s.http.script.push_back({400, "{\"error\":\"bad_request\"}"});
  FlushResult f = s.up->heartbeat();
  TEST_ASSERT_FALSE(f.ok);
  TEST_ASSERT_EQUAL(FailClass::Persistent, f.failClass);
  TEST_ASSERT_EQUAL_UINT(1, s.http.log.size());     // đúng MỘT request, không chia đôi, không lặp
  TEST_ASSERT_EQUAL_UINT(1, s.buf.size());          // không bỏ gì
  TEST_ASSERT_EQUAL_UINT(0, f.discardedReadings);
  s.http.script.push_back({413, "{\"error\":\"too_large\"}"});
  f = s.up->heartbeat();
  TEST_ASSERT_FALSE(f.ok);
  TEST_ASSERT_EQUAL_UINT(2, s.http.log.size());
  TEST_ASSERT_EQUAL_UINT(1, s.buf.size());
  // Thành công: đếm là đã liên lạc server, phản hồi mang ngưỡng được nhận
  s.http.script.push_back({200, "{\"ok\":true,\"accepted\":0,\"server_time\":1800000000,\"config\":{\"min_c\":2,\"max_c\":8}}"});
  f = s.up->heartbeat();
  TEST_ASSERT_TRUE(f.ok && f.reachedServer);
  TEST_ASSERT_TRUE(f.thresholdsChanged);
  TEST_ASSERT_EQUAL_INT16(800, s.th.maxCenti);
}

static void test_heartbeat_requires_diag_and_clock() {
  Sim s;
  FlushResult f = s.up->heartbeat();               // chưa setDiag: không gửi gì (body rỗng không hợp lệ)
  TEST_ASSERT_FALSE(f.ok);
  TEST_ASSERT_EQUAL_UINT(0, s.http.log.size());
  s.up->setDiag(s.diagNow());
  s.plat.trusted = false;
  f = s.up->heartbeat();
  TEST_ASSERT_TRUE(f.clockNotReady);
  TEST_ASSERT_EQUAL_UINT(0, s.http.log.size());
  s.plat.trusted = true;
  s.up->clearDiag();
  f = s.up->heartbeat();
  TEST_ASSERT_FALSE(f.ok);
  TEST_ASSERT_EQUAL_UINT(0, s.http.log.size());
}

static void test_diag_rejection_retries_same_batch_without_diag_and_drops_nothing() {
  Sim s;
  for (int i = 0; i < 5; i++) s.buf.push(Reading{static_cast<uint32_t>(s.plat.mono + i), -1900});
  s.plat.mono += 10;
  s.up->setDiag(s.diagNow());
  s.http.script.push_back({400, "{\"error\":\"bad_request\"}"});   // server (cũ/khắt khe) từ chối vì diag
  const FlushResult f = s.up->flush();
  TEST_ASSERT_TRUE(f.ok);
  TEST_ASSERT_EQUAL_UINT(0, f.discardedReadings);
  TEST_ASSERT_EQUAL_UINT(5, f.sentReadings);
  TEST_ASSERT_TRUE(s.buf.empty());
  TEST_ASSERT_EQUAL_UINT(2, s.http.log.size());                     // gói y hệt, lần hai không có diag: KHÔNG chia đôi
  TEST_ASSERT_TRUE(s.http.log[0].body.find("\"diag\"") != std::string::npos);
  TEST_ASSERT_TRUE(s.http.log[1].body.find("\"diag\"") == std::string::npos);
  TEST_ASSERT_TRUE(s.http.log[1].body.find("\"t\":") != std::string::npos);
}

static void test_sensor_watch_wraps_and_boot_baseline() {
  SensorWatch w;
  TEST_ASSERT_FALSE(w.faulty(299));                  // đầu dò hỏng từ lúc khởi động: lỗi sau 5 phút
  TEST_ASSERT_TRUE(w.faulty(300));
  w.onValidReading(0xFFFFFF00u);
  TEST_ASSERT_FALSE(w.faulty(0xFFFFFF00u + 299));
  TEST_ASSERT_TRUE(w.faulty(0xFFFFFF00u + 300));     // qua mốc tràn 32 bit
  TEST_ASSERT_EQUAL_UINT32(300, w.secondsSinceValid(44));
}

void run_ap_diag_tests() {
  RUN_TEST(test_ap_password_matches_protocol_vector);
  RUN_TEST(test_ap_password_alphabet_length_and_wpa2_validity);
  RUN_TEST(test_ap_ssid_defensive);
  RUN_TEST(test_diag_exact_bytes);
  RUN_TEST(test_no_diag_keeps_legacy_bytes);
  RUN_TEST(test_diag_partial_clamp_and_validation);
  RUN_TEST(test_diag_body_size_and_bounds);
  RUN_TEST(test_reset_reason_tokens);
  RUN_TEST(test_heartbeat_starts_after_5_minutes_without_valid_reading);
  RUN_TEST(test_exactly_one_heartbeat_per_5_minute_window_over_hours);
  RUN_TEST(test_heartbeat_jitter_start_delay_bounds);
  RUN_TEST(test_heartbeat_failures_back_off_and_do_not_hammer);
  RUN_TEST(test_recovery_returns_to_normal_reporting_with_diag_ok);
  RUN_TEST(test_buffered_readings_go_out_normally_before_heartbeats);
  RUN_TEST(test_heartbeat_never_touches_buffer_and_400_is_harmless);
  RUN_TEST(test_heartbeat_requires_diag_and_clock);
  RUN_TEST(test_diag_rejection_retries_same_batch_without_diag_and_drops_nothing);
  RUN_TEST(test_sensor_watch_wraps_and_boot_baseline);
}
