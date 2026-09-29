// Kịch bản thực tế ghép nhiều thành phần lõi: mất điện rồi có điện lại (số đo trước NTP), NTP nhảy giờ,
// tồn đọng sau mất mạng dài, rollover 32 bit, tuổi thọ NVS, thundering herd, phân loại phản hồi.
#include <unity.h>

#include <cmath>
#include <set>
#include <string>

#include "auhono/backoff.h"
#include "auhono/button.h"
#include "auhono/device_client.h"
#include "auhono/hex.h"
#include "auhono/jitter_random.h"
#include "auhono/plausibility.h"
#include "auhono/readings.h"
#include "auhono/retry_policy.h"
#include "auhono/seq_counter.h"
#include "auhono/time_policy.h"
#include "auhono/upload_policy.h"
#include "auhono/uploader.h"
#include "fakes.h"
#include "soft_crypto.h"

using namespace auhono;

namespace {

struct Rig {
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

  Rig() {
    for (int i = 0; i < 32; i++) key[i] = static_cast<uint8_t>(i + 1);
    signer = new Signer(crypto, "AUH-000001", key);
    seq = new SeqCounter(flash);
    seq->begin();
    client = new DeviceClient(*signer, *seq, plat, http);
    up = new ReadingsUploader(*client, buf, th, plat, "1.0.0");
  }
  ~Rig() { delete up; delete client; delete seq; delete signer; }
};

/// Lấy mọi giá trị "t" trong các body đã gửi, theo thứ tự.
std::vector<uint32_t> sentTimes(const FakeHttp& http) {
  std::vector<uint32_t> out;
  for (const auto& rec : http.log) {
    size_t pos = 0;
    while ((pos = rec.body.find("\"t\":", pos)) != std::string::npos) {
      pos += 4;
      out.push_back(static_cast<uint32_t>(std::stoull(rec.body.substr(pos))));
    }
  }
  return out;
}

}  // namespace

// ── 1. Mất điện, có điện lại: router chậm, NTP chưa có, số đo đầu tiên là quan trọng nhất ─────────────────

static void test_readings_before_time_are_backdated_when_clock_arrives() {
  Rig r;
  r.plat.trusted = false;
  r.plat.unix_ = 0;
  // Boot ở mono 0; đo mỗi 60 s, 6 số đo (t = 1, 61, ..., 301) trong lúc router chưa cấp Wi-Fi/NTP.
  for (uint32_t i = 0; i < 6; i++) r.buf.push(Reading{1 + i * 60, static_cast<int16_t>(-1500 - 10 * static_cast<int>(i))});
  // Chưa có giờ: KHÔNG gửi gì và KHÔNG mất số đo nào.
  r.plat.mono = 310;
  FlushResult f = r.up->flush();
  TEST_ASSERT_FALSE(f.ok);
  TEST_ASSERT_TRUE(f.clockNotReady);
  TEST_ASSERT_EQUAL_UINT(0, r.http.log.size());
  TEST_ASSERT_EQUAL_UINT(6, r.buf.size());
  // NTP về ở mono 320 với giờ 1800000000
  r.plat.mono = 320;
  r.plat.setUnix(1800000000u);
  f = r.up->flush();
  TEST_ASSERT_TRUE(f.ok);
  TEST_ASSERT_EQUAL_UINT(6, f.sentReadings);
  const std::vector<uint32_t> t = sentTimes(r.http);
  TEST_ASSERT_EQUAL_UINT(6, t.size());
  // số đo mono=1 cách "bây giờ" 319 s -> unix 1799999681; các số sau cách nhau đúng 60 s
  TEST_ASSERT_EQUAL_UINT32(1800000000u - 319, t[0]);
  for (size_t i = 1; i < t.size(); i++) TEST_ASSERT_EQUAL_UINT32(60, t[i] - t[i - 1]);
  // và số đo ĐẦU TIÊN (quan trọng nhất) có mặt trong body
  TEST_ASSERT_TRUE(r.http.log[0].body.find("\"c\":-15.0") != std::string::npos);
}

