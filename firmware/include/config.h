// Cấu hình biên dịch của firmware Auhono. Đổi qua build_flags trong platformio.ini (không sửa file này).
#pragma once
#include <stddef.h>
#include <stdint.h>

// ── Phiên bản & server (build flag) ────────────────────────────────────────
#ifndef AUHONO_FW_VERSION
#define AUHONO_FW_VERSION "0.0.0-dev"
#endif

#ifndef AUHONO_SERVER_URL
#error "Thiếu -DAUHONO_SERVER_URL=\"https://<ten-mien-server>\" (không có dấu / ở cuối). Xem platformio.ini."
#endif

// Luôn HTTPS. Kiểm tra ngay lúc biên dịch: build_flags gõ nhầm "http://" sẽ không biên dịch được.
namespace cfg_detail {
constexpr bool startsWith(const char* s, const char* prefix) {
  return *prefix == '\0' || (*s == *prefix && startsWith(s + 1, prefix + 1));
}
}  // namespace cfg_detail
static_assert(cfg_detail::startsWith(AUHONO_SERVER_URL, "https://"), "AUHONO_SERVER_URL phải bắt đầu bằng https://");

// ── Chân GPIO (ESP32-C3 loại nhỏ; đổi bằng build flag nếu bo của bạn khác) ──
#ifndef ONEWIRE_PIN
#define ONEWIRE_PIN 4        // DATA của DS18B20 + điện trở kéo lên 4,7 kΩ về 3V3
#endif
#ifndef LED_PIN
#define LED_PIN 8            // LED on-board (nhiều bo C3 SuperMini: GPIO8, sáng khi mức THẤP)
#endif
#ifndef LED_ACTIVE_LOW
#define LED_ACTIVE_LOW 1
#endif
#ifndef BUTTON_PIN
#define BUTTON_PIN 9         // nút BOOT on-board (mức thấp khi nhấn). Không nhấn giữ lúc cấp điện!
#endif

// ── Nhịp hoạt động (docs/PROTOCOL.md) ──────────────────────────────────────
namespace cfg {
constexpr uint32_t kSampleIntervalMs = 60UL * 1000;         // đo mỗi 60 s
constexpr uint32_t kSensorConversionMs = 800;               // DS18B20 12-bit cần ~750 ms
constexpr uint32_t kUploadPeriodMs = 5UL * 60 * 1000;       // gửi gói định kỳ mỗi 5 phút
constexpr uint32_t kImmediateMinIntervalMs = 60UL * 1000;   // gửi ngay (vượt ngưỡng): tối đa 1 lần/60 s
constexpr size_t kBufferCapacity = 1440;                    // 24 giờ x 1 số đo/phút = 11,5 KB RAM
constexpr uint32_t kOtaCheckIntervalMs = 6UL * 3600 * 1000; // hỏi OTA mỗi ~6 giờ
constexpr uint32_t kOtaDownloadTimeoutMs = 10UL * 60 * 1000;
constexpr uint32_t kOtaMinFreeHeap = 60UL * 1024;           // dưới mức này thì không tải (TLS cần ~40 KB)

// ── Độ bền ──────────────────────────────────────────────────────────────────
constexpr uint32_t kWdtTimeoutS = 60;                       // task watchdog: reset nếu loop() đứng > 60 s
constexpr uint32_t kHttpConnectTimeoutMs = 10000;
constexpr uint32_t kHttpTimeoutMs = 15000;
constexpr size_t kMaxResponseBytes = 2048;
constexpr uint32_t kNtpWaitMs = 20000;                      // NTP im lặng quá 20 s thì hỏi GET /v1/time
constexpr uint32_t kTimeFallbackRetryMs = 60000;
constexpr uint32_t kWifiFailToPortalMs = 20UL * 60 * 1000;  // mất Wi-Fi đã lưu > 20 phút => mở lại cổng cấu hình
constexpr uint32_t kPortalTimeoutMs = 10UL * 60 * 1000;     // cổng cấu hình tự đóng sau 10 phút không ai lưu
constexpr uint32_t kNoContactRestartMs = 12UL * 3600 * 1000;  // 12 giờ không liên lạc được server => khởi động lại
constexpr uint32_t kRollbackWindowMs = 15UL * 60 * 1000;    // bản OTA mới phải liên lạc được server trong 15 phút
constexpr uint64_t kSeqStride = 64;                         // xem seq_counter.h (mòn flash)
}  // namespace cfg
