// DS18B20: giải mã scratchpad, làm tròn/biên centi-độ, bộ lọc gai nhiễu (không làm chậm báo động thật).
#include <unity.h>

#include <cmath>
#include <cstring>
#include <vector>

#include "auhono/ds18b20.h"
#include "auhono/plausibility.h"
#include "auhono/readings.h"

using namespace auhono;

namespace {

/// Dựng scratchpad hợp lệ (12 bit, byte cố định đúng) cho giá trị raw 1/16 °C, rồi đóng CRC.
void makeSp(uint8_t sp[9], int raw, uint8_t cfg = 0x7F) {
  sp[0] = static_cast<uint8_t>(raw & 0xFF);
  sp[1] = static_cast<uint8_t>((raw >> 8) & 0xFF);
  sp[2] = 0x4B; sp[3] = 0x46;  // TH, TL
  sp[4] = cfg;
  sp[5] = 0xFF; sp[6] = 0x0C; sp[7] = 0x10;
  sp[8] = dallasCrc8(sp, 8);
}

Ds18Result dec(int raw, uint8_t cfg = 0x7F) {
  uint8_t sp[9];
  makeSp(sp, raw, cfg);
  return decodeDs18Scratchpad(sp);
}

}  // namespace

static void test_crc8_known_vectors() {
  // Ví dụ trong Maxim AN27: ROM 02 1C B8 01 00 00 00 -> CRC A2
  const uint8_t rom[] = {0x02, 0x1C, 0xB8, 0x01, 0x00, 0x00, 0x00};
  TEST_ASSERT_EQUAL_HEX8(0xA2, dallasCrc8(rom, sizeof rom));
  // Scratchpad "vừa cấp điện" kinh điển của DS18B20: 50 05 4B 46 7F FF 0C 10 1C
  const uint8_t sp85[] = {0x50, 0x05, 0x4B, 0x46, 0x7F, 0xFF, 0x0C, 0x10};
  TEST_ASSERT_EQUAL_HEX8(0x1C, dallasCrc8(sp85, sizeof sp85));
  TEST_ASSERT_EQUAL_HEX8(0x00, dallasCrc8(nullptr, 0));
}

static void test_decode_datasheet_table() {
  // Bảng "Temperature/Data Relationship" trong datasheet DS18B20 (12 bit), đổi sang centi-độ.
  struct Row { int raw; int16_t centi; };
  const Row rows[] = {{0x07D0, 12500}, {0x0191, 2506}, {0x00A2, 1013}, {0x0008, 50}, {0x0000, 0},
                      {0xFFF8, -50}, {0xFF5E, -1013}, {0xFE6F, -2506}, {0xFC90, -5500}};
  for (const Row& r : rows) {
    const Ds18Result d = dec(r.raw);
    TEST_ASSERT_EQUAL(Ds18Status::Ok, d.status);
    TEST_ASSERT_EQUAL_INT16(r.centi, d.centi);
  }
}

static void test_decode_power_on_value_is_rejected() {
  const uint8_t sp[] = {0x50, 0x05, 0x4B, 0x46, 0x7F, 0xFF, 0x0C, 0x10, 0x1C};  // 85,0 °C lúc vừa cấp điện
  TEST_ASSERT_EQUAL(Ds18Status::PowerOnValue, decodeDs18Scratchpad(sp).status);
}

static void test_decode_rejects_all_zero_and_all_ff_and_bad_crc() {
  // Scratchpad toàn 0 có CRC = 0 (hợp lệ!) -> thư viện Dallas cho ra "0,0 °C" giả. Ta phải loại nhờ byte cố định.
  uint8_t zero[9] = {0};
  TEST_ASSERT_EQUAL_HEX8(0, dallasCrc8(zero, 8));
  TEST_ASSERT_EQUAL(Ds18Status::BadLayout, decodeDs18Scratchpad(zero).status);
  // Bus thả nổi (không cắm cảm biến / đứt dây): đọc ra toàn 0xFF
  uint8_t ff[9];
  memset(ff, 0xFF, sizeof ff);
  TEST_ASSERT_EQUAL(Ds18Status::BadCrc, decodeDs18Scratchpad(ff).status);
  // Một bit sai ở mỗi byte: luôn bị loại (CRC hoặc bố cục)
  uint8_t good[9];
  makeSp(good, 0xFE6F);  // -25,0625
  for (int byte = 0; byte < 9; byte++) {
    for (int bit = 0; bit < 8; bit++) {
      uint8_t bad[9];
      memcpy(bad, good, 9);
      bad[byte] = static_cast<uint8_t>(bad[byte] ^ (1u << bit));
      TEST_ASSERT_NOT_EQUAL(static_cast<int>(Ds18Status::Ok), static_cast<int>(decodeDs18Scratchpad(bad).status));
    }
  }
}

