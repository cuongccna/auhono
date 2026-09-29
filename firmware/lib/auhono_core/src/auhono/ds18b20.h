// Giải mã "scratchpad" 9 byte của DS18B20 (đọc thẳng qua 1-Wire), có kiểm tra chặt.
//
// Vì sao không dùng getTempC() của DallasTemperature: thư viện chỉ kiểm CRC. Một scratchpad TOÀN SỐ 0
// (dây data chập/nhiễu kéo thấp trong lúc đọc) có CRC hợp lệ (=0) và cho ra "0,0 °C" giả, đúng kiểu
// "gai nhiễu" 0,0 giữa dãy -20 °C. Ta kiểm thêm các byte cố định của DS18B20:
//   byte 4 (thanh ghi cấu hình): bit7 = 0, bit4..0 = 11111, bit6..5 = độ phân giải
//   byte 5 = 0xFF, byte 7 = 0x10 (các byte dành riêng, cố định theo datasheet)
// nên scratchpad rác hầu như chắc chắn bị loại.
#pragma once
#include <cstddef>
#include <cstdint>

namespace auhono {

/// CRC-8 Dallas/Maxim (đa thức x^8+x^5+x^4+1, dạng đảo 0x8C), khớp OneWire::crc8().
uint8_t dallasCrc8(const uint8_t* data, size_t len);

enum class Ds18Status : uint8_t {
  Ok,
  BadCrc,        // CRC sai: nhiễu / cáp dài / đứt dây (bus thả nổi thường đọc ra 0xFF)
  BadLayout,     // CRC đúng nhưng byte cố định sai (scratchpad toàn 0, rác)
  PowerOnValue,  // 0x0550 = 85,0 °C: giá trị lúc vừa cấp điện, chưa đo xong
  OutOfRange,    // ngoài [-55, +125] °C
};

struct Ds18Result {
  Ds18Status status = Ds18Status::BadCrc;
  int16_t centi = 0;  // °C x 100, chỉ có nghĩa khi status == Ok
};

constexpr size_t kDs18ScratchpadLen = 9;
constexpr uint8_t kDs18FamilyCode = 0x28;  // byte đầu của mã ROM DS18B20

/// Giải mã scratchpad (9 byte). Bit thấp không xác định ở độ phân giải 9-11 bit được che đi.
Ds18Result decodeDs18Scratchpad(const uint8_t sp[kDs18ScratchpadLen]);

}  // namespace auhono
