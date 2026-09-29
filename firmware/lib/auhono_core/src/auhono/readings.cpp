#include "auhono/readings.h"

#include <cmath>
#include <limits>

#include "auhono/time_policy.h"

namespace auhono {

ReadStatus classifyCelsius(float c) {
  if (std::isnan(c) || std::isinf(c)) return ReadStatus::NotANumber;
  if (std::fabs(c - (-127.0f)) < 0.01f) return ReadStatus::Disconnected;
  if (std::fabs(c - 85.0f) < 0.01f) return ReadStatus::PowerOnReset;
  if (c < -55.0f || c > 125.0f) return ReadStatus::OutOfRange;
  return ReadStatus::Ok;
}

int16_t celsiusToCenti(float c) {
  if (std::isnan(c)) return 0;
  // Tính bằng double: c*100 với float có thể lệch 1 ulp ngay sát điểm .5. Bão hòa trước khi ép kiểu.
  const double v = std::round(static_cast<double>(c) * 100.0);  // round(): nửa ra xa số 0
  if (v >= static_cast<double>(std::numeric_limits<int16_t>::max())) return std::numeric_limits<int16_t>::max();
  if (v <= static_cast<double>(std::numeric_limits<int16_t>::min())) return std::numeric_limits<int16_t>::min();
  return static_cast<int16_t>(v == 0.0 ? 0.0 : v);  // -0.0 -> 0
}

bool toCenti(float c, int16_t& centi) {
  if (classifyCelsius(c) != ReadStatus::Ok) return false;
  centi = celsiusToCenti(c);
  return true;
}

bool monoToUnix(uint32_t mono, const TimeAnchor& a, uint32_t& unixOut) {
  if (!isPlausibleUnix(a.unixNow)) return false;
  if (mono > a.monoNow) return false;                 // số đo "ở tương lai": không thể
  const uint32_t age = a.monoNow - mono;
  if (age > a.unixNow) return false;
  const uint32_t t = a.unixNow - age;
  if (!isPlausibleUnix(t)) return false;
  unixOut = t;
  return true;
}

ReadingBuffer::ReadingBuffer(size_t capacity) : data_(capacity == 0 ? 1 : capacity) {}

void ReadingBuffer::push(const Reading& r) {
  const size_t cap = data_.size();
  if (count_ == cap) {  // đầy: ghi đè phần tử cũ nhất
    data_[head_] = r;
    head_ = (head_ + 1) % cap;
    ++dropped_;
  } else {
    data_[(head_ + count_) % cap] = r;
    ++count_;
  }
}

size_t ReadingBuffer::peek(Reading* out, size_t max) const {
  const size_t n = count_ < max ? count_ : max;
  for (size_t i = 0; i < n; i++) out[i] = data_[(head_ + i) % data_.size()];
  return n;
}

void ReadingBuffer::popFront(size_t n) {
  if (n > count_) n = count_;
  head_ = (head_ + n) % data_.size();
  count_ -= n;
}

size_t ReadingBuffer::dropOlderThan(uint32_t cutoff) {
  size_t removed = 0;
  while (count_ > 0 && data_[head_].t < cutoff) {
    head_ = (head_ + 1) % data_.size();
    --count_;
    ++removed;
  }
  return removed;
}

bool ReadingBuffer::newest(Reading& out) const {
  if (count_ == 0) return false;
  out = data_[(head_ + count_ - 1) % data_.size()];
  return true;
}

// ── Định dạng JSON ─────────────────────────────────────────────────────────

namespace {

/// Ghi tuần tự vào bộ đệm có giới hạn; đánh dấu tràn thay vì ghi lố.
struct Writer {
  char* buf;
  size_t cap;
  size_t len = 0;
  bool overflow = false;

