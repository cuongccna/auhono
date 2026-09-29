#include "auhono/seq_counter.h"

namespace auhono {

SeqCounter::SeqCounter(ISeqStore& store, uint64_t stride)
    : store_(store), stride_(stride == 0 ? 1 : stride) {}

void SeqCounter::begin() {
  uint64_t stored = 0;
  if (!store_.load(stored) || stored > kMaxSeq) stored = 0;
  ceiling_ = stored;
  last_ = stored;  // mọi seq <= trần có thể đã dùng => bắt đầu sau trần
}

uint64_t SeqCounter::next() {
  ++last_;
  if (last_ > ceiling_) {
    const uint64_t newCeiling = last_ + stride_ - 1;
    if (store_.save(newCeiling)) {
      ceiling_ = newCeiling;
    } else {
      ++saveFailures_;  // giữ trần cũ => lần gọi sau sẽ thử ghi lại
    }
  }
  return last_;
}

void SeqCounter::raiseTo(uint64_t serverLastSeq) {
  if (serverLastSeq > kMaxSeq) return;
  if (serverLastSeq > last_) last_ = serverLastSeq;  // next() sẽ trả serverLastSeq + 1
}

}  // namespace auhono
