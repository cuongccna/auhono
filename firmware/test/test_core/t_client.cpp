// Kiểm thử máy khách có ký + bộ gửi số đo với HTTP giả: đây là nơi kiểm 401/409, backoff và
// "byte được ký == byte được gửi".
#include <unity.h>

#include <string>

#include "auhono/device_client.h"
#include "auhono/hex.h"
#include "auhono/uploader.h"
#include "fakes.h"
#include "soft_crypto.h"

using namespace auhono;

namespace {

const char* kKeyHex = "41bc43e33ceb8fd260f6888bcf8b89858310b99545a24ac3a6a76bb1b7b8a507";

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
    fromHex(kKeyHex, 64, key, sizeof key, nullptr);
    signer = new Signer(crypto, "AUH-000001", key);
    seq = new SeqCounter(flash);
    seq->begin();
    client = new DeviceClient(*signer, *seq, plat, http);
    up = new ReadingsUploader(*client, buf, th, plat, "1.0.0");
    plat.unix_ = 1800000000;
    plat.trusted = true;
  }
  ~Rig() { delete up; delete client; delete seq; delete signer; }

  void fill(size_t n, uint32_t t0 = 1799999000) {
    for (size_t i = 0; i < n; i++) buf.push(Reading{t0 + static_cast<uint32_t>(i) * 60, -1900});
  }
};

std::string expectedSig(Rig& r, const FakeHttp::Recorded& rec) {
  // Tự dựng lại chữ ký từ dữ liệu ĐÃ GỬI để chứng minh chữ ký khớp đúng các byte body đã gửi.
  const auto& h = rec.req.headers;
  uint8_t hash[32];
  softcrypto::sha256(reinterpret_cast<const uint8_t*>(rec.body.data()), rec.body.size(), hash);
  const std::string canon = buildCanonical(rec.req.method, stripQuery(rec.req.pathAndQuery), h.deviceId,
                                           std::stoull(h.timestamp), std::stoull(h.seq), toHex(hash, 32));
  uint8_t mac[32];
  softcrypto::hmacSha256(r.key, 32, reinterpret_cast<const uint8_t*>(canon.data()), canon.size(), mac);
  return toHex(mac, 32);
}

}  // namespace

static void test_signed_bytes_equal_sent_bytes() {
  Rig r;
  r.fill(3);
  const FlushResult f = r.up->flush();
  TEST_ASSERT_TRUE(f.ok);
  TEST_ASSERT_EQUAL_UINT(1, r.http.log.size());
  const auto& rec = r.http.log[0];
  TEST_ASSERT_EQUAL_STRING("POST", rec.req.method.c_str());
  TEST_ASSERT_EQUAL_STRING("/v1/readings", rec.req.pathAndQuery.c_str());
  TEST_ASSERT_TRUE(rec.req.hasSignature);
  TEST_ASSERT_EQUAL_STRING("AUH-000001", rec.req.headers.deviceId.c_str());
  TEST_ASSERT_EQUAL_STRING("1800000000", rec.req.headers.timestamp.c_str());
  TEST_ASSERT_EQUAL_STRING(expectedSig(r, rec).c_str(), rec.req.headers.signature.c_str());
  // Con trỏ body trong request chính là vùng được ký, độ dài khớp
  TEST_ASSERT_EQUAL_UINT(rec.body.size(), rec.req.bodyLen);
  TEST_ASSERT_EQUAL_STRING(
      "{\"fw\":\"1.0.0\",\"readings\":[{\"t\":1799999000,\"c\":-19.0},{\"t\":1799999060,\"c\":-19.0},{\"t\":1799999120,\"c\":-19.0}]}",
      rec.body.c_str());
}

