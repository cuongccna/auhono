#include <unity.h>

#include <string>

#include "auhono/server_reply.h"
#include "auhono/time_policy.h"

using namespace auhono;

static ServerReply parse(int status, const std::string& body) { return parseReply(status, body.data(), body.size()); }

static void test_ok_reply_with_config() {
  const ServerReply r = parse(200, "{\"ok\":true,\"accepted\":5,\"server_time\":1800000004,\"config\":{\"min_c\":-40,\"max_c\":-18}}");
  TEST_ASSERT_EQUAL(ReplyKind::Ok, r.kind);
  TEST_ASSERT_EQUAL_UINT32(5, r.accepted);
  TEST_ASSERT_TRUE(r.hasServerTime);
  TEST_ASSERT_EQUAL_UINT64(1800000004ULL, r.serverTime);
  TEST_ASSERT_TRUE(r.hasConfig);
  TEST_ASSERT_EQUAL_INT16(-4000, r.config.minCenti);
  TEST_ASSERT_EQUAL_INT16(-1800, r.config.maxCenti);
}

static void test_ok_reply_fractional_thresholds() {
  const ServerReply r = parse(200, "{\"ok\":true,\"accepted\":1,\"server_time\":1800000004,\"config\":{\"min_c\":2,\"max_c\":8.5}}");
  TEST_ASSERT_TRUE(r.hasConfig);
  TEST_ASSERT_EQUAL_INT16(200, r.config.minCenti);
  TEST_ASSERT_EQUAL_INT16(850, r.config.maxCenti);
}

static void test_ok_reply_with_insane_config_is_ignored() {
  ServerReply r = parse(200, "{\"ok\":true,\"accepted\":1,\"config\":{\"min_c\":-10,\"max_c\":-20}}");
  TEST_ASSERT_EQUAL(ReplyKind::Ok, r.kind);
  TEST_ASSERT_FALSE(r.hasConfig);  // min >= max: giữ ngưỡng cũ
  r = parse(200, "{\"ok\":true,\"accepted\":1,\"config\":{\"min_c\":\"x\",\"max_c\":-18}}");
  TEST_ASSERT_FALSE(r.hasConfig);
  r = parse(200, "{\"ok\":true,\"accepted\":1,\"config\":{\"min_c\":1e1,\"max_c\":-18}}");
  TEST_ASSERT_FALSE(r.hasConfig);
}

static void test_200_without_ok_true_is_not_success() {
  // Wi-Fi công cộng có captive portal thường trả 200 + HTML: KHÔNG được coi là thành công.
  TEST_ASSERT_EQUAL(ReplyKind::Unknown, parse(200, "<html><body>Login</body></html>").kind);
  TEST_ASSERT_EQUAL(ReplyKind::Unknown, parse(200, "{\"ok\":false}").kind);
  TEST_ASSERT_EQUAL(ReplyKind::Unknown, parse(200, "").kind);
  TEST_ASSERT_EQUAL(ReplyKind::Unknown, parse(200, "{\"accepted\":1}").kind);
}

static void test_200_without_ok_field_accepted_when_not_required() {
  const std::string b = "{\"update\":false}";
  TEST_ASSERT_EQUAL(ReplyKind::Ok, parseReply(200, b.data(), b.size(), false).kind);
  TEST_ASSERT_EQUAL(ReplyKind::Unknown, parseReply(200, b.data(), b.size(), true).kind);
  TEST_ASSERT_EQUAL(ReplyKind::Unauthorized, parseReply(401, "", 0, false).kind);  // lỗi vẫn được phân loại
}

static void test_clock_skew() {
  const ServerReply r = parse(401, "{\"error\":\"clock_skew\",\"server_time\":1800000123}");
  TEST_ASSERT_EQUAL(ReplyKind::ClockSkew, r.kind);
  TEST_ASSERT_TRUE(r.hasServerTime);
  TEST_ASSERT_EQUAL_UINT64(1800000123ULL, r.serverTime);
}

static void test_unauthorized_variants() {
  TEST_ASSERT_EQUAL(ReplyKind::Unauthorized, parse(401, "{\"error\":\"unauthorized\"}").kind);
  TEST_ASSERT_EQUAL(ReplyKind::Unauthorized, parse(401, "").kind);
  // clock_skew mà thiếu server_time: không có gì để chỉnh => coi như unauthorized (backoff)
  TEST_ASSERT_EQUAL(ReplyKind::Unauthorized, parse(401, "{\"error\":\"clock_skew\"}").kind);
}

