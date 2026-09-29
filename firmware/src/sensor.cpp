#include "sensor.h"

#include <Arduino.h>
#include <OneWire.h>

#include <string.h>

#include "config.h"

namespace {
// Tạo lúc begin() (không phải lúc khởi tạo đối tượng tĩnh) để chắc chắn GPIO/Arduino đã sẵn sàng.
OneWire* g_wireInstance = nullptr;
OneWire& wire() {
  if (!g_wireInstance) g_wireInstance = new OneWire(ONEWIRE_PIN);
  return *g_wireInstance;
}
constexpr uint8_t kCmdConvert = 0x44;
constexpr uint8_t kCmdReadScratchpad = 0xBE;
}  // namespace

void Sensor::begin() {
  // Không đặt độ phân giải: DS18B20 mặc định 12 bit (0,0625 °C, ~750 ms) khi cấp điện; decodeDs18Scratchpad
  // vẫn xử lý đúng nếu EEPROM của chip bị đặt độ phân giải thấp hơn (che bit không xác định).
  search();
}

bool Sensor::search() {
  uint8_t found[8];
  uint8_t count = 0;
  bool have = false;
  uint8_t best[8] = {0};
  wire().reset_search();
  while (wire().search(found)) {
    if (OneWire::crc8(found, 7) != found[7]) continue;       // mã ROM nhiễu
    if (found[0] != auhono::kDs18FamilyCode) continue;       // không phải DS18B20
    ++count;
    if (!have || memcmp(found, best, 8) < 0) { memcpy(best, found, 8); have = true; }  // ROM nhỏ nhất, xác định
  }
  wire().reset_search();
  deviceCount_ = count;
  if (!have) { haveAddr_ = false; return false; }
  if (count > 1) Serial.printf("[sensor] canh bao: %u cam bien tren day, dung chiec co ma ROM nho nhat\n", static_cast<unsigned>(count));
  memcpy(addr_, best, 8);
  haveAddr_ = true;
  return true;
}

void Sensor::startConversion() {
  if (!wire().reset()) return;   // không có thiết bị: read() sẽ báo busPresent=false
  wire().skip();
  wire().write(kCmdConvert, 0);  // 0 = không cấp nguồn ký sinh (đấu 3 dây, có VDD)
}

SensorSample Sensor::read() {
  SensorSample out;

  // Mất/đổi thiết bị: tìm lại (rẻ: vài ms). Cũng tìm lần đầu nếu lúc khởi động chưa cắm đầu dò.
  if (!haveAddr_ || consecutiveFailures_ >= 2) search();
  if (!haveAddr_) { consecutiveFailures_ = consecutiveFailures_ < 255 ? consecutiveFailures_ + 1 : 255; return out; }

  for (int attempt = 0; attempt < 3; attempt++) {
    if (!wire().reset()) { out.busPresent = false; break; }  // không có xung hiện diện: đứt dây/rút đầu dò/thiếu trở kéo
    out.busPresent = true;
    wire().select(addr_);
    wire().write(kCmdReadScratchpad);
    uint8_t sp[auhono::kDs18ScratchpadLen];
    wire().read_bytes(sp, sizeof sp);
    const auhono::Ds18Result r = auhono::decodeDs18Scratchpad(sp);
    out.status = r.status;
    if (r.status == auhono::Ds18Status::Ok) { out.centi = r.centi; break; }
    if (r.status == auhono::Ds18Status::PowerOnValue || r.status == auhono::Ds18Status::OutOfRange) break;  // đọc lại không giúp gì
    delayMicroseconds(500);  // CRC/bố cục sai: có thể nhiễu thoáng qua, đọc lại
  }

  if (out.status == auhono::Ds18Status::Ok) consecutiveFailures_ = 0;
  else if (consecutiveFailures_ < 255) ++consecutiveFailures_;
  return out;
}
