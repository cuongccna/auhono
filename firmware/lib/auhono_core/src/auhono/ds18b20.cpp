#include "auhono/ds18b20.h"

namespace auhono {

uint8_t dallasCrc8(const uint8_t* data, size_t len) {
  uint8_t crc = 0;
  for (size_t i = 0; i < len; i++) {
    uint8_t in = data[i];
    for (int b = 0; b < 8; b++) {
      const uint8_t mix = static_cast<uint8_t>((crc ^ in) & 0x01);
      crc = static_cast<uint8_t>(crc >> 1);
      if (mix) crc = static_cast<uint8_t>(crc ^ 0x8C);
      in = static_cast<uint8_t>(in >> 1);
    }
  }
  return crc;
}

Ds18Result decodeDs18Scratchpad(const uint8_t sp[kDs18ScratchpadLen]) {
  Ds18Result r;
  if (dallasCrc8(sp, 8) != sp[8]) { r.status = Ds18Status::BadCrc; return r; }

  const uint8_t cfg = sp[4];
  if ((cfg & 0x9F) != 0x1F || sp[5] != 0xFF || sp[7] != 0x10) { r.status = Ds18Status::BadLayout; return r; }

  int32_t raw = static_cast<int16_t>(static_cast<uint16_t>(sp[0] | (sp[1] << 8)));  // 1/16 °C, bù hai
  const int res = (cfg >> 5) & 0x03;            // 0: 9 bit ... 3: 12 bit
  const int undefinedBits = 3 - res;            // 9 bit: 3 bit thấp không xác định
  if (undefinedBits > 0) raw &= ~((1 << undefinedBits) - 1);

  if (raw == 0x0550) { r.status = Ds18Status::PowerOnValue; return r; }

  // centi = raw * 100 / 16 = raw * 6,25; làm tròn nửa ra xa số 0.
  const int32_t v = raw * 625;
  const int32_t centi = v >= 0 ? (v + 50) / 100 : -((-v + 50) / 100);
  if (centi < -5500 || centi > 12500) { r.status = Ds18Status::OutOfRange; return r; }
  r.centi = static_cast<int16_t>(centi);
  r.status = Ds18Status::Ok;
  return r;
}

}  // namespace auhono
