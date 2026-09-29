#include "auhono/wifi_policy.h"

namespace auhono {

WifiFail classifyDisconnectReason(uint8_t reason) {
  switch (reason) {
    case 8:    // ASSOC_LEAVE: chính ta gọi disconnect()
      return WifiFail::None;
    case 201:  // NO_AP_FOUND
      return WifiFail::NoApFound;
    case 202:  // AUTH_FAIL
    case 15:   // 4WAY_HANDSHAKE_TIMEOUT (sai mật khẩu WPA2 thường ra mã này)
    case 204:  // HANDSHAKE_TIMEOUT
    case 14:   // MIC_FAILURE
    case 23:   // 802_1X_AUTH_FAILED
    case 203:  // ASSOC_FAIL
      return WifiFail::AuthFailed;
    default:
      return WifiFail::Other;
  }
}

bool shouldOpenPortal(uint32_t downForMs, WifiFail lastFail, uint32_t failStableMs) {
  if (downForMs >= kPortalAfterAnyFailMs) return true;
  return lastFail == WifiFail::AuthFailed && failStableMs >= kPortalAfterAuthFailMs && downForMs >= kPortalAfterAuthFailMs;
}

}  // namespace auhono