static void test_replay() {
  const ServerReply r = parse(409, "{\"error\":\"replay\",\"last_seq\":4242}");
  TEST_ASSERT_EQUAL(ReplyKind::Replay, r.kind);
  TEST_ASSERT_TRUE(r.hasLastSeq);
  TEST_ASSERT_EQUAL_UINT64(4242, r.lastSeq);
  const ServerReply r2 = parse(409, "{\"error\":\"replay\"}");
  TEST_ASSERT_EQUAL(ReplyKind::Replay, r2.kind);
  TEST_ASSERT_FALSE(r2.hasLastSeq);
  TEST_ASSERT_EQUAL(ReplyKind::Unknown, parse(409, "{\"error\":\"other\"}").kind);
}

static void test_other_status_codes() {
  TEST_ASSERT_EQUAL(ReplyKind::TooLarge, parse(413, "{\"error\":\"too_large\"}").kind);
  TEST_ASSERT_EQUAL(ReplyKind::BadRequest, parse(400, "{\"error\":\"bad_request\"}").kind);
  TEST_ASSERT_EQUAL(ReplyKind::ServerError, parse(500, "").kind);
  TEST_ASSERT_EQUAL(ReplyKind::ServerError, parse(503, "x").kind);
  TEST_ASSERT_EQUAL(ReplyKind::NetworkError, parse(-1, "").kind);
  TEST_ASSERT_EQUAL(ReplyKind::NetworkError, parse(0, "").kind);
  TEST_ASSERT_EQUAL(ReplyKind::Unknown, parse(302, "").kind);
  TEST_ASSERT_EQUAL(ReplyKind::Unknown, parse(404, "{\"error\":\"not_found\"}").kind);
}

static void test_nested_keys_do_not_confuse_top_level() {
  // "server_time" chỉ nằm trong object lồng: không được lấy làm server_time cấp ngoài.
  const ServerReply r = parse(200, "{\"ok\":true,\"accepted\":1,\"config\":{\"server_time\":5,\"min_c\":-40,\"max_c\":-18}}");
  TEST_ASSERT_EQUAL(ReplyKind::Ok, r.kind);
  TEST_ASSERT_FALSE(r.hasServerTime);
  // Chuỗi chứa dấu ngoặc/nháy không làm lệch bộ quét
  const ServerReply r2 = parse(200, "{\"note\":\"}{\\\",\\\"ok\\\":false\",\"ok\":true,\"accepted\":2}");
  TEST_ASSERT_EQUAL(ReplyKind::Ok, r2.kind);
  TEST_ASSERT_EQUAL_UINT32(2, r2.accepted);
}

static void test_malformed_json_is_never_ok() {
  TEST_ASSERT_EQUAL(ReplyKind::Unknown, parse(200, "{\"ok\":true").kind);            // thiếu }
  TEST_ASSERT_EQUAL(ReplyKind::Unknown, parse(200, "{\"ok\":true}garbage").kind);    // rác phía sau
  TEST_ASSERT_EQUAL(ReplyKind::Unknown, parse(200, "{\"ok\" true}").kind);
  TEST_ASSERT_EQUAL(ReplyKind::Unknown, parse(200, "[true]").kind);
}

static void test_server_time_endpoint() {
  uint64_t t = 0;
  const std::string b = "{\"server_time\":1800000000}";
  TEST_ASSERT_TRUE(parseServerTime(b.data(), b.size(), t));
  TEST_ASSERT_EQUAL_UINT64(1800000000ULL, t);
  const std::string bad = "{\"server_time\":\"x\"}";
  TEST_ASSERT_FALSE(parseServerTime(bad.data(), bad.size(), t));
}

// ── Manifest OTA ───────────────────────────────────────────────────────────

static const std::string kSha(64, 'a');
static const std::string kSig(140, 'b');  // 70 byte

static std::string manifest(const std::string& url, const std::string& sha, const std::string& sig, const std::string& ver = "1.0.1") {
  return "{\"update\":true,\"version\":\"" + ver + "\",\"url\":\"" + url + "\",\"sha256\":\"" + sha + "\",\"signature\":\"" + sig + "\"}";
}

static OtaParse ota(const std::string& body, OtaManifest& m) { return parseOtaManifest(body.data(), body.size(), m); }

static void test_ota_no_update() {
  OtaManifest m;
  TEST_ASSERT_EQUAL(OtaParse::NoUpdate, ota("{\"update\":false}", m));
}

static void test_ota_valid_manifest() {
  OtaManifest m;
  TEST_ASSERT_EQUAL(OtaParse::Update, ota(manifest("https://cdn.example.com/fw-1.0.1.bin", kSha, kSig), m));
  TEST_ASSERT_EQUAL_STRING("1.0.1", m.version.c_str());
  TEST_ASSERT_EQUAL_STRING("https://cdn.example.com/fw-1.0.1.bin", m.url.c_str());
  TEST_ASSERT_EQUAL_UINT8(0xaa, m.sha256[0]);
  TEST_ASSERT_EQUAL_UINT8(0xaa, m.sha256[31]);
  TEST_ASSERT_EQUAL_UINT(70, m.signature.size());
  TEST_ASSERT_EQUAL_UINT8(0xbb, m.signature[0]);
}

