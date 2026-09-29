#include "auhono/led.h"

namespace auhono {

LedState selectLedState(const LedInputs& in) {
  if (in.wipeArmed) return LedState::WipeArmed;   // cao nhất: người dùng đang thao tác, cần phản hồi ngay
  if (!in.hasIdentity) return LedState::NoIdentity;
  if (in.portalActive) return LedState::Setup;
  if (in.sensorFault) return LedState::SensorFault;
  if (!in.wifiConnected) {
    if (in.wifiFail == WifiFail::NoApFound) return LedState::WifiNotFound;
    if (in.wifiFail == WifiFail::AuthFailed) return LedState::WifiAuthFailed;
    return LedState::Connecting;
  }
  if (in.upload == UploadStatus::Unknown) return LedState::Connecting;
  if (in.upload == UploadStatus::Failed) return LedState::ServerProblem;
  return LedState::Online;
}

bool ledOn(LedState state, uint32_t t) {
  switch (state) {
    case LedState::WipeArmed:      return (t % 100) < 50;                  // 10 Hz
    case LedState::Setup:          return (t % 200) < 100;                 // 5 Hz
    case LedState::Connecting:     return (t % 2000) < 1000;               // 0,5 Hz
    case LedState::WifiNotFound:   return (t % 2000) < 120;                // 1 nháy ngắn mỗi 2 s
    case LedState::WifiAuthFailed: {                                       // nháy dài 600 ms + nháy ngắn 100 ms mỗi 2,5 s
      const uint32_t p = t % 2500;
      return p < 600 || (p >= 800 && p < 900);
    }
    case LedState::Online:         return true;
    case LedState::ServerProblem: {                                        // sáng 150, tắt 150, sáng 150, nghỉ
      const uint32_t p = t % 2000;
      return p < 150 || (p >= 300 && p < 450);
    }
    case LedState::SensorFault:    return (t % 1500) >= 250;               // sáng, tắt 250 ms mỗi 1,5 s
    case LedState::NoIdentity: {                                           // 3 nháy ngắn mỗi 2,5 s
      const uint32_t p = t % 2500;
      return p < 100 || (p >= 250 && p < 350) || (p >= 500 && p < 600);
    }
  }
  return false;
}

}  // namespace auhono
