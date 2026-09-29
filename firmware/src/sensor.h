// DS18B20 trên một chân 1-Wire. Đọc không chặn: startConversion() rồi ~800 ms sau readCelsius().
#pragma once
#include <stdint.h>

class Sensor {
 public:
  void begin();
  /// Yêu cầu đo (không chờ).
  void startConversion();
  /// Giá trị sau khi đo xong, °C. Trả -127 khi không thấy cảm biến, 85 khi vừa cấp điện
  /// (auhono::classifyCelsius sẽ loại cả hai).
  float readCelsius();
};