static void test_clock_step_mid_run_keeps_order_and_spacing() {
  Rig r;
  // NTP đầu tiên trả giờ SAI một chút (+1 giờ), rồi được chỉnh lại giữa chừng (bước nhảy -3600 s).
  r.plat.mono = 1000;
  r.plat.setUnix(1800003600u);
  for (uint32_t i = 0; i < 5; i++) r.buf.push(Reading{100 + i * 60, -1900});
  // Chưa kịp gửi thì đồng hồ được chỉnh về giờ đúng
  r.plat.unix_ = 1800000000u;
  const FlushResult f = r.up->flush();
  TEST_ASSERT_TRUE(f.ok);
  const std::vector<uint32_t> t = sentTimes(r.http);
  TEST_ASSERT_EQUAL_UINT(5, t.size());
  // Số đo mono=100 cách bây giờ 900 s: theo đồng hồ MỚI (đúng), không dính bước nhảy
  TEST_ASSERT_EQUAL_UINT32(1800000000u - 900, t[0]);
  for (size_t i = 1; i < t.size(); i++) TEST_ASSERT_TRUE(t[i] > t[i - 1]);  // thứ tự đơn điệu tuyệt đối
}

static void test_wrong_year_clock_is_never_used() {
  Rig r;
  r.plat.trusted = true;   // NTP "báo" đồng bộ nhưng trả năm 2010 (server NTP rác)
  r.plat.unix_ = 1262304000u;
  r.plat.mono = 500;
  r.buf.push(Reading{10, -1800});
  const FlushResult f = r.up->flush();
  TEST_ASSERT_FALSE(f.ok);
  TEST_ASSERT_TRUE(f.clockNotReady);
  TEST_ASSERT_EQUAL_UINT(0, r.http.log.size());
  TEST_ASSERT_EQUAL_UINT(1, r.buf.size());
  TEST_ASSERT_FALSE(isPlausibleUnix(1262304000u));
  TEST_ASSERT_FALSE(isPlausibleUnix(4102444800ULL));  // năm 2100 trở đi cũng bị loại
}

static void test_monotonic_to_unix_edge_cases() {
  uint32_t u = 0;
  const TimeAnchor a{1800000000u, 1000};
  TEST_ASSERT_TRUE(monoToUnix(1000, a, u));
  TEST_ASSERT_EQUAL_UINT32(1800000000u, u);
  TEST_ASSERT_TRUE(monoToUnix(0, a, u));
  TEST_ASSERT_EQUAL_UINT32(1800000000u - 1000, u);
  TEST_ASSERT_FALSE(monoToUnix(1001, a, u));              // "ở tương lai": không thể
  TEST_ASSERT_FALSE(monoToUnix(0, TimeAnchor{5, 1000}, u));       // anchor chưa hợp lý
  TEST_ASSERT_FALSE(monoToUnix(0, TimeAnchor{kMinValidUnix + 10, 1000000}, u));  // kết quả trước 2025
}

// ── Mất mạng dài: tồn đọng ────────────────────────────────────────────────

static void test_long_outage_drops_only_expired_and_counts_them() {
  Rig r;
  r.plat.mono = 40 * 3600;  // chạy 40 giờ; buffer đầy 24 giờ gần nhất (1440 số đo) nhưng mạng mất suốt
  r.plat.setUnix(1800000000u);
  for (uint32_t i = 0; i < 1440; i++) r.buf.push(Reading{40 * 3600 - (1440 - i) * 60, -1900});
  // Thêm vài số đo "quá cũ" (26-30 giờ trước) bị ghi đè bởi ring? -> ring giữ 1440 gần nhất, nên tự đẩy ra.
  const FlushResult f = r.up->flush();
  TEST_ASSERT_TRUE(f.ok || f.remaining > 0);
  // 24 giờ trừ biên 6 phút: những số đo cũ hơn 23h54' bị bỏ TRƯỚC khi gửi (server cũng sẽ bỏ)
  // (các số đo cách bây giờ 1440..1435 phút = 86400..86100 s > 86040 s => đúng 6 số đo bị bỏ)
  TEST_ASSERT_EQUAL_UINT(6, f.staleDropped);
  for (uint32_t t : sentTimes(r.http)) {
    TEST_ASSERT_TRUE(t <= 1800000000u);                                 // không bao giờ ở tương lai
    TEST_ASSERT_TRUE(1800000000u - t <= ReadingsUploader::kMaxAgeSeconds); // không bao giờ quá 24 giờ
  }
}

