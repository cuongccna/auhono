// Số đo nhiệt độ: lọc số đo lỗi, bộ đệm vòng, và dựng body JSON gửi server.
#pragma once
#include <cstddef>
#include <cstdint>
#include <vector>

namespace auhono {

/// Một số đo. Nhiệt độ lưu bằng "centi-độ" (°C x 100, số nguyên) để định dạng JSON xác định,
/// không phụ thuộc printf số thực. 8 byte/số đo: 1440 số đo (24 giờ) ~ 11,5 KB RAM.
struct Reading {
  uint32_t t;      // unix giây (UTC)
  int16_t centi;   // °C x 100, ví dụ -19,5 °C -> -1950
};

enum class ReadStatus : uint8_t { Ok, Disconnected, PowerOnReset, NotANumber, OutOfRange };

/// Phân loại giá trị DS18B20 trả về (°C):
///  - -127        : đứt dây / không thấy cảm biến (thư viện DallasTemperature trả về)
///  - 85,0        : giá trị mặc định lúc vừa cấp điện (chưa đo xong)
///  - NaN/vô cực  : hỏng
///  - ngoài [-55, 125]: ngoài dải của DS18B20
/// Chỉ ReadStatus::Ok mới được ghi và gửi.
ReadStatus classifyCelsius(float celsius);

/// Làm tròn °C sang centi-độ (không dùng cho giá trị đã bị loại).
int16_t celsiusToCenti(float celsius);

/// Đếm số lần đọc lỗi liên tiếp để báo "lỗi cảm biến" (đèn LED).
class SensorHealth {
 public:
  static constexpr uint8_t kFaultAfter = 3;  // 3 lần liên tiếp ~ 3 phút
  void onRead(ReadStatus s) {
    if (s == ReadStatus::Ok) consecutiveBad_ = 0;
    else if (consecutiveBad_ < 255) ++consecutiveBad_;
  }
  bool faulty() const { return consecutiveBad_ >= kFaultAfter; }

 private:
  uint8_t consecutiveBad_ = 0;
};

/// Bộ đệm vòng: đầy thì bỏ số đo CŨ NHẤT. Cấp phát một lần lúc khởi tạo.
class ReadingBuffer {
 public:
  explicit ReadingBuffer(size_t capacity);

  void push(const Reading& r);
  size_t size() const { return count_; }
  size_t capacity() const { return data_.size(); }
  bool empty() const { return count_ == 0; }
  uint32_t droppedOverflow() const { return dropped_; }

  /// Sao chép tối đa `max` số đo cũ nhất (theo thứ tự cũ -> mới) vào `out`, KHÔNG xóa.
  size_t peek(Reading* out, size_t max) const;
  /// Xóa `n` số đo cũ nhất (sau khi server đã nhận).
  void popFront(size_t n);
  /// Bỏ các số đo cũ hơn `cutoff` ở đầu hàng (server bỏ số đo > 24 giờ nên gửi cũng vô ích).
  size_t dropOlderThan(uint32_t cutoff);

 private:
  std::vector<Reading> data_;
  size_t head_ = 0;   // chỉ số phần tử cũ nhất
  size_t count_ = 0;
  uint32_t dropped_ = 0;
};

/// Định dạng centi-độ: -1950 -> "-19.5", 405 -> "4.05", 400 -> "4.0", -5 -> "-0.05".
/// Trả số ký tự (không tính '\0'), 0 nếu `cap` quá nhỏ.
size_t formatCenti(int16_t centi, char* out, size_t cap);

/// Số đo tối đa mỗi request theo PROTOCOL.md.
constexpr size_t kMaxBatch = 20;

/// Dựng body JSON: {"fw":"1.0.0","readings":[{"t":1800000000,"c":-19.5}]}
/// - `fw` rỗng/null thì bỏ trường "fw" (khớp vector trong PROTOCOL.md).
/// - Ký tự lạ trong `fw` bị thay bằng '_' để JSON luôn hợp lệ.
/// - Không có khoảng trắng thừa. Đây CHÍNH LÀ các byte được ký và gửi.
/// Trả độ dài body, hoặc 0 nếu `cap` không đủ hoặc n == 0 hoặc n > kMaxBatch.
size_t buildReadingsBody(char* out, size_t cap, const char* fw, const Reading* readings, size_t n);

}  // namespace auhono
