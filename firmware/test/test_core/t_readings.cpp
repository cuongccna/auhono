#include <unity.h>

#include <cmath>
#include <cstring>
#include <limits>
#include <string>

#include "auhono/readings.h"

using namespace auhono;

static Reading R(uint32_t t, int16_t c) { return Reading{t, c}; }

// ── Lọc số đo lỗi ──────────────────────────────────────────────────────────

static void test_invalid_reads_are_rejected() {
  TEST_ASSERT_EQUAL(ReadStatus::Disconnected, classifyCelsius(-127.0f));  // đứt dây
  TEST_ASSERT_EQUAL(ReadStatus::PowerOnReset, classifyCelsius(85.0f));    // vừa cấp điện
  TEST_ASSERT_EQUAL(ReadStatus::NotANumber, classifyCelsius(std::numeric_limits<float>::quiet_NaN()));
  TEST_ASSERT_EQUAL(ReadStatus::NotANumber, classifyCelsius(std::numeric_limits<float>::infinity()));
  TEST_ASSERT_EQUAL(ReadStatus::OutOfRange, classifyCelsius(-56.0f));
  TEST_ASSERT_EQUAL(ReadStatus::OutOfRange, classifyCelsius(126.0f));
}

static void test_valid_reads_are_accepted() {
  TEST_ASSERT_EQUAL(ReadStatus::Ok, classifyCelsius(-19.5f));
  TEST_ASSERT_EQUAL(ReadStatus::Ok, classifyCelsius(0.0f));
  TEST_ASSERT_EQUAL(ReadStatus::Ok, classifyCelsius(84.9375f));  // sát 85 nhưng là số đo thật
  TEST_ASSERT_EQUAL(ReadStatus::Ok, classifyCelsius(-55.0f));
  TEST_ASSERT_EQUAL(ReadStatus::Ok, classifyCelsius(125.0f));
}

static void test_sensor_health_needs_consecutive_faults() {
  SensorHealth h;
  h.onRead(ReadStatus::Disconnected);
  h.onRead(ReadStatus::Disconnected);
  TEST_ASSERT_FALSE(h.faulty());
  h.onRead(ReadStatus::Ok);  // đọc tốt xóa chuỗi lỗi
  h.onRead(ReadStatus::PowerOnReset);
  h.onRead(ReadStatus::PowerOnReset);
  TEST_ASSERT_FALSE(h.faulty());
  h.onRead(ReadStatus::NotANumber);
  TEST_ASSERT_TRUE(h.faulty());
  h.onRead(ReadStatus::Ok);
  TEST_ASSERT_FALSE(h.faulty());
}

static void test_celsius_to_centi_rounding() {
  TEST_ASSERT_EQUAL_INT16(-1950, celsiusToCenti(-19.5f));
  TEST_ASSERT_EQUAL_INT16(406, celsiusToCenti(4.0625f));   // 65/16 độ (bước 0,0625 của DS18B20)
  TEST_ASSERT_EQUAL_INT16(-1806, celsiusToCenti(-18.0625f));
  TEST_ASSERT_EQUAL_INT16(0, celsiusToCenti(0.001f));
}

// ── Bộ đệm vòng ────────────────────────────────────────────────────────────

static void test_buffer_overflow_drops_oldest() {
  ReadingBuffer buf(5);
  for (uint32_t i = 1; i <= 8; i++) buf.push(R(i, static_cast<int16_t>(i)));
  TEST_ASSERT_EQUAL_UINT(5, buf.size());
  TEST_ASSERT_EQUAL_UINT32(3, buf.droppedOverflow());
  Reading out[5];
  TEST_ASSERT_EQUAL_UINT(5, buf.peek(out, 5));
  for (uint32_t i = 0; i < 5; i++) TEST_ASSERT_EQUAL_UINT32(4 + i, out[i].t);  // còn lại 4..8, cũ -> mới
}

static void test_buffer_full_day_capacity() {
  ReadingBuffer buf(1440);  // 24 giờ x 60 phút
  for (uint32_t i = 0; i < 1500; i++) buf.push(R(1800000000u + i * 60, -1900));
  TEST_ASSERT_EQUAL_UINT(1440, buf.size());
  Reading first;
  buf.peek(&first, 1);
  TEST_ASSERT_EQUAL_UINT32(1800000000u + 60 * 60, first.t);  // 60 số đo cũ nhất đã bị bỏ
}

