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
constexpr size_t length(const char* s) { return *s ? 1 + length(s + 1) : 0; }
}  // namespace cfg_detail
static_assert(cfg_detail::startsWith(AUHONO_SERVER_URL, "https://"), "AUHONO_SERVER_URL phải bắt đầu bằng https://");
static_assert(AUHONO_SERVER_URL[cfg_detail::length(AUHONO_SERVER_URL) - 1] != '/', "AUHONO_SERVER_URL không được có dấu / ở cuối");

// ── Chân GPIO (ESP32-C3 loại nhỏ; đổi bằng build flag nếu bo của bạn khác) ──
// Chân strapping của ESP32-C3: GPIO2, GPIO8, GPIO9. Đọc README (mục "Đấu dây") trước khi đổi.
#ifndef ONEWIRE_PIN
#define ONEWIRE_PIN 4        // DATA của DS18B20 + điện trở kéo lên 4,7 kΩ về 3V3. GPIO4 KHÔNG phải chân strapping.
#endif
#ifndef LED_PIN
#define LED_PIN 8            // LED on-board của C3 SuperMini (GPIO8, sáng khi mức THẤP). GPIO8 là chân strapping nhưng
                             // LED nối 3V3 qua điện trở nên mức lúc reset vẫn = 1 (đúng yêu cầu), an toàn.
#endif
#ifndef LED_ACTIVE_LOW
#define LED_ACTIVE_LOW 1
#endif
#ifndef BUTTON_PIN
#define BUTTON_PIN 9         // nút BOOT on-board (mức thấp khi nhấn). GPIO9 strapping: giữ THẤP lúc cấp điện/reset = vào chế độ nạp!
#endif

// ── Nhịp hoạt động (docs/PROTOCOL.md) ──────────────────────────────────────
namespace cfg {
constexpr uint32_t kSampleIntervalMs = 60UL * 1000;         // đo mỗi 60 s
constexpr uint32_t kSensorConversionMs = 800;               // DS18B20 12-bit cần ~750 ms
constexpr uint32_t kUploadPeriodMs = 5UL * 60 * 1000;       // gửi gói định kỳ mỗi 5 phút
constexpr uint32_t kImmediateMinIntervalMs = 60UL * 1000;   // gửi ngay (vượt ngưỡng): tối đa 1 lần/60 s
constexpr size_t kBufferCapacity = 1440;                    // 24 giờ x 1 số đo/phút = 11,5 KB RAM
constexpr uint32_t kUploadStartJitterMaxMs = 20UL * 1000;   // trễ ngẫu nhiên (theo máy) trước lần gửi đầu sau khởi động
constexpr uint32_t kUploadContinueMs = 2000;                // còn tồn sau một lần flush (giới hạn gói/thời gian): gửi tiếp sau 2 s

// ── OTA ─────────────────────────────────────────────────────────────────────
constexpr uint32_t kOtaCheckIntervalMs = 6UL * 3600 * 1000; // hỏi OTA mỗi ~6 giờ
constexpr uint32_t kOtaDeferredRetryMs = 5UL * 60 * 1000;   // có bản mới nhưng đang hoãn (còn số đo/vượt ngưỡng...): hỏi lại sau 5 phút
constexpr uint32_t kOtaDownloadTimeoutMs = 4UL * 60 * 1000; // tải quá 4 phút là bỏ (đo/gửi bị tạm dừng trong lúc tải)
constexpr uint32_t kOtaFirstBytesTimeoutMs = 10UL * 1000;   // chờ tiêu đề ảnh (36 byte đầu)

// ── Độ bền: thời hạn của mọi thao tác chặn phải cộng lại < kWdtTimeoutS ─────
// Một request HTTPS tệ nhất: DNS (lwIP tới ~15-30 s) + TCP connect + bắt tay TLS + chờ tiêu đề + đọc body.
constexpr uint32_t kWdtTimeoutS = 120;                      // task watchdog: reset nếu loop() đứng > 120 s
constexpr uint32_t kHttpConnectTimeoutMs = 8000;
constexpr uint32_t kTlsHandshakeTimeoutS = 12;
constexpr uint32_t kHttpTimeoutMs = 10000;                  // chờ tiêu đề phản hồi
constexpr uint32_t kBodyReadTimeoutMs = 8000;               // đọc body
constexpr size_t kMaxResponseBytes = 2048;
constexpr uint32_t kNtpWaitMs = 20000;                      // NTP im lặng quá 20 s thì hỏi GET /v1/time

// ── Cổng cấu hình Wi-Fi ─────────────────────────────────────────────────────
constexpr uint32_t kPortalIdleTimeoutMs = 10UL * 60 * 1000; // đóng nếu 10 phút không có yêu cầu nào (đã có Wi-Fi lưu)
constexpr uint32_t kPortalHardCapMs = 30UL * 60 * 1000;     // trần tuyệt đối 30 phút cho một lần mở (đã có Wi-Fi lưu)
constexpr uint32_t kPortalAutoCloseGraceMs = 30UL * 1000;   // cổng tự mở: đóng khi Wi-Fi đã nối lại và không ai kết nối
constexpr uint32_t kPortalRequestDeadlineMs = 6000;         // mỗi kết nối HTTP phải xong trong 6 s (chống slowloris)
constexpr uint8_t kPortalMaxClients = 3;                    // số kết nối HTTP đồng thời
constexpr uint32_t kSavedGraceMs = 2000;                    // chờ điện thoại nhận trang "Đã lưu" trước khi tắt AP

// ── Sức khỏe ────────────────────────────────────────────────────────────────
constexpr uint32_t kHeapCheckIntervalMs = 30UL * 1000;
constexpr uint32_t kHeapLogIntervalMs = 30UL * 60 * 1000;
constexpr uint8_t kLowHeapStrikesNotCritical = 20;          // 20 x 30 s = 10 phút heap không đủ mở TLS
constexpr uint64_t kSeqStride = 64;                         // xem seq_counter.h (mòn flash)
}  // namespace cfg