static void test_no_bulk_send_of_future_or_over_24h() {
  Rig r;
  r.plat.mono = 100000;
  r.plat.setUnix(1800000000u);
  r.buf.push(Reading{100000 - 90000, -1900});   // 25 giờ trước
  r.buf.push(Reading{100000 - 86400, -1900});   // đúng 24 giờ (sát mốc, trong biên 6 phút -> bỏ)
  r.buf.push(Reading{100000 - 86000, -1900});   // 23h53': trong cửa sổ (86000 < 86400 - 360 = 86040)
  r.buf.push(Reading{100000, -1900});           // bây giờ
  const FlushResult f = r.up->flush();
  TEST_ASSERT_EQUAL_UINT(2, f.staleDropped);
  TEST_ASSERT_EQUAL_UINT(2, f.sentReadings);
  const std::vector<uint32_t> t = sentTimes(r.http);
  TEST_ASSERT_EQUAL_UINT32(1800000000u - 86000, t[0]);
  TEST_ASSERT_EQUAL_UINT32(1800000000u, t[1]);
}

static void test_flush_time_budget_limits_blocking() {
  Rig r;
  r.plat.mono = 50000;
  r.plat.setUnix(1800000000u);
  for (uint32_t i = 0; i < 400; i++) r.buf.push(Reading{50000 - 400 * 60 + i * 60, -1900});
  // Mỗi request "tốn" 8 s trên đồng hồ giả: ngân sách 20 s => tối đa ~3 request rồi trả quyền cho vòng lặp chính
  struct SlowHttp : IHttp {
    FakePlatform* plat; FakeHttp* inner;
    HttpResponse perform(const HttpRequest& req) override { plat->ms += 8000; return inner->perform(req); }
  } slow;
  slow.plat = &r.plat; slow.inner = &r.http;
  DeviceClient client(*r.signer, *r.seq, r.plat, slow);
  ReadingsUploader up(client, r.buf, r.th, r.plat, "1.0.0");
  const FlushResult f = up.flush();
  TEST_ASSERT_TRUE(f.ok);
  TEST_ASSERT_TRUE(r.http.log.size() <= 3);
  TEST_ASSERT_TRUE(f.remaining > 0);   // còn tồn: main gọi lại sau ít giây
}

static void test_flush_is_bounded_per_call_and_eventually_drains() {
  Rig r;
  r.plat.mono = 200000;
  r.plat.setUnix(1800000000u);
  for (uint32_t i = 0; i < 1440; i++) r.buf.push(Reading{200000 - (1440 - i) * 60, -1900});
  int calls = 0;
  while (!r.buf.empty() && calls < 100) {
    const FlushResult f = r.up->flush();
    TEST_ASSERT_TRUE(f.ok);
    TEST_ASSERT_TRUE(r.http.log.size() <= static_cast<size_t>(calls + 1) * ReadingsUploader::kMaxBatchesPerFlush);
    ++calls;
  }
  TEST_ASSERT_TRUE(r.buf.empty());
  TEST_ASSERT_TRUE(calls >= 12);   // 72 gói / 6 mỗi lần: không một lần flush nào chặn cả phút
}

// ── 4. millis() tràn (49,7 ngày) ───────────────────────────────────────────

