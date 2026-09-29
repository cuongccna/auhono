#include "auhono/backoff.h"

namespace auhono {

constexpr uint32_t Backoff::kStepsMs[4];

uint32_t Backoff::nextDelayMs() {
  constexpr uint8_t kLast = 3;
  const uint32_t base = kStepsMs[step_];
  if (step_ < kLast) ++step_;
  const uint32_t percent = 80 + rng_.next() % 41;  // 80..120
  return static_cast<uint32_t>((static_cast<uint64_t>(base) * percent) / 100);
}

}  // namespace auhono
