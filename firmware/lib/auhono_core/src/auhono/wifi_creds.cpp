#include "auhono/wifi_creds.h"

#include "auhono/crc32.h"
#include "auhono/portal_form.h"

namespace auhono {

namespace {
constexpr uint8_t kMagic = 0xA5;
constexpr uint8_t kVersion = 1;
}  // namespace

size_t encodeWifiCreds(const WifiCreds& c, uint8_t* out, size_t cap) {
  if (validateSsid(c.ssid) != FormError::None || validatePassword(c.password) != FormError::None) return 0;
  const size_t total = 4 + c.ssid.size() + c.password.size() + 4;
  if (cap < total) return 0;
  size_t i = 0;
  out[i++] = kMagic;
  out[i++] = kVersion;
  out[i++] = static_cast<uint8_t>(c.ssid.size());
  out[i++] = static_cast<uint8_t>(c.password.size());
  for (char ch : c.ssid) out[i++] = static_cast<uint8_t>(ch);
  for (char ch : c.password) out[i++] = static_cast<uint8_t>(ch);
  const uint32_t crc = crc32(out, i);
  for (int b = 0; b < 4; b++) out[i++] = static_cast<uint8_t>(crc >> (8 * b));
  return i;
}

bool decodeWifiCreds(const uint8_t* d, size_t len, WifiCreds& out) {
  if (!d || len < 4 + 1 + 4) return false;
  if (d[0] != kMagic || d[1] != kVersion) return false;
  const size_t sl = d[2];
  const size_t pl = d[3];
  if (sl == 0 || sl > kMaxSsidLen || pl > kMaxPasswordLen) return false;
  if (len != 4 + sl + pl + 4) return false;
  uint32_t stored = 0;
  for (int b = 0; b < 4; b++) stored |= static_cast<uint32_t>(d[len - 4 + static_cast<size_t>(b)]) << (8 * b);
  if (crc32(d, len - 4) != stored) return false;
  WifiCreds c;
  c.ssid.assign(reinterpret_cast<const char*>(d + 4), sl);
  c.password.assign(reinterpret_cast<const char*>(d + 4 + sl), pl);
  if (validateSsid(c.ssid) != FormError::None || validatePassword(c.password) != FormError::None) return false;
  out = std::move(c);
  return true;
}

}  // namespace auhono