static void test_batching_is_oldest_first_and_max_20() {
  ReadingBuffer buf(100);
  for (uint32_t i = 0; i < 45; i++) buf.push(R(1000 + i, 0));

  Reading batch[kMaxBatch];
  size_t n = buf.peek(batch, kMaxBatch);
  TEST_ASSERT_EQUAL_UINT(20, n);
  TEST_ASSERT_EQUAL_UINT32(1000, batch[0].t);
  TEST_ASSERT_EQUAL_UINT32(1019, batch[19].t);
  TEST_ASSERT_EQUAL_UINT(45, buf.size());  // peek không xóa (gửi lỗi thì còn nguyên)

  buf.popFront(n);
  n = buf.peek(batch, kMaxBatch);
  TEST_ASSERT_EQUAL_UINT(20, n);
  TEST_ASSERT_EQUAL_UINT32(1020, batch[0].t);
  buf.popFront(n);
  n = buf.peek(batch, kMaxBatch);
  TEST_ASSERT_EQUAL_UINT(5, n);
  TEST_ASSERT_EQUAL_UINT32(1040, batch[0].t);
  buf.popFront(n);
  TEST_ASSERT_TRUE(buf.empty());
}

static void test_buffer_wraparound_keeps_order() {
  ReadingBuffer buf(4);
  for (uint32_t i = 0; i < 3; i++) buf.push(R(i, 0));
  buf.popFront(2);                              // còn {2}
  for (uint32_t i = 3; i < 6; i++) buf.push(R(i, 0));  // {2,3,4,5} - đã quay vòng
  Reading out[4];
  TEST_ASSERT_EQUAL_UINT(4, buf.peek(out, 4));
  for (uint32_t i = 0; i < 4; i++) TEST_ASSERT_EQUAL_UINT32(2 + i, out[i].t);
}

static void test_drop_older_than() {
  ReadingBuffer buf(10);
  for (uint32_t i = 0; i < 6; i++) buf.push(R(100 + i, 0));
  TEST_ASSERT_EQUAL_UINT(3, buf.dropOlderThan(103));
  Reading out[10];
  TEST_ASSERT_EQUAL_UINT(3, buf.peek(out, 10));
  TEST_ASSERT_EQUAL_UINT32(103, out[0].t);
  TEST_ASSERT_EQUAL_UINT(0, buf.dropOlderThan(50));
}

static void test_pop_more_than_size_is_safe() {
  ReadingBuffer buf(4);
  buf.push(R(1, 0));
  buf.popFront(10);
  TEST_ASSERT_TRUE(buf.empty());
  buf.push(R(2, 0));
  Reading r;
  TEST_ASSERT_EQUAL_UINT(1, buf.peek(&r, 1));
  TEST_ASSERT_EQUAL_UINT32(2, r.t);
}

// ── Định dạng & JSON ───────────────────────────────────────────────────────

static std::string fmt(int16_t c) {
  char b[16];
  size_t n = formatCenti(c, b, sizeof b);
  TEST_ASSERT_TRUE(n > 0);
  return std::string(b, n);
}

static void test_format_centi() {
  TEST_ASSERT_EQUAL_STRING("-19.5", fmt(-1950).c_str());
  TEST_ASSERT_EQUAL_STRING("4.05", fmt(405).c_str());
  TEST_ASSERT_EQUAL_STRING("4.0", fmt(400).c_str());
  TEST_ASSERT_EQUAL_STRING("-0.05", fmt(-5).c_str());
  TEST_ASSERT_EQUAL_STRING("0.0", fmt(0).c_str());
  TEST_ASSERT_EQUAL_STRING("-18.06", fmt(-1806).c_str());
  TEST_ASSERT_EQUAL_STRING("125.0", fmt(12500).c_str());
  TEST_ASSERT_EQUAL_STRING("-55.0", fmt(-5500).c_str());
  char tiny[3];
  TEST_ASSERT_EQUAL_UINT(0, formatCenti(-1950, tiny, sizeof tiny));  // bộ đệm quá nhỏ
}

static WireReading W(uint32_t t, int16_t c) { return WireReading{t, c}; }

