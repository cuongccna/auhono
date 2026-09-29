#include "auhono/hex.h"

namespace auhono {

std::string toHex(const uint8_t* data, size_t len) {
  static const char kDigits[] = "0123456789abcdef";
  std::string out;
  out.reserve(len * 2);
  for (size_t i = 0; i < len; i++) {
    out.push_back(kDigits[data[i] >> 4]);
    out.push_back(kDigits[data[i] & 0x0F]);
  }
  return out;
}

static int nibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

bool fromHex(const char* s, size_t n, uint8_t* out, size_t outCap, size_t* outLen) {
  if (n % 2 != 0 || n / 2 > outCap) return false;
  for (size_t i = 0; i < n / 2; i++) {
    int hi = nibble(s[2 * i]);
    int lo = nibble(s[2 * i + 1]);
    if (hi < 0 || lo < 0) return false;
    out[i] = static_cast<uint8_t>((hi << 4) | lo);
  }
  if (outLen) *outLen = n / 2;
  return true;
}

bool constTimeEqual(const uint8_t* a, const uint8_t* b, size_t len) {
  uint8_t diff = 0;
  for (size_t i = 0; i < len; i++) diff |= static_cast<uint8_t>(a[i] ^ b[i]);
  return diff == 0;
}

}  // namespace auhono
