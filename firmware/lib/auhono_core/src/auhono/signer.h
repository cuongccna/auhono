// Ký request đúng từng byte theo docs/PROTOCOL.md.
//
//   canonical = METHOD "\n" PATH "\n" device_id "\n" timestamp "\n" seq "\n" hex(SHA256(body))
//   X-Signature = hex thường của HMAC-SHA256(device_key, canonical)
//
// PATH không gồm query string. Body rỗng (GET) thì băm chuỗi rỗng.
#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <string>

#include "auhono/crypto_iface.h"

namespace auhono {

constexpr size_t kDeviceKeyLen = 32;

/// Bốn header bắt buộc của mọi request có ký.
struct SignedHeaders {
  std::string deviceId;   // X-Device-Id
  std::string timestamp;  // X-Timestamp (thập phân)
  std::string seq;        // X-Seq (thập phân)
  std::string signature;  // X-Signature (hex thường, 64 ký tự)
};

/// Chuỗi chuẩn hóa được ký. `method` được đổi thành chữ HOA; `bodyHashHex` là hex(SHA256(body)).
std::string buildCanonical(const std::string& method, const std::string& path,
                           const std::string& deviceId, uint64_t timestamp, uint64_t seq,
                           const std::string& bodyHashHex);

/// Bỏ phần "?query" (nếu có) khỏi đường dẫn — chữ ký chỉ bao gồm path.
std::string stripQuery(const std::string& pathAndQuery);

class Signer {
 public:
  Signer(ICrypto& crypto, std::string deviceId, const uint8_t key[kDeviceKeyLen]);
  ~Signer();  // xóa khóa khỏi RAM (best-effort)
  Signer(const Signer&) = delete;
  Signer& operator=(const Signer&) = delete;

  const std::string& deviceId() const { return deviceId_; }

  /// Ký một request. `pathAndQuery` có thể chứa query (sẽ bị cắt khỏi chuỗi ký).
  SignedHeaders sign(const std::string& method, const std::string& pathAndQuery, uint64_t timestamp,
                     uint64_t seq, const uint8_t* body, size_t bodyLen) const;

 private:
  ICrypto& crypto_;
  std::string deviceId_;
  std::array<uint8_t, kDeviceKeyLen> key_;
};

}  // namespace auhono
