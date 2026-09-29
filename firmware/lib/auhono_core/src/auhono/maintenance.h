// Chính sách "giữ máy khỏe" chạy nhiều năm không ai đụng tới: heap, khởi động lại có kế hoạch, cứu hộ kết nối.
// Thuần túy để test được; tầng src/ chỉ đo (heap, thời gian) rồi làm theo quyết định.
#pragma once
#include <cstddef>
#include <cstdint>

namespace auhono {

/// Lý do khởi động lại CHỦ ĐỘNG (ghi NVS trước khi restart để log lần khởi động sau còn biết vì sao).
enum class RebootReason : uint8_t {
  None = 0,
  Planned = 1,       // khởi động lại định kỳ (uptime dài, đang rảnh)
  LowHeap = 2,       // heap quá thấp không mở nổi TLS
  NoContact = 3,     // nhiều giờ không liên lạc được server dù Wi-Fi báo đã nối
  OtaInstalled = 4,  // vừa cài firmware mới
  Rollback = 5,      // quay về firmware cũ
  PortalFault = 6,
};
const char* rebootReasonText(RebootReason r);

// ── Heap và TLS ────────────────────────────────────────────────────────────
// Mỗi phiên TLS cần 2 vùng liên tục ~16,6 KB (bộ đệm vào/ra của mbedtls, MBEDTLS_SSL_MAX_CONTENT_LEN=16384)
// cộng ~20-30 KB cho bắt tay + nạp bộ CA. Kiểm cả TỔNG heap trống lẫn KHỐI LIỀN LỚN NHẤT (phân mảnh).
constexpr uint32_t kMinFreeHeapForTls = 56u * 1024u;
constexpr uint32_t kMinBlockForTls = 20u * 1024u;
/// Dưới mức này (liên tiếp kMaxLowHeapStrikes lần thử) thì khởi động lại có lý do.
constexpr uint32_t kCriticalFreeHeap = 40u * 1024u;
constexpr uint32_t kCriticalBlock = 18u * 1024u;
constexpr uint8_t kMaxLowHeapStrikes = 3;

inline bool tlsHeapOk(uint32_t freeHeap, uint32_t maxBlock) {
  return freeHeap >= kMinFreeHeapForTls && maxBlock >= kMinBlockForTls;
}
inline bool heapCritical(uint32_t freeHeap, uint32_t maxBlock) {
  return freeHeap < kCriticalFreeHeap || maxBlock < kCriticalBlock;
}

// ── Khởi động lại ──────────────────────────────────────────────────────────
struct MaintenanceInputs {
  uint32_t uptimeS = 0;
  size_t bufferCount = 0;        // số đo chưa gửi trong RAM
  bool lastUploadOk = false;
  uint32_t sinceContactS = 0;    // giây kể từ lần liên lạc server thành công (0 nếu vừa xong)
  bool wifiUp = false;
  bool breachActive = false;     // đang có số đo vượt ngưỡng
  bool portalActive = false;
  bool otaBusy = false;
  uint8_t lowHeapStrikes = 0;
};

constexpr uint32_t kPlannedRebootAfterS = 7u * 24u * 3600u;     // 7 ngày, chỉ khi rảnh
constexpr uint32_t kForcedRebootAfterS = 14u * 24u * 3600u;     // 14 ngày dù còn tồn (vẫn không khi đang cấu hình/OTA)
constexpr uint32_t kNoContactRebootS = 12u * 3600u;             // 12 giờ Wi-Fi báo nối mà không liên lạc được server
constexpr size_t kPlannedRebootMaxBacklog = 2;                  // "rảnh" = tối đa ngần này số đo chưa gửi
constexpr uint32_t kPlannedRebootMaxSinceContactS = 15u * 60u;

/// Có nên khởi động lại ngay bây giờ không, và vì sao (None = không).
///  - LowHeap: heap nguy kịch liên tiếp nhiều lần (không mở nổi TLS thì cũng không gửi/báo được gì).
///  - NoContact: Wi-Fi báo nối nhưng 12 giờ không có phản hồi hợp lệ từ server (leo thang từ chu trình Wi-Fi 30 phút/2 giờ).
///  - Planned: uptime >= 7 ngày VÀ rảnh (không tồn số đo, lần gửi gần nhất tốt, không đang vượt ngưỡng/cấu hình/OTA);
///    >= 14 ngày thì bất kể tồn đọng. Lý do: chống phân mảnh heap/rò rỉ tích lũy và tránh số học millis() 32 bit ở gần 24,8 ngày.
/// Tồn số đo trong RAM sẽ mất khi khởi động lại nên các lý do "có kế hoạch" chỉ chạy lúc rảnh.
RebootReason decideReboot(const MaintenanceInputs& in);

// ── Cứu hộ kết nối khi mất liên lạc server (không khởi động lại, không mất số đo) ──
enum class RecoveryStep : uint8_t { None, CycleWifi, RestartWifiDriver };
constexpr uint32_t kCycleWifiAfterS = 30u * 60u;
constexpr uint32_t kRestartWifiAfterS = 2u * 3600u;

/// `stage` là số bước đã làm (0..2) trong đợt mất liên lạc hiện tại; reset về 0 khi liên lạc lại được.
/// Trả bước cần làm bây giờ và tăng `stage`.
RecoveryStep nextRecoveryStep(uint32_t sinceContactS, uint8_t& stage);

// ── Chế độ cứu hộ OTA khi chuỗi chứng chỉ TLS hỏng nhiều năm sau ─────────────────────────────
/// Nếu CA gốc của server đổi mà firmware cũ không có, MỌI kết nối TLS xác thực đều hỏng và OTA (cách duy nhất để
/// cập nhật bộ CA) cũng hỏng theo. Lối thoát: sau một chuỗi dài lần thất bại vì CHỨNG CHỈ, cho phép RIÊNG việc kiểm tra +
/// tải OTA chạy không xác thực chứng chỉ — an toàn vì ảnh firmware được xác thực bằng chữ ký ECDSA độc lập với TLS
/// (và chỉ nhận phiên bản MỚI HƠN), không gửi số đo qua kênh đó.
class TlsRescue {
 public:
  static constexpr uint16_t kCertFailuresToRescue = 12;  // >= ~1 giờ ở nhịp 5 phút
  void onAttempt(bool success, bool certError, bool gotHttpStatus) {
    if (success || gotHttpStatus) { certFailures_ = 0; return; }   // TLS hoạt động: không phải lỗi chứng chỉ
    if (certError && certFailures_ < 0xFFFF) ++certFailures_;
  }
  bool rescueAllowed() const { return certFailures_ >= kCertFailuresToRescue; }
  uint16_t certFailures() const { return certFailures_; }

 private:
  uint16_t certFailures_ = 0;
};

}  // namespace auhono
