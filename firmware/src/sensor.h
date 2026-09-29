// DS18B20 trên một chân 1-Wire, đọc THẲNG scratchpad (không dùng DallasTemperature) để kiểm tra chặt:
// CRC + byte cố định + giá trị 85 °C lúc cấp điện + dải hợp lệ (auhono::decodeDs18Scratchpad).
// Không chặn: startConversion() rồi >= 800 ms sau read().
//
// Tình huống thực tế xử lý ở đây:
//   - đứt dây / rút đầu dò / thiếu trở kéo lên: reset() không thấy xung hiện diện -> busPresent=false;
//   - cắm lại đầu dò khi máy đang chạy: tự tìm lại thiết bị (search) sau 2 lần đọc hỏng liên tiếp;
//   - nhiễu/CRC sai: đọc lại scratchpad tối đa 3 lần (lần đo đã xong nên rất nhanh) trước khi kết luận lỗi;
//   - nhiều DS18B20 trên cùng dây: dùng chiếc có mã ROM NHỎ NHẤT và nhớ nó (không đổi ngầm), log cảnh báo.
#pragma once
#include <stdint.h>

#include "auhono/ds18b20.h"

struct SensorSample {
  bool busPresent = false;                                        // có thiết bị trả lời xung reset
  auhono::Ds18Status status = auhono::Ds18Status::BadCrc;         // Ok chỉ khi đọc và kiểm tra đều đạt
  int16_t centi = 0;                                              // °C x 100 (chỉ khi status == Ok)
};

class Sensor {
 public:
  void begin();
  /// Yêu cầu đo (không chờ). Phát lệnh cho MỌI thiết bị trên dây (Skip ROM).
  void startConversion();
  /// Đọc kết quả sau >= 800 ms kể từ startConversion().
  SensorSample read();
  /// Số DS18B20 thấy ở lần tìm gần nhất.
  uint8_t deviceCount() const { return deviceCount_; }

 private:
  bool search();
  uint8_t addr_[8] = {0};
  bool haveAddr_ = false;
  uint8_t consecutiveFailures_ = 0;
  uint8_t deviceCount_ = 0;
};