static void test_flush_batches_oldest_first_and_max_20() {
  Rig r;
  r.fill(45);
  const FlushResult f = r.up->flush();
  TEST_ASSERT_TRUE(f.ok);
  TEST_ASSERT_EQUAL_UINT(3, r.http.log.size());  // 20 + 20 + 5
  TEST_ASSERT_EQUAL_UINT(45, f.sentReadings);
  TEST_ASSERT_TRUE(r.buf.empty());
  TEST_ASSERT_TRUE(r.http.log[0].body.find("\"t\":1799999000,") != std::string::npos);  // gói đầu chứa số đo cũ nhất
  TEST_ASSERT_TRUE(r.http.log[1].body.find("\"t\":1800000200,") != std::string::npos);  // 1799999000 + 20*60
  // seq tăng nghiêm ngặt giữa các gói
  TEST_ASSERT_EQUAL_STRING("1", r.http.log[0].req.headers.seq.c_str());
  TEST_ASSERT_EQUAL_STRING("2", r.http.log[1].req.headers.seq.c_str());
  TEST_ASSERT_EQUAL_STRING("3", r.http.log[2].req.headers.seq.c_str());
}

static void test_failed_upload_keeps_readings_for_retry() {
  Rig r;
  r.fill(30);
  r.http.script.push_back({-1, ""});  // lỗi mạng
  FlushResult f = r.up->flush();
  TEST_ASSERT_FALSE(f.ok);
  TEST_ASSERT_EQUAL(ReplyKind::NetworkError, f.lastKind);
  TEST_ASSERT_EQUAL_UINT(30, r.buf.size());  // không mất số đo nào
  f = r.up->flush();                         // mạng đã ổn
  TEST_ASSERT_TRUE(f.ok);
  TEST_ASSERT_TRUE(r.buf.empty());
}

static void test_partial_failure_drops_only_sent_batches() {
  Rig r;
  r.fill(45);
  r.http.script.push_back({200, okBody(20)});
  r.http.script.push_back({503, ""});
  FlushResult f = r.up->flush();
  TEST_ASSERT_FALSE(f.ok);
  TEST_ASSERT_EQUAL_UINT(20, f.sentReadings);
  TEST_ASSERT_EQUAL_UINT(25, r.buf.size());
  Reading first;
  r.buf.peek(&first, 1);
  TEST_ASSERT_EQUAL_UINT32(1799999000u + 20 * 60, first.t);
}

static void test_clock_skew_resets_clock_and_resigns_with_new_seq() {
  Rig r;
  r.plat.unix_ = 1799990000;  // lệch ~2,7 giờ
  r.fill(1, 1799999000);
  r.http.script.push_back({401, "{\"error\":\"clock_skew\",\"server_time\":1800000000}"});
  const FlushResult f = r.up->flush();
  TEST_ASSERT_TRUE(f.ok);
  TEST_ASSERT_EQUAL_UINT(2, r.http.log.size());
  TEST_ASSERT_EQUAL_UINT32(1800000000u, r.plat.unix_);
  TEST_ASSERT_EQUAL_STRING("1799990000", r.http.log[0].req.headers.timestamp.c_str());
  TEST_ASSERT_EQUAL_STRING("1800000000", r.http.log[1].req.headers.timestamp.c_str());
  TEST_ASSERT_EQUAL_STRING("1", r.http.log[0].req.headers.seq.c_str());
  TEST_ASSERT_EQUAL_STRING("2", r.http.log[1].req.headers.seq.c_str());  // "tăng seq, gửi lại"
  TEST_ASSERT_EQUAL_STRING(expectedSig(r, r.http.log[1]).c_str(), r.http.log[1].req.headers.signature.c_str());
  TEST_ASSERT_TRUE(r.buf.empty());
}

static void test_replay_409_jumps_seq_past_last_seq() {
  Rig r;  // ví dụ chip bị xóa flash: seq của ta = 1 nhưng server đã thấy 5000
  r.fill(1);
  r.http.script.push_back({409, "{\"error\":\"replay\",\"last_seq\":5000}"});
  const FlushResult f = r.up->flush();
  TEST_ASSERT_TRUE(f.ok);
  TEST_ASSERT_EQUAL_UINT(2, r.http.log.size());
  TEST_ASSERT_EQUAL_STRING("5001", r.http.log[1].req.headers.seq.c_str());  // max(seq, N) + 1
  TEST_ASSERT_TRUE(r.buf.empty());
}

