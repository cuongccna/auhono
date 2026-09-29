#include "auhono/backoff.h"

namespace auhono {

constexpr uint32_t Backoff::kStepsMs[4];
constexpr uint32_t Backoff::kSlowStepsMs[5];
constexpr uint32_t Backoff::kWifiStepsMs[4];

uint32_t Backoff::nextDelayMs() {
  const uint8_t last = static_cast<uint8_t>(count_ - 1);
  const uint32_t base = steps_[step_];
  if (step_ < last) ++step_;
  // ±20% với độ mịn 0,1% (401 mức): 30 máy khởi động cùng lúc hầu như không trùng mốc.
  const uint32_t permille = 800 + rng_.next() % 401;  // 800..1200
  return static_cast<uint32_t>((static_cast<uint64_t>(base) * permille) / 1000);
}

}  // namespace auhono
