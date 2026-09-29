// Fuzz nhẹ (chạy dưới ASan/UBSan): bộ quét JSON, phân tích phản hồi/manifest OTA, bộ đệm vòng (so với mô hình đơn giản),
// định dạng body. Không được crash/tràn/UB với bất kỳ đầu vào nào.
#include <unity.h>

#include <deque>
#include <random>
#include <string>

#include "auhono/json_scan.h"
#include "auhono/ota_policy.h"
#include "auhono/readings.h"
#include "auhono/server_reply.h"

using namespace auhono;

static std::string mutate(std::mt19937& rng, std::string s) {
  const int muts = 1 + static_cast<int>(rng() % 8);
  for (int m = 0; m < muts && !s.empty(); m++) {
    const size_t pos = rng() % s.size();
    switch (rng() % 4) {
      case 0: s[pos] = static_cast<char>(rng()); break;
      case 1: s.erase(pos, 1 + rng() % 5); break;
      case 2: s.insert(pos, std::string(1 + rng() % 3, "{}[]\":,\\/ 0-9"[rng() % 13])); break;
      default: s.resize(pos); break;   // cắt cụt
    }
  }
  return s;
}

static void test_fuzz_json_and_reply_parsers() {
  std::mt19937 rng(2024);
  const std::string okJson = "{\"ok\":true,\"accepted\":5,\"server_time\":1800000004,\"config\":{\"min_c\":-40,\"max_c\":-18.5}}";
  const std::string skew = "{\"error\":\"clock_skew\",\"server_time\":1800000000}";
  const std::string ota = "{\"update\":true,\"version\":\"1.0.1\",\"url\":\"https://x.example/fw.bin\",\"sha256\":\"" + std::string(64, 'a') +
                          "\",\"signature\":\"" + std::string(140, 'b') + "\"}";
  const std::string seeds[] = {okJson, skew, ota, "{\"a\":{\"b\":[1,2,{\"c\":\"}\"}]},\"d\":\"\\u00e1\\\"\"}"};
  for (int iter = 0; iter < 60000; iter++) {
    std::string s;
    if (iter % 5 == 0) {
      s.resize(rng() % 200);
      for (auto& c : s) c = static_cast<char>(rng());
    } else {
      s = mutate(rng, seeds[rng() % 4]);
    }
    JsonObject j(s.data(), s.size());
    if (j.valid()) {
      std::string str; bool b; uint64_t u; int32_t c; JsonObject sub("", 0);
      j.getString("error", str); j.getBool("ok", b); j.getUInt("server_time", u); j.getCenti("min_c", c); j.getObject("config", sub);
      j.getString("url", str); j.has("x");
    }
    const int statuses[] = {200, 401, 409, 400, 413, 429, 500, 302, 0, -1};
    const ServerReply r = parseReply(statuses[rng() % 10], s.data(), s.size(), rng() % 2);
    // Bất biến an toàn: chỉ "Ok" khi status 200 (hoặc lỗi giả không bao giờ thành Ok)
    if (r.kind == ReplyKind::Ok) TEST_ASSERT_EQUAL_INT(200, r.status);
    uint64_t t;
    parseServerTime(s.data(), s.size(), t);
    OtaManifest m;
    if (parseOtaManifest(s.data(), s.size(), m) == OtaParse::Update) {
      TEST_ASSERT_TRUE(m.url.rfind("https://", 0) == 0);     // không bao giờ chấp nhận URL không phải HTTPS
      TEST_ASSERT_TRUE(!m.signature.empty());
    }
  }
}

static void test_fuzz_nul_and_null_inputs() {
  JsonObject a(nullptr, 0);
  TEST_ASSERT_FALSE(a.valid());
  const std::string withNul("{\"ok\":tr\0ue}", 12);
  JsonObject b(withNul.data(), withNul.size());
  bool ok = false;
  TEST_ASSERT_FALSE(b.valid() && b.getBool("ok", ok) && ok);
  TEST_ASSERT_TRUE(parseReply(200, nullptr, 0).kind != ReplyKind::Ok);
  // Lồng quá sâu / quá nhiều khóa: từ chối, không tràn ngăn xếp
  std::string deep = "{\"a\":" + std::string(200, '[') + std::string(200, ']') + "}";
  JsonObject d(deep.data(), deep.size());
  TEST_ASSERT_FALSE(d.valid());
  std::string many = "{";
  for (int i = 0; i < 100; i++) many += "\"k" + std::to_string(i) + "\":1,";
  many += "\"z\":1}";
  JsonObject m(many.data(), many.size());
  TEST_ASSERT_FALSE(m.valid());
}

