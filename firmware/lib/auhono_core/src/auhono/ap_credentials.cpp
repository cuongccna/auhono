#include "auhono/ap_credentials.h"

#include <cstring>

namespace auhono {

std::string deriveApPassword(ICrypto& crypto, const uint8_t key[kDeviceKeyLen]) {
  uint8_t mac[32];
  crypto.hmacSha256(key, kDeviceKeyLen, reinterpret_cast<const uint8_t*>(kApPasswordContext), sizeof kApPasswordContext - 1, mac);
  std::string out;
  out.reserve(kApPasswordLen);
  for (size_t i = 0; i < kApPasswordLen; i++) out.push_back(kApPasswordAlphabet[mac[i] % 32]);
  volatile uint8_t* p = mac;  // xóa dấu vết HMAC khỏi stack (best-effort)
  for (size_t i = 0; i < sizeof mac; i++) p[i] = 0;
  return out;
}

}  // namespace auhono
