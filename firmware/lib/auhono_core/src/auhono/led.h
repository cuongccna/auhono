// Chọn trạng thái đèn LED và mẫu nhấp nháy. Hàm thuần: cùng đầu vào -> cùng kết quả.
// Bảng ý nghĩa cho người dùng nằm trong firmware/README.md.
#pragma once
#include <cstdint>

namespace auhono {

enum class LedState : uint8_t {
  NoIdentity,     // chưa nạp mã/khóa thiết bị: 3 nháy ngắn rồi nghỉ
  Setup,          // đang phát Wi-Fi cấu hình: nháy nhanh
  Connecting,     // đang kết nối Wi-Fi / chờ lần gửi đầu: nháy chậm
  Online,         // trực tuyến, lần gửi gần nhất thành công: sáng liên tục
  ServerProblem,  // có Wi-Fi nhưng server từ chối / lỗi / lệch giờ: nháy đôi
  SensorFault,    // cảm biến lỗi: sáng, thỉnh thoảng tắt ngắn
};

enum class UploadStatus : uint8_t { Unknown, Ok, Failed };

struct LedInputs {
  bool hasIdentity = true;
  bool portalActive = false;
  bool wifiConnected = false;
  bool sensorFault = false;
  UploadStatus upload = UploadStatus::Unknown;
};

/// Thứ tự ưu tiên: thiếu danh tính > chế độ cấu hình > lỗi cảm biến > chưa có Wi-Fi/chưa gửi
/// lần nào > server có vấn đề > bình thường.
LedState selectLedState(const LedInputs& in);

/// Đèn có sáng tại thời điểm `tMs` (millis) không.
bool ledOn(LedState state, uint32_t tMs);

}  // namespace auhono