static void test_decode_layout_bytes_checked() {
  uint8_t sp[9];
  makeSp(sp, 0x0191);
  sp[5] = 0x00; sp[8] = dallasCrc8(sp, 8);  // CRC hợp lệ nhưng byte dành riêng sai
  TEST_ASSERT_EQUAL(Ds18Status::BadLayout, decodeDs18Scratchpad(sp).status);
  makeSp(sp, 0x0191);
  sp[7] = 0x00; sp[8] = dallasCrc8(sp, 8);
  TEST_ASSERT_EQUAL(Ds18Status::BadLayout, decodeDs18Scratchpad(sp).status);
  makeSp(sp, 0x0191, 0xFF);  // bit7 của thanh ghi cấu hình phải = 0
  TEST_ASSERT_EQUAL(Ds18Status::BadLayout, decodeDs18Scratchpad(sp).status);
}

static void test_decode_lower_resolution_masks_undefined_bits() {
  // 9 bit (cfg 0x1F): 3 bit thấp không xác định -> phải che đi. raw 0x0197 -> 0x0190 = 25,0 °C
  const Ds18Result d = dec(0x0197, 0x1F);
  TEST_ASSERT_EQUAL(Ds18Status::Ok, d.status);
  TEST_ASSERT_EQUAL_INT16(2500, d.centi);
  // 11 bit (cfg 0x5F): chỉ bit 0 không xác định
  TEST_ASSERT_EQUAL_INT16(2500, dec(0x0191, 0x5F).centi);  // 0x0191 -> 0x0190
}

static void test_decode_out_of_range() {
  // > +125: 0x0800 = 128 °C
  TEST_ASSERT_EQUAL(Ds18Status::OutOfRange, dec(0x0800).status);
  // < -55: 0xFC00 = -64 °C
  TEST_ASSERT_EQUAL(Ds18Status::OutOfRange, dec(0xFC00).status);
  // đúng biên
  TEST_ASSERT_EQUAL(Ds18Status::Ok, dec(0x07D0).status);
  TEST_ASSERT_EQUAL(Ds18Status::Ok, dec(0xFC90).status);
}

// ── Làm tròn / biên centi-độ ───────────────────────────────────────────────

static void test_celsius_to_centi_boundaries() {
  TEST_ASSERT_EQUAL_INT16(0, celsiusToCenti(-0.0f));
  TEST_ASSERT_EQUAL_INT16(0, celsiusToCenti(0.0f));
  TEST_ASSERT_EQUAL_INT16(-5500, celsiusToCenti(-55.0f));
  TEST_ASSERT_EQUAL_INT16(12500, celsiusToCenti(125.0f));
  TEST_ASSERT_EQUAL_INT16(-1950, celsiusToCenti(-19.5f));
  // Làm tròn nửa ra xa số 0, đối xứng
  TEST_ASSERT_EQUAL_INT16(13, celsiusToCenti(0.125f));    // 12,5 -> 13
  TEST_ASSERT_EQUAL_INT16(-13, celsiusToCenti(-0.125f));  // -12,5 -> -13
  TEST_ASSERT_EQUAL_INT16(6, celsiusToCenti(0.0625f));    // 6,25 -> 6
  TEST_ASSERT_EQUAL_INT16(-6, celsiusToCenti(-0.0625f));
  // Mọi giá trị 1/16 °C của DS18B20 đều khớp giải mã scratchpad (cùng một quy tắc làm tròn)
  for (int raw = -880; raw <= 2000; raw++) {
    const Ds18Result d = dec(raw);
    if (d.status != Ds18Status::Ok) continue;
    TEST_ASSERT_EQUAL_INT16(d.centi, celsiusToCenti(static_cast<float>(raw) / 16.0f));
  }
}

static void test_celsius_to_centi_saturates_never_overflows() {
  TEST_ASSERT_EQUAL_INT16(32767, celsiusToCenti(1e9f));
  TEST_ASSERT_EQUAL_INT16(-32768, celsiusToCenti(-1e9f));
  TEST_ASSERT_EQUAL_INT16(0, celsiusToCenti(NAN));
  TEST_ASSERT_EQUAL_INT16(32767, celsiusToCenti(INFINITY));
}