static void test_deadline_helper_across_millis_rollover() {
  // mốc đặt trước lúc tràn (0xFFFFFFF0 + 60 s), so sánh trước/sau lúc tràn
  const uint32_t deadline = 0xFFFFFFF0u + 60000u;   // = 59984 sau khi quấn
  TEST_ASSERT_FALSE(auhono::reached(0xFFFFFFF0u, deadline));
  TEST_ASSERT_FALSE(auhono::reached(10, deadline));
  TEST_ASSERT_FALSE(auhono::reached(59983, deadline));
  TEST_ASSERT_TRUE(auhono::reached(59984, deadline));
  TEST_ASSERT_TRUE(auhono::reached(70000, deadline));
  // mốc lệch xa hơn 2^31 ms trở đi thì đảo nghĩa: đó là giới hạn được ghi lại; không mốc nào của firmware dài quá 6 giờ
  TEST_ASSERT_FALSE(auhono::reached(0x80000000u + 1, 0));
  TEST_ASSERT_TRUE(auhono::reached(0x7FFFFFFFu, 0));
  TEST_ASSERT_TRUE(6ull * 3600 * 1000 < 0x7FFFFFFFull);
}

static void test_button_gesture_across_millis_rollover() {
  ButtonGesture b;
  b.update(false, 0xFFFFF000u);
  b.update(true, 0xFFFFF800u);
  TEST_ASSERT_EQUAL(ButtonEvent::None, b.update(true, 0xFFFFF800u + 4999));
  TEST_ASSERT_EQUAL(ButtonEvent::LongPress, b.update(true, 0xFFFFF800u + 5000));   // qua mốc tràn: vẫn đúng 5 s
  TEST_ASSERT_EQUAL(ButtonEvent::None, b.update(true, 0xFFFFF800u + 16000));
  TEST_ASSERT_TRUE(b.wipeArmed());
  TEST_ASSERT_EQUAL(ButtonEvent::VeryLongPress, b.update(false, 0xFFFFF800u + 17000));
}

static void test_upload_policy_start_delay_and_wraparound() {
  UploadPolicy p(300000, 60000);
  const uint32_t t0 = 0xFFFFF000u;             // gần mốc tràn 32 bit
  p.delayStart(t0, 15000);                     // trễ ngẫu nhiên 15 s: mốc rơi SAU khi tràn
  TEST_ASSERT_EQUAL(UploadReason::None, p.poll(t0, true));
  TEST_ASSERT_EQUAL(UploadReason::None, p.poll(t0 + 14999, true));
  TEST_ASSERT_TRUE(p.startDelayPending(t0 + 14999));
  TEST_ASSERT_EQUAL(UploadReason::Periodic, p.poll(t0 + 15000, true));  // qua mốc tràn vẫn đúng
  TEST_ASSERT_EQUAL(UploadReason::None, p.poll(t0 + 15000 + 299999, true));
  TEST_ASSERT_EQUAL(UploadReason::Periodic, p.poll(t0 + 15000 + 300000, true));
}

static void test_start_delay_gates_immediate_breach_too() {
  UploadPolicy p;
  p.delayStart(1000, 10000);
  p.noteReading(true);
  TEST_ASSERT_EQUAL(UploadReason::None, p.poll(5000, true));
  TEST_ASSERT_EQUAL(UploadReason::Periodic, p.poll(11000, true));   // gói định kỳ đầu tiên mang cả số đo vượt ngưỡng
}

// ── 8. Thundering herd ─────────────────────────────────────────────────────

namespace {
struct ConstHw : IRandom { uint32_t next() override { return 0x12345678u; } };
}

static void test_thundering_herd_devices_get_different_delays_even_with_identical_hw_rng() {
  std::set<uint32_t> firstUploadDelays;
  std::set<uint32_t> firstBackoffs;
  for (int i = 1; i <= 30; i++) {
    char id[16];
    snprintf(id, sizeof id, "AUH-%06d", i);
    ConstHw hw;  // trước khi bật Wi-Fi, esp_random() có thể giống nhau giữa các máy
    const uint32_t seed = fnv1a32(reinterpret_cast<const uint8_t*>(id), strlen(id), fnv1a32(reinterpret_cast<const uint8_t*>("\x11\x22\x33\x44\x55\x66"), 6));
    MixedRandom rng(hw, seed);
    firstUploadDelays.insert(rng.next() % 20000);
    Backoff b(rng);
    firstBackoffs.insert(b.nextDelayMs());
  }
  // 30 máy khởi động cùng lúc: hầu như không máy nào trùng mốc
  TEST_ASSERT_TRUE(firstUploadDelays.size() >= 28);
  TEST_ASSERT_TRUE(firstBackoffs.size() >= 25);
}

