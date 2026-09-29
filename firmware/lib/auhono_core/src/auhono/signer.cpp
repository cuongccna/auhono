#include "auhono/signer.h"

#include "auhono/hex.h"

namespace auhono {

std::string buildCanonical(const std::string& method, const std::string& path,
                           const std::string& deviceId, uint64_t timestamp, uint64_t seq,
                           const std::string& bodyHashHex) {
  std::string out;
  out.reserve(method.size() + path.size() + deviceId.size() + bodyHashHex.size() + 48);
  for (char c : method) out.push_back((c >= 'a' && c <= 'z') ? static_cast<char>(c - 32) : c);
  out.push_back('\n');
  out += path;
  out.push_back('\n');
  out += deviceId;
  out.push_back('\n');
  out += std::to_string(timestamp);
  out.push_back('\n');
  out += std::to_string(seq);
  out.push_back('\n');
  out += bodyHashHex;  // không có ký tự thừa ở cuối
  return out;
}

std::string stripQuery(const std::string& pathAndQuery) {
  size_t q = pathAndQuery.find('?');
  return q == std::string::npos ? pathAndQuery : pathAndQuery.substr(0, q);
}

Signer::Signer(ICrypto& crypto, std::string deviceId, const uint8_t key[kDeviceKeyLen])
    : crypto_(crypto), deviceId_(std::move(deviceId)) {
  for (size_t i = 0; i < kDeviceKeyLen; i++) key_[i] = key[i];
}

Signer::~Signer() {
  // volatile để trình biên dịch không bỏ qua việc xóa.
  volatile uint8_t* p = key_.data();
  for (size_t i = 0; i < kDeviceKeyLen; i++) p[i] = 0;
}

SignedHeaders Signer::sign(const std::string& method, const std::string& pathAndQuery,
                           uint64_t timestamp, uint64_t seq, const uint8_t* body,
                           size_t bodyLen) const {
  uint8_t hash[32];
  static const uint8_t kEmpty = 0;
  crypto_.sha256(bodyLen ? body : &kEmpty, bodyLen, hash);  // body rỗng => băm chuỗi rỗng

  const std::string canonical = buildCanonical(method, stripQuery(pathAndQuery), deviceId_,
                                               timestamp, seq, toHex(hash, 32));
  uint8_t mac[32];
  crypto_.hmacSha256(key_.data(), key_.size(), reinterpret_cast<const uint8_t*>(canonical.data()),
                     canonical.size(), mac);

  SignedHeaders h;
  h.deviceId = deviceId_;
  h.timestamp = std::to_string(timestamp);
  h.seq = std::to_string(seq);
  h.signature = toHex(mac, 32);
  return h;
}

}  // namespace auhono
