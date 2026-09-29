// Đèn trạng thái: mẫu nhấp nháy do auhono::ledOn() quyết định (xem README.md).
#pragma once
#include <stdint.h>

#include "auhono/led.h"

class StatusLed {
 public:
  void begin();
  void update(uint32_t nowMs, const auhono::LedInputs& in);
};
