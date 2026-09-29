// Nhịp tim khi đầu dò hỏng (docs/PROTOCOL.md, "Gói nhịp tim và chẩn đoán"): nếu quá 5 phút không có số đo HỢP LỆ (đứt dây,
// cảm biến hỏng, bộ lọc nhiễu loại liên tục) mà chỉ im lặng thì server chỉ thấy "mất kết nối" (giống mất điện). Thay vào đó máy gửi
// gói `readings: []` + `diag` (sensor: fault, fault_s) mỗi 5 phút để server báo riêng "lỗi cảm biến".
//
// Lịch gửi dùng CHÍNH UploadPolicy (định kỳ 5 phút, trễ khởi động ngẫu nhiên, backoff khi lỗi): main chỉ cần coi "đang lỗi đầu dò
// >= 5 phút" như "có dữ liệu để gửi". Nhịp tim không đụng tới bộ đệm số đo: còn số đo trong bộ đệm thì gói số đo bình thường (kèm
// diag) đi trước; nhịp tim chỉ dùng khi bộ đệm rỗng.
#pragma once
#include <cstdint>

namespace auhono {

constexpr uint32_t kHeartbeatFaultAfterS = 300;  // 5 phút không có số đo hợp lệ => lỗi đầu dò

/// Theo dõi lần cuối có số đo hợp lệ (giờ đơn điệu, giây). Mốc ban đầu = lúc khởi động (mono 0): đầu dò hỏng ngay từ đầu cũng
/// bị coi là lỗi sau 5 phút. Hiệu số uint32 nên đúng cả khi giờ đơn điệu rất lớn.
class SensorWatch {
 public:
  void onValidReading(uint32_t monoS) { lastValid_ = monoS; }
  /// Số giây kể từ số đo hợp lệ cuối cùng (hoặc kể từ lúc khởi động nếu chưa có).
  uint32_t secondsSinceValid(uint32_t monoS) const { return static_cast<uint32_t>(monoS - lastValid_); }
  bool faulty(uint32_t monoS) const { return secondsSinceValid(monoS) >= kHeartbeatFaultAfterS; }

 private:
  uint32_t lastValid_ = 0;
};

}  // namespace auhono
