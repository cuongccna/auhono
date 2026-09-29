// Chọn trạng thái đèn LED và mẫu nhấp nháy. Hàm thuần: cùng đầu vào -> cùng kết quả.
// Bảng ý nghĩa cho người dùng nằm trong firmware/README.md.
#pragma once
#include <cstdint>

#include "auhono/wifi_policy.h"

namespace auhono {

enum class LedState : uint8_t {
  NoIdentity,     // chưa nạp mã/khóa thiết bị: 3 nháy ngắn rồi nghỉ
  WipeArmed,      // đang giữ nút >= 15 s: nháy rất nhanh (10 Hz) = "nhả nút bây giờ sẽ xóa Wi-Fi đã lưu"
  Setup,          // đang phát Wi-Fi cấu hình: nháy nhanh
  Connecting,     // đang kết nối Wi-Fi / chờ lần gửi đầu: nháy chậm
  WifiNotFound,   // không thấy Wi-Fi đã lưu (sai tên / router tắt / chỉ 5 GHz): 1 nháy ngắn mỗi 2 s
  WifiAuthFailed, // thấy Wi-Fi nhưng bị từ chối (sai mật khẩu): 1 nháy dài + 1 nháy ngắn
  Online,         // trực tuyến, lần gửi gần nhất thành công: sáng liên tục
  ServerProblem,  // có Wi-Fi nhưng server từ chối / lỗi / lệch giờ: nháy đôi
  SensorFault,    // cảm biến lỗi: sáng, thỉnh thoảng tắt ngắn
};

enum class UploadStatus : uint8_t { Unknown, Ok, Failed };

struct LedInputs {
  bool hasIdentity = true;
  bool wipeArmed = false;
  bool portalActive = false;
  bool wifiConnected = false;
  bool sensorFault = false;
  UploadStatus upload = UploadStatus::Unknown;
  WifiFail wifiFail = WifiFail::None;   // lý do chưa nối được (chỉ dùng khi !wifiConnected)
};

/// Thứ tự ưu tiên: đang giữ nút để xóa Wi-Fi > thiếu danh tính > chế độ cấu hình > lỗi cảm biến > chưa có Wi-Fi (phân biệt "không thấy mạng" /
/// "sai mật khẩu") > chưa gửi lần nào > server có vấn đề > bình thường.
LedState selectLedState(const LedInputs& in);

/// Đèn có sáng tại thời điểm `tMs` (millis) không.
bool ledOn(LedState state, uint32_t tMs);

}  // namespace auhono