static void test_ota_rejects_non_https_and_bad_fields() {
  OtaManifest m;
  TEST_ASSERT_EQUAL(OtaParse::Invalid, ota(manifest("http://cdn.example.com/fw.bin", kSha, kSig), m));  // không HTTPS
  TEST_ASSERT_EQUAL(OtaParse::Invalid, ota(manifest("ftp://x/fw.bin", kSha, kSig), m));
  TEST_ASSERT_EQUAL(OtaParse::Invalid, ota(manifest("https://", kSha, kSig), m));
  TEST_ASSERT_EQUAL(OtaParse::Invalid, ota(manifest("https://a b/fw.bin", kSha, kSig), m));             // khoảng trắng
  TEST_ASSERT_EQUAL(OtaParse::Invalid, ota(manifest("https://a/fw.bin", std::string(63, 'a'), kSig), m));  // sha ngắn
  TEST_ASSERT_EQUAL(OtaParse::Invalid, ota(manifest("https://a/fw.bin", std::string(64, 'g'), kSig), m));  // sha không phải hex
  TEST_ASSERT_EQUAL(OtaParse::Invalid, ota(manifest("https://a/fw.bin", kSha, std::string(141, 'b')), m)); // chữ ký lẻ
  TEST_ASSERT_EQUAL(OtaParse::Invalid, ota(manifest("https://a/fw.bin", kSha, ""), m));                    // thiếu chữ ký
  TEST_ASSERT_EQUAL(OtaParse::Invalid, ota(manifest("https://a/fw.bin", kSha, std::string(200, 'b')), m)); // quá dài
  TEST_ASSERT_EQUAL(OtaParse::Invalid, ota(manifest("https://a/fw.bin", kSha, kSig, "1.0 1"), m));         // version có khoảng trắng
  TEST_ASSERT_EQUAL(OtaParse::Invalid, ota("{\"update\":true}", m));
  TEST_ASSERT_EQUAL(OtaParse::Invalid, ota("not json", m));
}

// ── Chính sách đồng hồ ─────────────────────────────────────────────────────

static void test_time_policy() {
  TEST_ASSERT_FALSE(isPlausibleUnix(0));
  TEST_ASSERT_FALSE(isPlausibleUnix(1700000000));  // 2023: chưa hợp lệ
  TEST_ASSERT_TRUE(isPlausibleUnix(1735689600));   // 2025-01-01
  TEST_ASSERT_TRUE(isPlausibleUnix(1800000000));
  TEST_ASSERT_FALSE(isPlausibleUnix(5000000000ULL));

  // Đồng hồ chưa đáng tin: nhận giờ server
  TEST_ASSERT_TRUE(shouldAdoptServerTime(false, 0, 1800000000, false));
  // Server trả giờ vô lý: không nhận
  TEST_ASSERT_FALSE(shouldAdoptServerTime(false, 0, 12345, false));
  TEST_ASSERT_FALSE(shouldAdoptServerTime(false, 0, 12345, true));
  // Đang đáng tin, lệch nhỏ: không giật giờ
  TEST_ASSERT_FALSE(shouldAdoptServerTime(true, 1800000000, 1800000003, false));
  // Lệch lớn, hoặc server bảo clock_skew: chỉnh
  TEST_ASSERT_TRUE(shouldAdoptServerTime(true, 1800000000, 1800000500, false));
  TEST_ASSERT_TRUE(shouldAdoptServerTime(true, 1800000000, 1800000010, true));
}

void run_reply_tests() {
  RUN_TEST(test_ok_reply_with_config);
  RUN_TEST(test_ok_reply_fractional_thresholds);
  RUN_TEST(test_ok_reply_with_insane_config_is_ignored);
  RUN_TEST(test_200_without_ok_true_is_not_success);
  RUN_TEST(test_200_without_ok_field_accepted_when_not_required);
  RUN_TEST(test_clock_skew);
  RUN_TEST(test_unauthorized_variants);
  RUN_TEST(test_replay);
  RUN_TEST(test_other_status_codes);
  RUN_TEST(test_nested_keys_do_not_confuse_top_level);
  RUN_TEST(test_malformed_json_is_never_ok);
  RUN_TEST(test_server_time_endpoint);
  RUN_TEST(test_ota_no_update);
  RUN_TEST(test_ota_valid_manifest);
  RUN_TEST(test_ota_rejects_non_https_and_bad_fields);
  RUN_TEST(test_time_policy);
}