static void test_to_centi_only_for_valid_reads() {
  int16_t c = 123;
  TEST_ASSERT_TRUE(toCenti(-19.5f, c));
  TEST_ASSERT_EQUAL_INT16(-1950, c);
  TEST_ASSERT_FALSE(toCenti(-127.0f, c));
  TEST_ASSERT_FALSE(toCenti(85.0f, c));
  TEST_ASSERT_FALSE(toCenti(NAN, c));
  TEST_ASSERT_FALSE(toCenti(125.5f, c));
  TEST_ASSERT_FALSE(toCenti(-55.5f, c));
  TEST_ASSERT_TRUE(toCenti(125.0f, c));
  TEST_ASSERT_EQUAL_INT16(12500, c);
  TEST_ASSERT_TRUE(toCenti(-55.0f, c));
  TEST_ASSERT_EQUAL_INT16(-5500, c);
}

// ── Bộ lọc gai nhiễu ───────────────────────────────────────────────────────

static void test_filter_normal_drift_is_accepted_immediately() {
  ReadingFilter f;
  // Vừa khởi động: cần hai số đo khớp nhau (kể cả số đầu là gai)
  TEST_ASSERT_EQUAL(Verdict::Confirm, f.onSample(-1950, 100));
  TEST_ASSERT_EQUAL(Verdict::Accept, f.onSample(-1960, 102));
  // Sau đó dao động bình thường: nhận ngay, không trễ
  int16_t v = -1960;
  for (uint32_t t = 160; t < 160 + 60 * 30; t += 60) {
    v = static_cast<int16_t>(v + ((t / 60) % 2 ? 30 : -30));
    TEST_ASSERT_EQUAL(Verdict::Accept, f.onSample(v, t));
  }
}

static void test_filter_single_zero_spike_is_never_accepted() {
  ReadingFilter f;
  f.onSample(-2000, 0); f.onSample(-2005, 2);   // baseline -20
  TEST_ASSERT_EQUAL(Verdict::Accept, f.onSample(-2010, 60));
  // Gai 0,0 °C giữa dãy -20
  TEST_ASSERT_EQUAL(Verdict::Confirm, f.onSample(0, 120));
  TEST_ASSERT_TRUE(f.confirming());
  // Đo lại 2 s sau: về -20 -> gai bị loại, nhận số đo ĐÚNG
  TEST_ASSERT_EQUAL(Verdict::Accept, f.onSample(-2015, 122));
  TEST_ASSERT_EQUAL_INT16(-2015, f.lastAccepted());
  // Gai +40 °C tương tự
  TEST_ASSERT_EQUAL(Verdict::Confirm, f.onSample(4000, 180));
  TEST_ASSERT_EQUAL(Verdict::Accept, f.onSample(-2010, 182));
}

static void test_filter_spike_at_boot_never_accepted() {
  ReadingFilter f;
  TEST_ASSERT_EQUAL(Verdict::Confirm, f.onSample(0, 5));     // số đầu tiên là gai 0,0
  TEST_ASSERT_EQUAL(Verdict::Confirm, f.onSample(-1950, 7)); // đo lại: không khớp gai
  TEST_ASSERT_EQUAL(Verdict::Accept, f.onSample(-1955, 9));  // lần ba khớp lần hai
  TEST_ASSERT_EQUAL_INT16(-1955, f.lastAccepted());
}

static void test_filter_real_fast_warming_is_reported_within_seconds() {
  // Mở cửa tủ / máy nén hỏng: nhảy từ -20 lên -8 giữa hai lần đo (12 °C trong 1 phút).
  ReadingFilter f;
  f.onSample(-2000, 0); f.onSample(-2000, 2);
  TEST_ASSERT_EQUAL(Verdict::Accept, f.onSample(-2000, 60));
  TEST_ASSERT_EQUAL(Verdict::Confirm, f.onSample(-800, 120));      // nghi ngờ
  const uint32_t confirmAt = 120 + ReadingFilter::kConfirmDelayMs / 1000;
  TEST_ASSERT_EQUAL(Verdict::Accept, f.onSample(-790, confirmAt));  // đo lại khớp: THẬT -> ghi
  TEST_ASSERT_EQUAL_INT16(-790, f.lastAccepted());
  TEST_ASSERT_TRUE(confirmAt - 120 <= 3);                           // trễ tối đa vài giây
  // Từ đó ấm lên tiếp: nhận bình thường
  TEST_ASSERT_EQUAL(Verdict::Accept, f.onSample(-600, 180));
}

