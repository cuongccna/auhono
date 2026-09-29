#include "auhono/jitter_random.h"

namespace auhono {

uint32_t fnv1a32(const uint8_t* data, size_t len, uint32_t seed) {
  uint32_t h = seed;
  for (size_t i = 0; i < len; i++) {
    h ^= data[i];
    h *= 16777619u;
  }
  return h;
}

}  // namespace auhono
