// Giao diện mật mã để phần lõi không phụ thuộc thư viện cụ thể.
//  - Trên chip: MbedCrypto (mbedtls có sẵn trong core Arduino), xem src/platform_esp32.cpp.
//  - Khi test trên máy: cài đặt SHA-256/HMAC tự chứa trong test/test_core/soft_crypto.h.
#pragma once
#include <cstddef>
#include <cstdint>

namespace auhono {

class ICrypto {
 public:
  virtual ~ICrypto() = default;
  virtual void sha256(const uint8_t* data, size_t len, uint8_t out[32]) = 0;
  virtual void hmacSha256(const uint8_t* key, size_t keyLen, const uint8_t* msg, size_t msgLen,
                          uint8_t out[32]) = 0;
};

}  // namespace auhono
