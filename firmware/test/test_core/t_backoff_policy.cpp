#include <unity.h>

#include "auhono/backoff.h"
#include "auhono/upload_policy.h"
#include "fakes.h"

using namespace auhono;

// ── Backoff ────────────────────────────────────────────────────────────────

static void expectWithin(uint32_t base, uint32_t v) {
  TEST_ASSERT_TRUE_MESSAGE(v >= base * 8 / 10, "dưới -20%");
  TEST_ASSERT_TRUE_MESSAGE(v <= base * 12 / 10, "trên +20%");
}

static void test_backoff_schedule_and_cap() {
  FakeRandom rng;
  Backoff b(rng);
  const uint32_t expected[] = {30000, 60000, 120000, 300000, 300000, 300000, 300000};
  for (uint32_t base : expected) expectWithin(base, b.nextDelayMs());
}

static void test_backoff_jitter_extremes() {
  FakeRandom lo;  lo.v = 0;   lo.step = 0;    // 80%
  FakeRandom hi;  hi.v = 400; hi.step = 0;    // 120%
  Backoff a(lo), c(hi);
  TEST_ASSERT_EQUAL_UINT32(24000, a.nextDelayMs());
  TEST_ASSERT_EQUAL_UINT32(36000, c.nextDelayMs());
  // rng lớn bất kỳ vẫn nằm trong khoảng
  FakeRandom big;  big.v = 0xFFFFFFFFu; big.step = 0;
  Backoff d(big);
  for (int i = 0; i < 6; i++) TEST_ASSERT_TRUE(d.nextDelayMs() <= 360000);
}

static void test_backoff_never_exceeds_cap_plus_jitter() {
  FakeRandom rng;
  rng.step = 7;
  Backoff b(rng);
  for (int i = 0; i < 1000; i++) {
    uint32_t v = b.nextDelayMs();
    TEST_ASSERT_TRUE(v <= Backoff::kMaxBaseMs * 12 / 10);
    TEST_ASSERT_TRUE(v >= 30000 * 8 / 10);
  }
}

static void test_backoff_reset() {
  FakeRandom rng;
  Backoff b(rng);
  b.nextDelayMs(); b.nextDelayMs(); b.nextDelayMs();
  b.reset();
  TEST_ASSERT_EQUAL_UINT8(0, b.step());
  expectWithin(30000, b.nextDelayMs());
}

static void test_backoff_devices_do_not_sync() {
  // Hai máy với nguồn ngẫu nhiên khác nhau phải cho độ trễ khác nhau (tránh dồn cùng lúc sau mất điện).
  FakeRandom r1, r2;
  r1.v = 30; r2.v = 290;
  Backoff a(r1), b(r2);
  TEST_ASSERT_TRUE(a.nextDelayMs() != b.nextDelayMs());
}

// ── Ngưỡng ─────────────────────────────────────────────────────────────────

static void test_threshold_defaults_and_boundaries() {
  Thresholds t;  // -40 / -18
  TEST_ASSERT_EQUAL_INT16(-4000, t.minCenti);
  TEST_ASSERT_EQUAL_INT16(-1800, t.maxCenti);
  TEST_ASSERT_FALSE(t.outOfRange(-1900));
  TEST_ASSERT_FALSE(t.outOfRange(-1800));  // đúng ngưỡng: chưa vượt
  TEST_ASSERT_TRUE(t.outOfRange(-1799));
  TEST_ASSERT_FALSE(t.outOfRange(-4000));
  TEST_ASSERT_TRUE(t.outOfRange(-4001));
}

static void test_threshold_sanity() {
  TEST_ASSERT_TRUE(Thresholds::isSane(-4000, -1800));
  TEST_ASSERT_TRUE(Thresholds::isSane(200, 800));
  TEST_ASSERT_FALSE(Thresholds::isSane(-1800, -4000));  // min > max
  TEST_ASSERT_FALSE(Thresholds::isSane(500, 500));
  TEST_ASSERT_FALSE(Thresholds::isSane(-9000, 0));
  TEST_ASSERT_FALSE(Thresholds::isSane(0, 20000));
}

// ── Giới hạn gửi ngay ──────────────────────────────────────────────────────

static void test_interval_limiter_including_wraparound() {
  IntervalLimiter l(60000);
  TEST_ASSERT_TRUE(l.tryAcquire(1000));
  TEST_ASSERT_FALSE(l.tryAcquire(30000));
  TEST_ASSERT_FALSE(l.tryAcquire(60999));
  TEST_ASSERT_TRUE(l.tryAcquire(61000));

  IntervalLimiter w(60000);
  TEST_ASSERT_TRUE(w.tryAcquire(0xFFFFFFF0u));           // sát điểm tràn millis()
  TEST_ASSERT_FALSE(w.tryAcquire(0x00000010u));           // chỉ 32 ms sau khi tràn
  TEST_ASSERT_TRUE(w.tryAcquire(0xFFFFFFF0u + 60000u));   // đủ 60 s sau, đã tràn
}

// ── Chính sách gửi ─────────────────────────────────────────────────────────