static void test_replay_and_skew_retries_are_bounded() {
  Rig r;
  r.fill(1);
  for (int i = 0; i < 10; i++) r.http.script.push_back({409, "{\"error\":\"replay\",\"last_seq\":9}"});
  const FlushResult f = r.up->flush();
  TEST_ASSERT_FALSE(f.ok);
  TEST_ASSERT_EQUAL_UINT(DeviceClient::kMaxAttempts, r.http.log.size());  // không vòng lặp vô hạn
  TEST_ASSERT_EQUAL_UINT(1, r.buf.size());
}

static void test_unauthorized_is_not_retried_immediately() {
  Rig r;
  r.fill(2);
  r.http.script.push_back({401, "{\"error\":\"unauthorized\"}"});
  const FlushResult f = r.up->flush();
  TEST_ASSERT_FALSE(f.ok);
  TEST_ASSERT_EQUAL(ReplyKind::Unauthorized, f.lastKind);
  TEST_ASSERT_EQUAL_UINT(1, r.http.log.size());  // để tầng trên backoff, không dồn dập
  TEST_ASSERT_EQUAL_UINT(2, r.buf.size());
}

static void test_bad_request_drops_batch_not_resend() {
  Rig r;
  r.fill(25);
  r.http.script.push_back({400, "{\"error\":\"bad_request\"}"});
  const FlushResult f = r.up->flush();
  TEST_ASSERT_TRUE(f.ok);
  TEST_ASSERT_EQUAL_UINT(20, f.discardedReadings);
  TEST_ASSERT_EQUAL_UINT(5, f.sentReadings);
  TEST_ASSERT_EQUAL_UINT(2, r.http.log.size());
  TEST_ASSERT_TRUE(r.http.log[0].body != r.http.log[1].body);  // không gửi lại nguyên xi
}

static void test_too_large_halves_batch() {
  Rig r;
  r.fill(20);
  r.http.script.push_back({413, "{\"error\":\"too_large\"}"});
  const FlushResult f = r.up->flush();
  TEST_ASSERT_TRUE(f.ok);
  TEST_ASSERT_EQUAL_UINT(20, f.sentReadings);
  TEST_ASSERT_EQUAL_UINT(3, r.http.log.size());  // 20 (413) -> 10 -> 10
}

static void test_thresholds_updated_from_config() {
  Rig r;
  r.fill(1);
  r.http.script.push_back({200, "{\"ok\":true,\"accepted\":1,\"server_time\":1800000000,\"config\":{\"min_c\":2,\"max_c\":8}}"});
  const FlushResult f = r.up->flush();
  TEST_ASSERT_TRUE(f.thresholdsChanged);
  TEST_ASSERT_EQUAL_INT16(200, r.th.minCenti);
  TEST_ASSERT_EQUAL_INT16(800, r.th.maxCenti);
  r.fill(1);
  const FlushResult f2 = r.up->flush();  // cấu hình mặc định của FakeHttp là -40/-18 => đổi lại
  TEST_ASSERT_TRUE(f2.thresholdsChanged);
  TEST_ASSERT_EQUAL_INT16(-1800, r.th.maxCenti);
  r.fill(1);
  TEST_ASSERT_FALSE(r.up->flush().thresholdsChanged);  // không đổi thì không báo (khỏi ghi flash)
}

static void test_flush_drops_readings_older_than_24h() {
  Rig r;
  r.buf.push(Reading{1800000000u - 25 * 3600, -1900});  // quá 24 giờ: server sẽ bỏ
  r.buf.push(Reading{1800000000u - 3600, -1900});
  r.up->flush();
  TEST_ASSERT_EQUAL_UINT(1, r.http.log.size());
  TEST_ASSERT_TRUE(r.http.log[0].body.find("\"t\":1799996400") != std::string::npos);
  TEST_ASSERT_TRUE(r.http.log[0].body.find(std::to_string(1800000000u - 25 * 3600)) == std::string::npos);
}

