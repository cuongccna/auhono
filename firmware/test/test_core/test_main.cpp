// Điểm vào của bộ test native (Unity). Chạy: `pio test -e native` trong thư mục firmware/.
#include <unity.h>

void run_protocol_tests();
void run_seq_tests();
void run_readings_tests();
void run_backoff_policy_tests();
void run_reply_tests();
void run_portal_led_tests();
void run_client_tests();

void setUp() {}
void tearDown() {}

int main(int, char**) {
  UNITY_BEGIN();
  run_protocol_tests();
  run_seq_tests();
  run_readings_tests();
  run_backoff_policy_tests();
  run_reply_tests();
  run_portal_led_tests();
  run_client_tests();
  return UNITY_END();
}
