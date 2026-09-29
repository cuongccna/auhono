// Ngẫu nhiên có hạt giống riêng từng thiết bị. esp_random() chỉ là nguồn ngẫu nhiên thật khi Wi-Fi/BT đang bật;
// trước đó (lúc vừa khởi động, đúng lúc cần rải thời điểm gửi đầu tiên) nó có thể giống hệt nhau giữa các máy
// cùng khởi động một lúc sau mất điện. Trộn thêm hạt giống từ mã thiết bị + MAC để hai máy không bao giờ trùng nhịp.
#pragma once
#include <cstddef>
#include <cstdint>

#include "auhono/backoff.h"

namespace auhono {

/// FNV-1a 32 bit.
uint32_t fnv1a32(const uint8_t* data, size_t len, uint32_t seed = 2166136261u);

class MixedRandom : public IRandom {
 public:
  /// `hw`: nguồn phần cứng (sống lâu hơn đối tượng này). `seed`: mã thiết bị/MAC đã băm.
  MixedRandom(IRandom& hw, uint32_t seed) : hw_(hw), state_(seed ? seed : 0x9E3779B9u) {}
  void reseed(uint32_t seed) { state_ ^= (seed ? seed : 0x9E3779B9u); if (!state_) state_ = 0x9E3779B9u; }
  uint32_t next() override {
    state_ ^= state_ << 13;  // xorshift32
    state_ ^= state_ >> 17;
    state_ ^= state_ << 5;
    return hw_.next() ^ state_;
  }

 private:
  IRandom& hw_;
  uint32_t state_;
};

}  // namespace auhono
