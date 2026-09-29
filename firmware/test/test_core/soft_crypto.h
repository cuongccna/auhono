// SHA-256 và HMAC-SHA256 tự chứa (chỉ dùng cho test trên máy tính). Trên chip dùng mbedtls.
// Cài đặt theo FIPS 180-4 / RFC 2104; đúng đắn được kiểm chứng bằng vector trong docs/PROTOCOL.md
// và các vector chuẩn (NIST, RFC 4231) ở t_protocol.cpp.
#pragma once
#include <cstdint>
#include <cstring>

#include "auhono/crypto_iface.h"

namespace softcrypto {

struct Sha256Ctx {
  uint32_t h[8];
  uint8_t buf[64];
  uint64_t total;
  size_t bufLen;
};

inline uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

inline void sha256Block(Sha256Ctx& c, const uint8_t* p) {
  static const uint32_t K[64] = {
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
  uint32_t w[64];
  for (int i = 0; i < 16; i++)
    w[i] = (uint32_t(p[4 * i]) << 24) | (uint32_t(p[4 * i + 1]) << 16) | (uint32_t(p[4 * i + 2]) << 8) | p[4 * i + 3];
  for (int i = 16; i < 64; i++) {
    uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
    uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  uint32_t a = c.h[0], b = c.h[1], cc = c.h[2], d = c.h[3], e = c.h[4], f = c.h[5], g = c.h[6], h = c.h[7];
  for (int i = 0; i < 64; i++) {
    uint32_t S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    uint32_t ch = (e & f) ^ (~e & g);
    uint32_t t1 = h + S1 + ch + K[i] + w[i];
    uint32_t S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    uint32_t mj = (a & b) ^ (a & cc) ^ (b & cc);
    uint32_t t2 = S0 + mj;
    h = g; g = f; f = e; e = d + t1; d = cc; cc = b; b = a; a = t1 + t2;
  }
  c.h[0] += a; c.h[1] += b; c.h[2] += cc; c.h[3] += d; c.h[4] += e; c.h[5] += f; c.h[6] += g; c.h[7] += h;
}

inline void sha256Init(Sha256Ctx& c) {
  static const uint32_t init[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                   0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  std::memcpy(c.h, init, sizeof init);
  c.total = 0;
  c.bufLen = 0;
}

inline void sha256Update(Sha256Ctx& c, const uint8_t* data, size_t len) {
  c.total += len;
  while (len > 0) {
    size_t take = 64 - c.bufLen;
    if (take > len) take = len;
    std::memcpy(c.buf + c.bufLen, data, take);
    c.bufLen += take; data += take; len -= take;
    if (c.bufLen == 64) { sha256Block(c, c.buf); c.bufLen = 0; }
  }
}

inline void sha256Final(Sha256Ctx& c, uint8_t out[32]) {
  const uint64_t bits = c.total * 8;
  const uint8_t one = 0x80, zero = 0;
  sha256Update(c, &one, 1);
  while (c.bufLen != 56) sha256Update(c, &zero, 1);
  uint8_t lenBytes[8];
  for (int i = 0; i < 8; i++) lenBytes[i] = static_cast<uint8_t>(bits >> (56 - 8 * i));
  sha256Update(c, lenBytes, 8);
  for (int i = 0; i < 8; i++) {
    out[4 * i] = uint8_t(c.h[i] >> 24); out[4 * i + 1] = uint8_t(c.h[i] >> 16);
    out[4 * i + 2] = uint8_t(c.h[i] >> 8); out[4 * i + 3] = uint8_t(c.h[i]);
  }
}

inline void sha256(const uint8_t* data, size_t len, uint8_t out[32]) {
  Sha256Ctx c;
  sha256Init(c);
  sha256Update(c, data, len);
  sha256Final(c, out);
}

inline void hmacSha256(const uint8_t* key, size_t keyLen, const uint8_t* msg, size_t msgLen, uint8_t out[32]) {
  uint8_t k[64] = {0};
  if (keyLen > 64) sha256(key, keyLen, k); else std::memcpy(k, key, keyLen);
  uint8_t ipad[64], opad[64];
  for (int i = 0; i < 64; i++) { ipad[i] = k[i] ^ 0x36; opad[i] = k[i] ^ 0x5c; }
  Sha256Ctx c;
  uint8_t inner[32];
  sha256Init(c); sha256Update(c, ipad, 64); sha256Update(c, msg, msgLen); sha256Final(c, inner);
  sha256Init(c); sha256Update(c, opad, 64); sha256Update(c, inner, 32); sha256Final(c, out);
}

}  // namespace softcrypto

class SoftCrypto : public auhono::ICrypto {
 public:
  void sha256(const uint8_t* d, size_t n, uint8_t out[32]) override { softcrypto::sha256(d, n, out); }
  void hmacSha256(const uint8_t* k, size_t kl, const uint8_t* m, size_t ml, uint8_t out[32]) override {
    softcrypto::hmacSha256(k, kl, m, ml, out);
  }
};
