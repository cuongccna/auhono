#include "auhono/backoff.h"

namespace auhono {

constexpr uint32_t Backoff::kStepsMs[4];
constexpr uint32_t Backoff::kSlowStepsMs[5];
constexpr uint32_t Backoff::kWifiStepsMs[4];

uint32_t Backoff::nextDelayMs() {
  const uint8_t last = static_cast<uint8_t>(count_ - 1);
  const uint32_t base = steps_[step_];
  if (step_ < last) ++step_;
  const uint32_t percent = 80 + rng_.next() % 41;  // 80..120
  return static_cast<uint32_t>((static_cast<uint64_t>(base) * percent) / 100);
}

}  // namespace auhono
