#include "status_led.h"

#include <Arduino.h>

#include "config.h"

void StatusLed::begin() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LED_ACTIVE_LOW ? HIGH : LOW);  // tắt
}

void StatusLed::update(uint32_t nowMs, const auhono::LedInputs& in) {
  const bool on = auhono::ledOn(auhono::selectLedState(in), nowMs);
  digitalWrite(LED_PIN, (on != (LED_ACTIVE_LOW != 0)) ? HIGH : LOW);
}