static void test_first_upload_is_immediate_then_every_5_minutes() {
  UploadPolicy p;
  TEST_ASSERT_EQUAL(UploadReason::None, p.poll(0, false));  // chưa có dữ liệu
  TEST_ASSERT_EQUAL(UploadReason::Periodic, p.poll(1000, true));
  p.onSuccess();
  TEST_ASSERT_EQUAL(UploadReason::None, p.poll(2000, true));
  TEST_ASSERT_EQUAL(UploadReason::None, p.poll(1000 + 299999, true));
  TEST_ASSERT_EQUAL(UploadReason::Periodic, p.poll(1000 + 300000, true));
}

static void test_immediate_send_when_out_of_range_rate_limited() {
  UploadPolicy p;
  TEST_ASSERT_EQUAL(UploadReason::Periodic, p.poll(0, true));
  p.onSuccess();

  p.noteReading(true);  // vượt ngưỡng ở giây 70
  TEST_ASSERT_EQUAL(UploadReason::Immediate, p.poll(70000, true));
  p.onSuccess();

  p.noteReading(true);  // lại vượt ngưỡng 20 s sau: phải chờ (tối đa 1 lần/60 s)
  TEST_ASSERT_EQUAL(UploadReason::None, p.poll(90000, true));
  TEST_ASSERT_EQUAL(UploadReason::None, p.poll(129999, true));
  TEST_ASSERT_EQUAL(UploadReason::Immediate, p.poll(130000, true));  // đủ 60 s
}

static void test_in_range_readings_do_not_trigger_immediate() {
  UploadPolicy p;
  p.poll(0, true);
  p.onSuccess();
  p.noteReading(false);
  TEST_ASSERT_EQUAL(UploadReason::None, p.poll(100000, true));
}

static void test_periodic_upload_carries_pending_breach() {
  UploadPolicy p;
  p.poll(0, true);
  p.onSuccess();
  p.noteReading(true);
  // ngay lúc đến hạn định kỳ: gói định kỳ đã bao gồm số đo vượt ngưỡng, không gửi thêm gói "ngay"
  TEST_ASSERT_EQUAL(UploadReason::Periodic, p.poll(300000, true));
  p.onSuccess();
  TEST_ASSERT_EQUAL(UploadReason::None, p.poll(300500, true));
}

static void test_failure_blocks_until_backoff_elapses_even_when_breach() {
  UploadPolicy p;
  TEST_ASSERT_EQUAL(UploadReason::Periodic, p.poll(0, true));
  p.onFailure(0, 30000);
  p.noteReading(true);
  TEST_ASSERT_EQUAL(UploadReason::None, p.poll(10000, true));
  TEST_ASSERT_EQUAL(UploadReason::None, p.poll(29999, true));
  TEST_ASSERT_EQUAL(UploadReason::Retry, p.poll(30000, true));
  p.onFailure(30000, 60000);
  TEST_ASSERT_EQUAL(UploadReason::None, p.poll(89999, true));
  TEST_ASSERT_EQUAL(UploadReason::Retry, p.poll(90000, true));
  p.onSuccess();
  TEST_ASSERT_EQUAL(UploadReason::None, p.poll(90001, true));
}

static void test_policy_handles_millis_wraparound() {
  UploadPolicy p;
  TEST_ASSERT_EQUAL(UploadReason::Periodic, p.poll(0xFFFFFF00u, true));
  p.onSuccess();
  TEST_ASSERT_EQUAL(UploadReason::None, p.poll(0x00000100u, true));                 // sau tràn, mới ~0,5 s
  TEST_ASSERT_EQUAL(UploadReason::Periodic, p.poll(0xFFFFFF00u + 300000u, true));   // sau 5 phút
  p.onFailure(0xFFFFFF00u + 300000u, 30000);
  TEST_ASSERT_EQUAL(UploadReason::None, p.poll(0xFFFFFF00u + 310000u, true));
  TEST_ASSERT_EQUAL(UploadReason::Retry, p.poll(0xFFFFFF00u + 330000u, true));
}

void run_backoff_policy_tests() {
  RUN_TEST(test_backoff_schedule_and_cap);
  RUN_TEST(test_backoff_jitter_extremes);
  RUN_TEST(test_backoff_never_exceeds_cap_plus_jitter);
  RUN_TEST(test_backoff_reset);
  RUN_TEST(test_backoff_devices_do_not_sync);
  RUN_TEST(test_threshold_defaults_and_boundaries);
  RUN_TEST(test_threshold_sanity);
  RUN_TEST(test_interval_limiter_including_wraparound);
  RUN_TEST(test_first_upload_is_immediate_then_every_5_minutes);
  RUN_TEST(test_immediate_send_when_out_of_range_rate_limited);
  RUN_TEST(test_in_range_readings_do_not_trigger_immediate);
  RUN_TEST(test_periodic_upload_carries_pending_breach);
  RUN_TEST(test_failure_blocks_until_backoff_elapses_even_when_breach);
  RUN_TEST(test_policy_handles_millis_wraparound);
}