static void test_mixed_random_never_stuck_and_uses_hw() {
  ConstHw hw;
  MixedRandom rng(hw, 0);   // seed 0 không được làm xorshift kẹt ở 0
  std::set<uint32_t> seen;
  for (int i = 0; i < 100; i++) seen.insert(rng.next());
  TEST_ASSERT_TRUE(seen.size() >= 99);
}

// ── 2/5 năm: mòn NVS ───────────────────────────────────────────────────────

static void test_five_years_of_requests_and_boots_wear_budget() {
  FakeSeqStore flash;
  uint64_t requests = 0, boots = 0;
  uint64_t maxSeq = 0;
  // 5 năm x 365 ngày: 288 request/ngày (chu kỳ 5 phút), 3 lần khởi động/ngày (chập chờn điện)
  for (int day = 0; day < 1825; day++) {
    for (int b = 0; b < 3; b++) {
      SeqCounter seq(flash, 64);
      seq.begin();
      ++boots;
      const int perBoot = 288 / 3;
      for (int i = 0; i < perBoot; i++) { maxSeq = seq.next(); ++requests; }
    }
  }
  // Ngân sách ghi: ~1 lần / 64 request + 1 lần / lần khởi động
  TEST_ASSERT_TRUE(static_cast<uint64_t>(flash.saves) <= requests / 64 + boots * 2);
  // Mỗi lần ghi NVS tốn 1/126 lần xóa trang; 4 trang khả dụng, chịu ~100k chu kỳ xóa mỗi sector.
  const double eraseCyclesPerSector = flash.saves / 126.0 / 4.0;
  TEST_ASSERT_TRUE(eraseCyclesPerSector < 1000.0);
  TEST_ASSERT_TRUE(maxSeq < SeqCounter::kMaxSeq);               // xa mức tràn số nguyên an toàn của JS
  TEST_ASSERT_TRUE(maxSeq > requests);                          // luôn tăng nghiêm ngặt
}

static void test_reboot_storm_without_uploads_writes_nothing() {
  // Vòng khởi động lại vì brownout (cục sạc yếu) mà chưa kịp gửi request nào: KHÔNG được ghi flash lần nào.
  FakeSeqStore flash;
  for (int i = 0; i < 5000; i++) { SeqCounter seq(flash, 64); seq.begin(); }
  TEST_ASSERT_EQUAL_INT(0, flash.saves);
  // Nếu mỗi lần khởi động đều kịp gửi 1 request: đúng 1 lần ghi/lần khởi động, không hơn.
  FakeSeqStore flash2;
  uint64_t last = 0;
  for (int i = 0; i < 5000; i++) {
    SeqCounter seq(flash2, 64);
    seq.begin();
    const uint64_t s = seq.next();
    TEST_ASSERT_TRUE(s > last);
    last = s;
  }
  TEST_ASSERT_EQUAL_INT(5000, flash2.saves);
}

// ── 14. Phản hồi của server: nhịp thử lại ──────────────────────────────────

static ServerReply reply(ReplyKind k, int status) {
  ServerReply r;
  r.kind = k;
  r.status = status;
  return r;
}

static void test_failure_classification() {
  TEST_ASSERT_EQUAL(FailClass::None, classifyFailure(reply(ReplyKind::Ok, 200)));
  TEST_ASSERT_EQUAL(FailClass::Transient, classifyFailure(reply(ReplyKind::NetworkError, -1)));
  TEST_ASSERT_EQUAL(FailClass::Transient, classifyFailure(reply(ReplyKind::ServerError, 503)));
  TEST_ASSERT_EQUAL(FailClass::Transient, classifyFailure(reply(ReplyKind::ServerError, 522)));  // Cloudflare
  TEST_ASSERT_EQUAL(FailClass::Persistent, classifyFailure(reply(ReplyKind::Unauthorized, 401)));
  TEST_ASSERT_EQUAL(FailClass::Persistent, classifyFailure(reply(ReplyKind::RateLimited, 429)));
  TEST_ASSERT_EQUAL(FailClass::Persistent, classifyFailure(reply(ReplyKind::Unknown, 403)));
  TEST_ASSERT_EQUAL(FailClass::Persistent, classifyFailure(reply(ReplyKind::Unknown, 302)));
  TEST_ASSERT_EQUAL(FailClass::Persistent, classifyFailure(reply(ReplyKind::Unknown, 404)));
  // 200 nhưng không phải JSON của ta = trang đăng nhập Wi-Fi công cộng: thử lại nhanh (người dùng có thể vừa đăng nhập)
  TEST_ASSERT_EQUAL(FailClass::Transient, classifyFailure(reply(ReplyKind::Unknown, 200)));
}

