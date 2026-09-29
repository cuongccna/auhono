// Bộ lọc "gai nhiễu" cho số đo nhiệt độ, KHÔNG làm chậm báo động thật.
//
// Vấn đề: cáp DS18B20 dài trong ngăn tủ nhiễu điện thỉnh thoảng cho ra một số đo rác (0,0 hoặc +40 °C)
// giữa dãy -20 °C. Gửi số rác đó lên server có thể gây cảnh báo giả (khách vứt hàng oan) hoặc che mất
// diễn biến thật.
//
// Cách làm (thay vì lấy trung vị 3 làm chậm mọi số đo): so với số đo được chấp nhận gần nhất.
//   - Nhảy nhỏ (<= kJumpCenti) -> nhận ngay, không trễ.
//   - Nhảy lớn -> "nghi ngờ": KHÔNG ghi, xin đo lại sau vài giây (Verdict::Confirm).
//       * Số đo lại về gần số cũ (<= kJumpCenti) -> số nghi ngờ là gai nhiễu -> nhận số đo lại (đúng).
//       * Số đo lại gần số nghi ngờ (<= kAgreeCenti) -> đây là thay đổi THẬT -> nhận số đo lại.
//       * Cả hai không -> nhiễu ngẫu nhiên; thử tiếp, tối đa kMaxAttempts lần rồi bỏ chu kỳ này (Reject).
//   - Chưa có số đo nào (vừa khởi động) -> cũng cần hai số đo khớp nhau.
// Nên mở cửa tủ/xả đá/máy nén hỏng (ấm lên thật, kể cả vài °C mỗi phút) vẫn được báo trong vài giây
// (thời gian đo lại), còn gai đơn lẻ bị loại.
#pragma once
#include <cstdint>

namespace auhono {

enum class Verdict : uint8_t {
  Accept,   // ghi số đo này
  Confirm,  // nghi ngờ: đo lại sau kConfirmDelayMs rồi gọi onSample() với số đo mới
  Reject,   // rác: bỏ chu kỳ này
};

class ReadingFilter {
 public:
  static constexpr int32_t kJumpCenti = 500;          // nhảy tối đa 5,00 °C giữa hai số đo liền kề mà không cần xác nhận
  static constexpr int32_t kAgreeCenti = 200;         // hai lần đo lại khớp nhau nếu lệch <= 2,00 °C
  static constexpr uint8_t kMaxAttempts = 3;          // tổng số lần đo cho một chu kỳ trước khi bỏ
  static constexpr uint32_t kConfirmDelayMs = 2000;   // đo lại sau 2 s
  static constexpr uint32_t kPendingExpireS = 30;     // nghi ngờ quá 30 s mà chưa có số đo lại -> coi như mới

  /// `monoS`: giờ đơn điệu (giây). Gọi mỗi khi có một số đo hợp lệ về mặt cảm biến (CRC/dải).
  Verdict onSample(int16_t centi, uint32_t monoS);

  /// Cảm biến báo lỗi giữa chừng (mất kết nối): bỏ trạng thái nghi ngờ đang chờ.
  void onSensorError() { pending_ = false; }

  bool hasBaseline() const { return hasBaseline_; }
  int16_t lastAccepted() const { return last_; }
  bool confirming() const { return pending_; }

 private:
  void accept(int16_t centi, uint32_t monoS) {
    hasBaseline_ = true;
    last_ = centi;
    lastT_ = monoS;
    pending_ = false;
  }

  bool hasBaseline_ = false;
  int16_t last_ = 0;
  uint32_t lastT_ = 0;
  bool pending_ = false;
  int16_t pendingC_ = 0;
  uint32_t pendingT_ = 0;
  uint8_t attempts_ = 0;
};

}  // namespace auhono