static void test_filter_slow_and_moderate_warming_has_no_delay() {
  ReadingFilter f;
  f.onSample(-2000, 0); f.onSample(-2000, 2);
  // Máy nén hỏng: +0,3 °C/phút, và 2 °C/phút lúc mở cửa: không bao giờ phải xác nhận
  int16_t v = -2000;
  uint32_t t = 60;
  for (int i = 0; i < 30; i++, t += 60) { v = static_cast<int16_t>(v + 30); TEST_ASSERT_EQUAL(Verdict::Accept, f.onSample(v, t)); }
  for (int i = 0; i < 8; i++, t += 60) { v = static_cast<int16_t>(v + 200); TEST_ASSERT_EQUAL(Verdict::Accept, f.onSample(v, t)); }
}

static void test_filter_random_garbage_is_rejected_after_attempts() {
  ReadingFilter f;
  f.onSample(-2000, 0); f.onSample(-2000, 2);
  TEST_ASSERT_EQUAL(Verdict::Confirm, f.onSample(3000, 60));
  TEST_ASSERT_EQUAL(Verdict::Confirm, f.onSample(-800, 62));   // không khớp gai, cũng không gần số cũ
  TEST_ASSERT_EQUAL(Verdict::Reject, f.onSample(1500, 64));    // vẫn loạn: bỏ chu kỳ
  TEST_ASSERT_FALSE(f.confirming());
  TEST_ASSERT_EQUAL_INT16(-2000, f.lastAccepted());            // baseline không bị đầu độc
  // Chu kỳ sau trở lại bình thường
  TEST_ASSERT_EQUAL(Verdict::Accept, f.onSample(-2005, 120));
}

static void test_filter_stale_pending_expires() {
  ReadingFilter f;
  f.onSample(-2000, 0); f.onSample(-2000, 2);
  TEST_ASSERT_EQUAL(Verdict::Confirm, f.onSample(-500, 60));
  // Vòng lặp bị chặn lâu, số đo tiếp theo tới sau 5 phút: không so với nghi ngờ cũ
  TEST_ASSERT_EQUAL(Verdict::Accept, f.onSample(-2000, 360));
}

static void test_filter_survives_monotonic_time_near_u32_wrap() {
  ReadingFilter f;
  const uint32_t t0 = 0xFFFFFFF0u;
  TEST_ASSERT_EQUAL(Verdict::Confirm, f.onSample(-2000, t0));
  TEST_ASSERT_EQUAL(Verdict::Accept, f.onSample(-2000, t0 + 2));  // qua mốc tràn: vẫn đúng
  TEST_ASSERT_EQUAL(Verdict::Accept, f.onSample(-1990, t0 + 62));
}

static void test_sensor_health_counts_rejects_as_faults() {
  SensorHealth h;
  h.onBad(); h.onBad();
  TEST_ASSERT_FALSE(h.faulty());
  h.onBad();
  TEST_ASSERT_TRUE(h.faulty());   // "probe fault" -> LED
  h.onGood();
  TEST_ASSERT_FALSE(h.faulty());
}

void run_sensor_tests() {
  RUN_TEST(test_crc8_known_vectors);
  RUN_TEST(test_decode_datasheet_table);
  RUN_TEST(test_decode_power_on_value_is_rejected);
  RUN_TEST(test_decode_rejects_all_zero_and_all_ff_and_bad_crc);
  RUN_TEST(test_decode_layout_bytes_checked);
  RUN_TEST(test_decode_lower_resolution_masks_undefined_bits);
  RUN_TEST(test_decode_out_of_range);
  RUN_TEST(test_celsius_to_centi_boundaries);
  RUN_TEST(test_celsius_to_centi_saturates_never_overflows);
  RUN_TEST(test_to_centi_only_for_valid_reads);
  RUN_TEST(test_filter_normal_drift_is_accepted_immediately);
  RUN_TEST(test_filter_single_zero_spike_is_never_accepted);
  RUN_TEST(test_filter_spike_at_boot_never_accepted);
  RUN_TEST(test_filter_real_fast_warming_is_reported_within_seconds);
  RUN_TEST(test_filter_slow_and_moderate_warming_has_no_delay);
  RUN_TEST(test_filter_random_garbage_is_rejected_after_attempts);
  RUN_TEST(test_filter_stale_pending_expires);
  RUN_TEST(test_filter_survives_monotonic_time_near_u32_wrap);
  RUN_TEST(test_sensor_health_counts_rejects_as_faults);
}