static void test_persistent_failures_back_off_up_to_one_hour_transient_up_to_five_minutes() {
  ConstHw hw;
  RetryScheduler rs(hw);
  uint32_t last = 0;
  for (int i = 0; i < 10; i++) last = rs.nextDelayMs(FailClass::Persistent);
  TEST_ASSERT_TRUE(last >= 3600000u * 8 / 10 && last <= 3600000u * 12 / 10);      // ~1 giờ
  for (int i = 0; i < 10; i++) last = rs.nextDelayMs(FailClass::Transient);
  TEST_ASSERT_TRUE(last <= 300000u * 12 / 10);                                     // không quá 5 phút
  // Bậc chậm đầu tiên đã là >= 4 phút: 401 vĩnh viễn không bao giờ gõ cửa dồn dập
  RetryScheduler rs2(hw);
  TEST_ASSERT_TRUE(rs2.nextDelayMs(FailClass::Persistent) >= 240000u);
  // Thành công quay về bậc đầu
  rs.reset();
  TEST_ASSERT_TRUE(rs.nextDelayMs(FailClass::Transient) <= 36000u);
}

static void test_401_forever_hourly_request_count() {
  // 401 vĩnh viễn (thiết bị bị thu hồi): mô phỏng 24 giờ, đếm số lần thử. Phải rất ít.
  ConstHw hw;
  RetryScheduler rs(hw);
  uint64_t t = 0;
  int attempts = 0;
  while (t < 24ull * 3600 * 1000) {
    ++attempts;
    t += rs.nextDelayMs(FailClass::Persistent);
  }
  TEST_ASSERT_TRUE(attempts <= 30);   // ~5+10+20+30 phút rồi mỗi giờ: ~26 lần/ngày
}

static void test_429_reply_is_rate_limited_kind() {
  const ServerReply r = parseReply(429, "<html>error code: 1015</html>", 29);
  TEST_ASSERT_EQUAL(ReplyKind::RateLimited, r.kind);
  TEST_ASSERT_EQUAL(FailClass::Persistent, classifyFailure(r));
  // HTML, gzip nhị phân, cắt cụt: không bao giờ là Ok
  const char gz[] = {0x1f, static_cast<char>(0x8b), 0x08, 0x00, 0x00};
  TEST_ASSERT_TRUE(parseReply(200, gz, sizeof gz).kind != ReplyKind::Ok);
  TEST_ASSERT_TRUE(parseReply(200, "{\"ok\":true,\"accepted\":", 22).kind != ReplyKind::Ok);   // cụt
  TEST_ASSERT_EQUAL(ReplyKind::ServerError, parseReply(522, "", 0).kind);
  TEST_ASSERT_EQUAL(ReplyKind::Unknown, parseReply(302, "", 0).kind);
}

static void test_client_builder_called_per_attempt_and_stops_on_empty_body() {
  Rig r;
  r.plat.trusted = true;
  r.plat.unix_ = 1800000000u;
  r.http.script.push_back({409, "{\"error\":\"replay\",\"last_seq\":7}"});
  struct Src : IBodySource {
    int calls = 0;
    size_t build(char* out, size_t cap) override { ++calls; return static_cast<size_t>(snprintf(out, cap, "{\"n\":%d}", calls)); }
  } src;
  const ServerReply rep = r.client->callBuilt("POST", "/v1/readings", src);
  (void)rep;
  TEST_ASSERT_EQUAL_INT(2, src.calls);                       // dựng lại ở mỗi lần thử
  TEST_ASSERT_EQUAL_STRING("{\"n\":1}", r.http.log[0].body.c_str());
  TEST_ASSERT_EQUAL_STRING("{\"n\":2}", r.http.log[1].body.c_str());
  struct Empty : IBodySource { size_t build(char*, size_t) override { return 0; } } empty;
  const size_t before = r.http.log.size();
  r.client->callBuilt("POST", "/v1/readings", empty);
  TEST_ASSERT_EQUAL_UINT(before, r.http.log.size());          // không dựng được body: không gửi gì
}