static void test_empty_buffer_sends_nothing() {
  Rig r;
  const FlushResult f = r.up->flush();
  TEST_ASSERT_TRUE(f.ok);
  TEST_ASSERT_FALSE(f.reachedServer);
  TEST_ASSERT_EQUAL_UINT(0, r.http.log.size());
}

static void test_watchdog_fed_during_flush() {
  Rig r;
  r.fill(60);
  r.up->flush();
  TEST_ASSERT_TRUE(r.plat.wdtFeeds >= 3);
}

static void test_ok_reply_sets_untrusted_clock() {
  Rig r;
  r.plat.trusted = false;
  r.plat.unix_ = 5;  // 1970
  r.fill(1);
  r.up->flush();
  TEST_ASSERT_EQUAL_UINT32(1800000000u, r.plat.unix_);
  TEST_ASSERT_TRUE(r.plat.trusted);
}

static void test_sync_time_from_server_unsigned() {
  Rig r;
  r.plat.trusted = false;
  r.plat.unix_ = 0;
  r.http.script.push_back({200, "{\"server_time\":1800000042}"});
  TEST_ASSERT_TRUE(r.client->syncTimeFromServer());
  TEST_ASSERT_EQUAL_UINT32(1800000042u, r.plat.unix_);
  TEST_ASSERT_FALSE(r.http.log[0].req.hasSignature);  // GET /v1/time không ký
  TEST_ASSERT_EQUAL_STRING("/v1/time", r.http.log[0].req.pathAndQuery.c_str());
  // Phản hồi rác: không chỉnh giờ
  Rig r2;
  r2.plat.trusted = false;
  r2.http.script.push_back({200, "{\"server_time\":12}"});
  TEST_ASSERT_FALSE(r2.client->syncTimeFromServer());
  TEST_ASSERT_FALSE(r2.plat.trusted);
}

static void test_signed_get_ota_check_has_empty_body() {
  Rig r;
  r.http.script.push_back({200, "{\"update\":false}"});
  r.client->call("GET", "/v1/ota/check?current=1.0.0", nullptr, 0);
  TEST_ASSERT_EQUAL_UINT(1, r.http.log.size());
  TEST_ASSERT_EQUAL_UINT(0, r.http.log[0].req.bodyLen);
  TEST_ASSERT_EQUAL_STRING(expectedSig(r, r.http.log[0]).c_str(), r.http.log[0].req.headers.signature.c_str());
}

void run_client_tests() {
  RUN_TEST(test_signed_bytes_equal_sent_bytes);
  RUN_TEST(test_flush_batches_oldest_first_and_max_20);
  RUN_TEST(test_failed_upload_keeps_readings_for_retry);
  RUN_TEST(test_partial_failure_drops_only_sent_batches);
  RUN_TEST(test_clock_skew_resets_clock_and_resigns_with_new_seq);
  RUN_TEST(test_replay_409_jumps_seq_past_last_seq);
  RUN_TEST(test_replay_and_skew_retries_are_bounded);
  RUN_TEST(test_unauthorized_is_not_retried_immediately);
  RUN_TEST(test_bad_request_drops_batch_not_resend);
  RUN_TEST(test_too_large_halves_batch);
  RUN_TEST(test_thresholds_updated_from_config);
  RUN_TEST(test_flush_drops_readings_older_than_24h);
  RUN_TEST(test_empty_buffer_sends_nothing);
  RUN_TEST(test_watchdog_fed_during_flush);
  RUN_TEST(test_ok_reply_sets_untrusted_clock);
  RUN_TEST(test_sync_time_from_server_unsigned);
  RUN_TEST(test_signed_get_ota_check_has_empty_body);
}