  void put(char c) {
    if (len + 1 >= cap) { overflow = true; return; }  // chừa chỗ cho '\0'
    buf[len++] = c;
  }
  void put(const char* s) { while (*s) put(*s++); }
  void putI32(int32_t v) {
    if (v < 0) { put('-'); putU32(static_cast<uint32_t>(0) - static_cast<uint32_t>(v)); }
    else putU32(static_cast<uint32_t>(v));
  }
  void putU32(uint32_t v) {
    char tmp[10];
    int n = 0;
    do { tmp[n++] = static_cast<char>('0' + v % 10); v /= 10; } while (v);
    while (n) put(tmp[--n]);
  }
};

bool isFwChar(char c) {
  return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '.' ||
         c == '-' || c == '_' || c == '+';
}

}  // namespace

size_t formatCenti(int16_t centi, char* out, size_t cap) {
  Writer w{out, cap};
  int32_t v = centi;
  if (v < 0) { w.put('-'); v = -v; }
  w.putU32(static_cast<uint32_t>(v / 100));
  w.put('.');
  const int frac = v % 100;
  if (frac == 0) {
    w.put('0');
  } else if (frac % 10 == 0) {
    w.put(static_cast<char>('0' + frac / 10));
  } else {
    w.put(static_cast<char>('0' + frac / 10));
    w.put(static_cast<char>('0' + frac % 10));
  }
  if (w.overflow || cap == 0) return 0;
  out[w.len] = '\0';
  return w.len;
}

bool isValidRstToken(const char* s) {
  if (!s || !*s) return false;
  size_t n = 0;
  for (; s[n]; n++) {
    const char c = s[n];
    const bool ok = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_';
    if (!ok || n >= 16) return false;
  }
  return true;
}

const char* resetReasonToken(int r) {
  switch (r) {
    case 1:  return "poweron";
    case 2:  return "ext";
    case 3:  return "sw";
    case 4:  return "panic";
    case 5: case 6: case 7: return "wdt";
    case 8:  return "deepsleep";
    case 9:  return "brownout";
    case 10: return "sdio";
    default: return "unknown";
  }
}

namespace {

/// Ghi khối diag (chỉ khóa đã biết, theo thứ tự cố định). Trả false nếu không có khóa nào (khi đó không ghi gì).
bool writeDiag(Writer& w, const Diag& d) {
  const bool hasRst = isValidRstToken(d.rst);
  if (!d.hasSensor && !d.hasFaultS && !hasRst && !d.hasRssi && !d.hasHeap && !d.hasUp) return false;
  bool first = true;
  auto key = [&](const char* k) { if (!first) w.put(','); first = false; w.put('"'); w.put(k); w.put("\":"); };
  w.put(",\"diag\":{");
  if (d.hasSensor) { key("sensor"); w.put(d.sensorFault ? "\"fault\"" : "\"ok\""); }
  if (d.hasFaultS) { key("fault_s"); w.putU32(d.faultS > 0x80000000u ? 0x80000000u : d.faultS); }
  if (hasRst) { key("rst"); w.put('"'); w.put(d.rst); w.put('"'); }
  if (d.hasRssi) { key("rssi"); w.putI32(d.rssi < -120 ? -120 : d.rssi > 0 ? 0 : d.rssi); }
  if (d.hasHeap) { key("heap"); w.putU32(d.heap); }
  if (d.hasUp) { key("up"); w.putU32(d.up); }
  w.put('}');
  return true;
}

bool hasAnyDiag(const Diag& d) {
  return d.hasSensor || d.hasFaultS || isValidRstToken(d.rst) || d.hasRssi || d.hasHeap || d.hasUp;
}

}  // namespace

size_t buildReadingsBody(char* out, size_t cap, const char* fw, const WireReading* readings, size_t n, const Diag* diag) {
  const bool withDiag = diag && hasAnyDiag(*diag);
  if (cap == 0 || n > kMaxBatch || (n == 0 && !withDiag)) return 0;
  Writer w{out, cap};
  w.put('{');
  if (fw && *fw) {
    w.put("\"fw\":\"");
    size_t i = 0;
    for (; fw[i] && i < 32; i++) w.put(isFwChar(fw[i]) ? fw[i] : '_');  // server: fw <= 32 ký tự
    w.put("\",");
  }
  w.put("\"readings\":[");
  for (size_t i = 0; i < n; i++) {
    if (i) w.put(',');
    char num[12];
    if (formatCenti(readings[i].centi, num, sizeof num) == 0) return 0;
    w.put("{\"t\":");
    w.putU32(readings[i].t);
    w.put(",\"c\":");
    w.put(num);
    w.put('}');
  }
  w.put(']');
  if (withDiag) writeDiag(w, *diag);
  w.put('}');
  if (w.overflow) return 0;
  out[w.len] = '\0';
  return w.len;
}

}  // namespace auhono
