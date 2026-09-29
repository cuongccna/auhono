#include "sensor.h"

#include <DallasTemperature.h>
#include <OneWire.h>

#include "config.h"

static OneWire g_wire(ONEWIRE_PIN);
static DallasTemperature g_ds(&g_wire);

void Sensor::begin() {
  g_ds.begin();
  g_ds.setResolution(12);          // 0,0625 °C, ~750 ms
  g_ds.setWaitForConversion(false);  // không chặn loop() trong lúc đo
}

void Sensor::startConversion() { g_ds.requestTemperatures(); }

float Sensor::readCelsius() { return g_ds.getTempCByIndex(0); }  // CRC được thư viện kiểm; lỗi => -127
