#include "auhono/time_policy.h"

namespace auhono {

bool shouldAdoptServerTime(bool clockTrusted, uint32_t localNow, uint64_t serverTime, bool forced) {
  if (!isPlausibleUnix(serverTime)) return false;
  if (forced || !clockTrusted) return true;
  const int64_t diff = static_cast<int64_t>(serverTime) - static_cast<int64_t>(localNow);
  return diff > 120 || diff < -120;
}

}  // namespace auhono
