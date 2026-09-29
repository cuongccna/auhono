#include <unity.h>

#include "auhono/seq_counter.h"
#include "fakes.h"

using namespace auhono;

static void test_first_boot_starts_at_one() {
  FakeSeqStore flash;
  SeqCounter c(flash);
  c.begin();
  TEST_ASSERT_EQUAL_UINT64(1, c.next());
  TEST_ASSERT_EQUAL_UINT64(2, c.next());
}

static void test_monotonic_across_simulated_reboots() {
  FakeSeqStore flash;
  uint64_t lastSeen = 0;
  for (int boot = 0; boot < 50; boot++) {
    SeqCounter c(flash, 8);
    c.begin();
    const int requests = 1 + (boot * 7) % 23;  // số request khác nhau mỗi lần chạy
    for (int i = 0; i < requests; i++) {
      const uint64_t s = c.next();
      TEST_ASSERT_TRUE_MESSAGE(s > lastSeen, "seq phải tăng nghiêm ngặt");
      lastSeen = s;
    }
    // "mất điện" ngay tại đây: bộ đếm RAM biến mất, chỉ flash còn
  }
}

static void test_flash_writes_are_amortized() {
  FakeSeqStore flash;
  SeqCounter c(flash, 64);
  c.begin();
  for (int i = 0; i < 640; i++) c.next();
  // 640 request / stride 64 = 10 lần ghi (không phải 640)
  TEST_ASSERT_EQUAL_INT(10, flash.saves);
}

static void test_ceiling_persisted_before_use() {
  FakeSeqStore flash;
  SeqCounter c(flash, 10);
  c.begin();
  for (int i = 0; i < 25; i++) {
    const uint64_t s = c.next();
    TEST_ASSERT_TRUE_MESSAGE(flash.value >= s, "trần lưu trong flash phải >= seq vừa cấp");
  }
}

static void test_reboot_jumps_ahead_of_all_used() {
  FakeSeqStore flash;
  uint64_t maxUsed = 0;
  {
    SeqCounter c(flash, 64);
    c.begin();
    for (int i = 0; i < 100; i++) maxUsed = c.next();
  }
  SeqCounter c2(flash, 64);
  c2.begin();
  TEST_ASSERT_TRUE(c2.next() > maxUsed);
}

static void test_replay_raiseTo() {
  FakeSeqStore flash;
  SeqCounter c(flash);
  c.begin();
  c.next();  // 1
  c.raiseTo(500);
  TEST_ASSERT_EQUAL_UINT64(501, c.next());  // max(seq, N) + 1
  c.raiseTo(10);                            // giá trị thấp hơn: không được lùi
  TEST_ASSERT_EQUAL_UINT64(502, c.next());
  c.raiseTo(SeqCounter::kMaxSeq + 1);       // vô lý: bỏ qua
  TEST_ASSERT_EQUAL_UINT64(503, c.next());
}

static void test_raiseTo_survives_reboot() {
  FakeSeqStore flash;
  {
    SeqCounter c(flash, 4);
    c.begin();
    c.raiseTo(1000);
    c.next();  // 1001, ghi trần
  }
  SeqCounter c2(flash, 4);
  c2.begin();
  TEST_ASSERT_TRUE(c2.next() > 1001);
}

static void test_save_failure_does_not_stall_and_retries() {
  FakeSeqStore flash;
  SeqCounter c(flash, 4);
  c.begin();
  flash.failSave = true;
  TEST_ASSERT_EQUAL_UINT64(1, c.next());
  TEST_ASSERT_EQUAL_UINT64(2, c.next());
  TEST_ASSERT_TRUE(c.saveFailures() >= 2);
  flash.failSave = false;
  c.next();
  TEST_ASSERT_TRUE(flash.value >= 3);  // đã ghi lại thành công
}

static void test_corrupt_store_value_is_ignored() {
  FakeSeqStore flash;
  flash.has = true;
  flash.value = SeqCounter::kMaxSeq + 5;  // rác
  SeqCounter c(flash);
  c.begin();
  TEST_ASSERT_EQUAL_UINT64(1, c.next());
}

void run_seq_tests() {
  RUN_TEST(test_first_boot_starts_at_one);
  RUN_TEST(test_monotonic_across_simulated_reboots);
  RUN_TEST(test_flash_writes_are_amortized);
  RUN_TEST(test_ceiling_persisted_before_use);
  RUN_TEST(test_reboot_jumps_ahead_of_all_used);
  RUN_TEST(test_replay_raiseTo);
  RUN_TEST(test_raiseTo_survives_reboot);
  RUN_TEST(test_save_failure_does_not_stall_and_retries);
  RUN_TEST(test_corrupt_store_value_is_ignored);
}