static std::string body(const char* fw, const WireReading* r, size_t n) {
  char buf[1024];
  size_t len = buildReadingsBody(buf, sizeof buf, fw, r, n);
  TEST_ASSERT_TRUE(len > 0);
  TEST_ASSERT_EQUAL_UINT(strlen(buf), len);
  return std::string(buf, len);
}

static void test_body_matches_protocol_vector_bytes() {
  const WireReading r = W(1800000000u, -1950);
  // Khớp từng byte với body trong docs/PROTOCOL.md (không có "fw").
  TEST_ASSERT_EQUAL_STRING("{\"readings\":[{\"t\":1800000000,\"c\":-19.5}]}", body(nullptr, &r, 1).c_str());
  TEST_ASSERT_EQUAL_STRING("{\"readings\":[{\"t\":1800000000,\"c\":-19.5}]}", body("", &r, 1).c_str());
}

static void test_body_with_fw_and_multiple_readings() {
  const WireReading r[] = {W(1800000000u, -1950), W(1800000060u, -1900), W(1800000120u, 405)};
  TEST_ASSERT_EQUAL_STRING(
      "{\"fw\":\"1.0.0\",\"readings\":[{\"t\":1800000000,\"c\":-19.5},{\"t\":1800000060,\"c\":-19.0},{\"t\":1800000120,\"c\":4.05}]}",
      body("1.0.0", r, 3).c_str());
}

static void test_body_sanitizes_fw_and_bounds() {
  const WireReading r = W(1800000000u, 0);
  // Ký tự có thể phá JSON (nháy kép, gạch chéo ngược, xuống dòng) bị thay bằng '_'.
  const std::string b = body("a\"b\nc\\d", &r, 1);
  TEST_ASSERT_TRUE(b.find("\"fw\":\"a_b_c_d\"") != std::string::npos);
  // fw dài hơn 32 bị cắt (server: max 32)
  const std::string longFw(50, 'v');
  const std::string b2 = body(longFw.c_str(), &r, 1);
  TEST_ASSERT_TRUE(b2.find("\"fw\":\"" + std::string(32, 'v') + "\"") != std::string::npos);
}

static void test_body_rejects_bad_sizes() {
  char buf[1024];
  const WireReading many[21] = {};
  TEST_ASSERT_EQUAL_UINT(0, buildReadingsBody(buf, sizeof buf, "1", many, 0));
  TEST_ASSERT_EQUAL_UINT(0, buildReadingsBody(buf, sizeof buf, "1", many, 21));
  char small[20];
  TEST_ASSERT_EQUAL_UINT(0, buildReadingsBody(small, sizeof small, "1", many, 1));
  TEST_ASSERT_TRUE(buildReadingsBody(buf, sizeof buf, "1", many, 20) > 0);
}

static void test_body_worst_case_fits_server_limit() {
  WireReading many[20];
  for (int i = 0; i < 20; i++) many[i] = W(4294967295u, -5500);
  char buf[1024];
  const size_t len = buildReadingsBody(buf, sizeof buf, "1.10.100-rc1+build", many, 20);
  TEST_ASSERT_TRUE(len > 0 && len < 4096);
}

void run_readings_tests() {
  RUN_TEST(test_invalid_reads_are_rejected);
  RUN_TEST(test_valid_reads_are_accepted);
  RUN_TEST(test_sensor_health_needs_consecutive_faults);
  RUN_TEST(test_celsius_to_centi_rounding);
  RUN_TEST(test_buffer_overflow_drops_oldest);
  RUN_TEST(test_buffer_full_day_capacity);
  RUN_TEST(test_batching_is_oldest_first_and_max_20);
  RUN_TEST(test_buffer_wraparound_keeps_order);
  RUN_TEST(test_drop_older_than);
  RUN_TEST(test_pop_more_than_size_is_safe);
  RUN_TEST(test_format_centi);
  RUN_TEST(test_body_matches_protocol_vector_bytes);
  RUN_TEST(test_body_with_fw_and_multiple_readings);
  RUN_TEST(test_body_sanitizes_fw_and_bounds);
  RUN_TEST(test_body_rejects_bad_sizes);
  RUN_TEST(test_body_worst_case_fits_server_limit);
}
