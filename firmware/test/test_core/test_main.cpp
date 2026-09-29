// Điểm vào của bộ test native (Unity). Chạy: `pio test -e native` trong thư mục firmware/.
#include <unity.h>

void run_protocol_tests();
void run_seq_tests();
void run_readings_tests();
void run_backoff_policy_tests();
void run_reply_tests();
void run_portal_led_tests();
void run_client_tests();
void run_sensor_tests();
void run_scenario_tests();
void run_wifi_tests();
void run_portal_http_tests();
void run_ota_tests();
void run_fuzz_tests();
void run_ap_diag_tests();

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
  run_sensor_tests();
  run_scenario_tests();
  run_wifi_tests();
  run_portal_http_tests();
  run_ota_tests();
  run_fuzz_tests();
  run_ap_diag_tests();
  return UNITY_END();
}