static void test_untrusted_channel_must_not_set_the_clock() {
  // OTA cứu hộ chạy không xác thực chứng chỉ: phản hồi (dù là 200 mang server_time hay 401 clock_skew) không được đổi giờ.
  Rig r;
  r.plat.trusted = true;
  r.plat.unix_ = 1800000000u;
  r.client->setAllowClockAdopt(false);
  const char body[] = "{}";
  r.http.script.push_back({200, okBody(1, 1900000000ULL)});
  r.client->call("POST", "/v1/readings", reinterpret_cast<const uint8_t*>(body), 2);
  TEST_ASSERT_EQUAL_UINT32(1800000000u, r.plat.unix_);
  r.http.script.push_back({401, "{\"error\":\"clock_skew\",\"server_time\":1700000000}"});
  const ServerReply rep = r.client->call("POST", "/v1/readings", reinterpret_cast<const uint8_t*>(body), 2);
  TEST_ASSERT_EQUAL(ReplyKind::ClockSkew, rep.kind);
  TEST_ASSERT_EQUAL_UINT32(1800000000u, r.plat.unix_);
  TEST_ASSERT_EQUAL_INT(0, r.plat.setUnixCalls);
  // Kênh bình thường (mặc định) vẫn được chỉnh giờ
  r.client->setAllowClockAdopt(true);
  r.http.script.push_back({401, "{\"error\":\"clock_skew\",\"server_time\":1800000500}"});
  r.http.script.push_back({200, okBody(1, 1800000500ULL)});
  r.client->call("POST", "/v1/readings", reinterpret_cast<const uint8_t*>(body), 2);
  TEST_ASSERT_EQUAL_UINT32(1800000500u, r.plat.unix_);
}

void run_scenario_tests() {
  RUN_TEST(test_readings_before_time_are_backdated_when_clock_arrives);
  RUN_TEST(test_clock_step_mid_run_keeps_order_and_spacing);
  RUN_TEST(test_wrong_year_clock_is_never_used);
  RUN_TEST(test_monotonic_to_unix_edge_cases);
  RUN_TEST(test_long_outage_drops_only_expired_and_counts_them);
  RUN_TEST(test_no_bulk_send_of_future_or_over_24h);
  RUN_TEST(test_flush_time_budget_limits_blocking);
  RUN_TEST(test_flush_is_bounded_per_call_and_eventually_drains);
  RUN_TEST(test_deadline_helper_across_millis_rollover);
  RUN_TEST(test_button_gesture_across_millis_rollover);
  RUN_TEST(test_upload_policy_start_delay_and_wraparound);
  RUN_TEST(test_start_delay_gates_immediate_breach_too);
  RUN_TEST(test_thundering_herd_devices_get_different_delays_even_with_identical_hw_rng);
  RUN_TEST(test_mixed_random_never_stuck_and_uses_hw);
  RUN_TEST(test_five_years_of_requests_and_boots_wear_budget);
  RUN_TEST(test_reboot_storm_without_uploads_writes_nothing);
  RUN_TEST(test_failure_classification);
  RUN_TEST(test_persistent_failures_back_off_up_to_one_hour_transient_up_to_five_minutes);
  RUN_TEST(test_401_forever_hourly_request_count);
  RUN_TEST(test_429_reply_is_rate_limited_kind);
  RUN_TEST(test_client_builder_called_per_attempt_and_stops_on_empty_body);
  RUN_TEST(test_untrusted_channel_must_not_set_the_clock);
}