static void test_fuzz_ring_buffer_against_model() {
  std::mt19937 rng(99);
  for (int round = 0; round < 200; round++) {
    const size_t cap = 1 + rng() % 40;
    ReadingBuffer buf(cap);
    std::deque<Reading> model;
    uint32_t t = 1;
    for (int op = 0; op < 400; op++) {
      switch (rng() % 5) {
        case 0: case 1: {
          const Reading r{t++, static_cast<int16_t>(rng())};
          buf.push(r);
          model.push_back(r);
          if (model.size() > cap) model.pop_front();
          break;
        }
        case 2: {
          const size_t n = rng() % 30;
          buf.popFront(n);
          for (size_t i = 0; i < n && !model.empty(); i++) model.pop_front();
          break;
        }
        case 3: {
          const uint32_t cutoff = t > 30 ? t - rng() % 30 : 0;
          buf.dropOlderThan(cutoff);
          while (!model.empty() && model.front().t < cutoff) model.pop_front();
          break;
        }
        default: {
          Reading out[25];
          const size_t n = buf.peek(out, rng() % 25);
          TEST_ASSERT_TRUE(n <= model.size());
          for (size_t i = 0; i < n; i++) TEST_ASSERT_TRUE(out[i].t == model[i].t && out[i].centi == model[i].centi);
          break;
        }
      }
      TEST_ASSERT_EQUAL_UINT(model.size(), buf.size());
      Reading newest;
      TEST_ASSERT_EQUAL(!model.empty(), buf.newest(newest));
      if (!model.empty()) TEST_ASSERT_EQUAL_UINT32(model.back().t, newest.t);
    }
  }
}

static void test_fuzz_body_builder_never_overflows() {
  std::mt19937 rng(5);
  for (int iter = 0; iter < 20000; iter++) {
    WireReading rs[kMaxBatch];
    const size_t n = rng() % (kMaxBatch + 3);
    for (auto& r : rs) r = WireReading{static_cast<uint32_t>(rng()), static_cast<int16_t>(rng())};
    std::string fw(rng() % 60, 'x');
    for (auto& c : fw) c = static_cast<char>(rng());
    const size_t cap = rng() % 1100;
    std::vector<char> buf(cap + 8, 'Z');
    const size_t len = buildReadingsBody(buf.data(), cap, fw.c_str(), rs, n > kMaxBatch ? kMaxBatch : n);
    TEST_ASSERT_TRUE(len < cap || len == 0);
    for (size_t i = cap; i < buf.size(); i++) TEST_ASSERT_EQUAL_CHAR('Z', buf[i]);   // không ghi lố bộ đệm
    if (len) TEST_ASSERT_EQUAL_CHAR('\0', buf[len]);
  }
}

static void test_fuzz_version_and_tag_parsers() {
  std::mt19937 rng(31337);
  for (int iter = 0; iter < 50000; iter++) {
    std::string a(rng() % 40, ' '), b(rng() % 40, ' ');
    for (auto& c : a) c = "0123456789.-+abc"[rng() % 16];
    for (auto& c : b) c = "0123456789.-+abc"[rng() % 16];
    const VersionOrder o = compareVersions(a, b);
    const VersionOrder inv = compareVersions(b, a);
    // Đối xứng: Newer <-> Older, Same <-> Same, Invalid <-> Invalid
    if (o == VersionOrder::Newer) TEST_ASSERT_TRUE(inv == VersionOrder::Older);
    if (o == VersionOrder::Older) TEST_ASSERT_TRUE(inv == VersionOrder::Newer);
    if (o == VersionOrder::Same) TEST_ASSERT_TRUE(inv == VersionOrder::Same);
    if (o == VersionOrder::Invalid) TEST_ASSERT_TRUE(inv == VersionOrder::Invalid);
    // Cùng một chuỗi luôn Same hoặc Invalid, không bao giờ Newer/Older
    const VersionOrder self = compareVersions(a, a);
    TEST_ASSERT_TRUE(self == VersionOrder::Same || self == VersionOrder::Invalid);
    std::vector<uint8_t> junk(rng() % 300);
    for (auto& x : junk) x = static_cast<uint8_t>(rng() % 3 == 0 ? "AUHONO-FWVER:;1.0"[rng() % 17] : rng());
    FwTagScanner sc;
    sc.feed(junk.data(), junk.size());
    if (sc.found()) TEST_ASSERT_TRUE(!sc.version().empty() && sc.version().size() <= 32);
    uint8_t hdr[64];
    for (auto& x : hdr) x = static_cast<uint8_t>(rng());
    (void)checkImageHeader(hdr, rng() % 70, static_cast<uint8_t>(rng() % 6));
  }
}

void run_fuzz_tests() {
  RUN_TEST(test_fuzz_json_and_reply_parsers);
  RUN_TEST(test_fuzz_nul_and_null_inputs);
  RUN_TEST(test_fuzz_ring_buffer_against_model);
  RUN_TEST(test_fuzz_body_builder_never_overflows);
  RUN_TEST(test_fuzz_version_and_tag_parsers);
}
