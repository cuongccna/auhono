#include "auhono/json_scan.h"

namespace auhono {

namespace {

constexpr size_t kMaxMembers = 32;
constexpr size_t kMaxDepth = 8;

bool isWs(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

void appendUtf8(std::string& s, uint32_t cp) {
  if (cp < 0x80) {
    s.push_back(static_cast<char>(cp));
  } else if (cp < 0x800) {
    s.push_back(static_cast<char>(0xC0 | (cp >> 6)));
    s.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else {
    s.push_back(static_cast<char>(0xE0 | (cp >> 12)));
    s.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    s.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  }
}

/// Đọc chuỗi JSON bắt đầu tại text[i] == '"'. Trả vị trí SAU dấu nháy đóng; npos nếu lỗi.
size_t parseString(const std::string& t, size_t i, std::string* out) {
  if (i >= t.size() || t[i] != '"') return std::string::npos;
  ++i;
  while (i < t.size()) {
    char c = t[i];
    if (c == '"') return i + 1;
    if (static_cast<unsigned char>(c) < 0x20) return std::string::npos;  // ký tự điều khiển thô là sai
    if (c != '\\') {
      if (out) out->push_back(c);
      ++i;
      continue;
    }
    if (++i >= t.size()) return std::string::npos;
    char e = t[i++];
    char dec = 0;
    switch (e) {
      case '"': dec = '"'; break;
      case '\\': dec = '\\'; break;
      case '/': dec = '/'; break;
      case 'b': dec = '\b'; break;
      case 'f': dec = '\f'; break;
      case 'n': dec = '\n'; break;
      case 'r': dec = '\r'; break;
      case 't': dec = '\t'; break;
      case 'u': {
        if (i + 4 > t.size()) return std::string::npos;
        uint32_t cp = 0;
        for (int k = 0; k < 4; k++) {
          char h = t[i + k];
          int v = (h >= '0' && h <= '9') ? h - '0' : (h >= 'a' && h <= 'f') ? h - 'a' + 10
                  : (h >= 'A' && h <= 'F') ? h - 'A' + 10 : -1;
          if (v < 0) return std::string::npos;
          cp = (cp << 4) | static_cast<uint32_t>(v);
        }
        i += 4;
        if (out) appendUtf8(*out, cp);
        continue;
      }
      default: return std::string::npos;
    }
    if (out) out->push_back(dec);
  }
  return std::string::npos;  // thiếu dấu nháy đóng
}

/// Bỏ qua một giá trị bất kỳ tại t[i]; trả vị trí ngay sau nó, npos nếu lỗi.
size_t skipValue(const std::string& t, size_t i) {
  if (i >= t.size()) return std::string::npos;
  char c = t[i];
  if (c == '"') return parseString(t, i, nullptr);
  if (c == '{' || c == '[') {
    // Duyệt phẳng bằng bộ đếm độ sâu + ngăn xếp loại ngoặc (không đệ quy).
    char stack[kMaxDepth];
    size_t depth = 0;
    while (i < t.size()) {
      char d = t[i];
      if (d == '"') {
        i = parseString(t, i, nullptr);
        if (i == std::string::npos) return i;
        continue;
      }
      if (d == '{' || d == '[') {
        if (depth >= kMaxDepth) return std::string::npos;
        stack[depth++] = d == '{' ? '}' : ']';
      } else if (d == '}' || d == ']') {
        if (depth == 0 || stack[depth - 1] != d) return std::string::npos;
        if (--depth == 0) return i + 1;
      }
      ++i;
    }
    return std::string::npos;
  }
  // Số / true / false / null: đọc tới dấu phân cách.
  size_t j = i;
  while (j < t.size() && t[j] != ',' && t[j] != '}' && t[j] != ']' && !isWs(t[j])) ++j;
  return j == i ? std::string::npos : j;
}

}  // namespace

JsonObject::JsonObject(const char* text, size_t len) : text_(text ? text : "", text ? len : 0) {
  const std::string& t = text_;
  size_t i = 0;
  while (i < t.size() && isWs(t[i])) ++i;
  if (i >= t.size() || t[i] != '{') return;
  ++i;
  while (i < t.size() && isWs(t[i])) ++i;
  if (i < t.size() && t[i] == '}') { valid_ = true; return; }  // {}

  for (;;) {
    while (i < t.size() && isWs(t[i])) ++i;
    Member m;
    i = parseString(t, i, &m.key);
    if (i == std::string::npos) return;
    while (i < t.size() && isWs(t[i])) ++i;
    if (i >= t.size() || t[i] != ':') return;
    ++i;
    while (i < t.size() && isWs(t[i])) ++i;
    m.begin = i;
    i = skipValue(t, i);
    if (i == std::string::npos) return;
    m.end = i;
    if (members_.size() >= kMaxMembers) return;
    members_.push_back(std::move(m));
    while (i < t.size() && isWs(t[i])) ++i;
    if (i >= t.size()) return;
    if (t[i] == ',') { ++i; continue; }
    if (t[i] == '}') {
      ++i;
      while (i < t.size() && isWs(t[i])) ++i;
      valid_ = (i == t.size());  // không cho rác phía sau
      return;
    }
    return;
  }
}

const JsonObject::Member* JsonObject::find(const char* key) const {
  if (!valid_) return nullptr;
  for (const Member& m : members_) {
    if (m.key == key) return &m;
  }
  return nullptr;
}

bool JsonObject::has(const char* key) const { return find(key) != nullptr; }

bool JsonObject::getString(const char* key, std::string& out) const {
  const Member* m = find(key);
  if (!m || text_[m->begin] != '"') return false;
  std::string tmp;
  if (parseString(text_, m->begin, &tmp) == std::string::npos) return false;
  out = std::move(tmp);
  return true;
}

bool JsonObject::getBool(const char* key, bool& out) const {
  const Member* m = find(key);
  if (!m) return false;
  const std::string v = text_.substr(m->begin, m->end - m->begin);
  if (v == "true") { out = true; return true; }
  if (v == "false") { out = false; return true; }
  return false;
}

bool JsonObject::getUInt(const char* key, uint64_t& out) const {
  const Member* m = find(key);
  if (!m || m->end == m->begin) return false;
  uint64_t v = 0;
  for (size_t i = m->begin; i < m->end; i++) {
    char c = text_[i];
    if (c < '0' || c > '9') return false;
    const uint64_t d = static_cast<uint64_t>(c - '0');
    if (v > (UINT64_MAX - d) / 10) return false;  // tràn
    v = v * 10 + d;
  }
  out = v;
  return true;
}

bool JsonObject::getCenti(const char* key, int32_t& out) const {
  const Member* m = find(key);
  if (!m) return false;
  size_t i = m->begin;
  const size_t e = m->end;
  bool neg = false;
  if (i < e && text_[i] == '-') { neg = true; ++i; }
  if (i >= e) return false;
  int64_t whole = 0;
  size_t digits = 0;
  for (; i < e && text_[i] >= '0' && text_[i] <= '9'; ++i, ++digits) {
    whole = whole * 10 + (text_[i] - '0');
    if (whole > 1000) return false;  // |giá trị| tối đa 1000 °C
  }
  if (digits == 0) return false;
  int frac[3] = {0, 0, 0};
  if (i < e && text_[i] == '.') {
    ++i;
    size_t f = 0;
    for (; i < e && text_[i] >= '0' && text_[i] <= '9'; ++i) {
      if (f < 3) frac[f] = text_[i] - '0';
      ++f;
    }
    if (f == 0) return false;
  }
  if (i != e) return false;  // còn ký tự lạ (số mũ, ...)
  int64_t centi = whole * 100 + frac[0] * 10 + frac[1];
  if (frac[2] >= 5) ++centi;  // làm tròn nửa lên theo trị tuyệt đối
  out = static_cast<int32_t>(neg ? -centi : centi);
  return true;
}

bool JsonObject::getObject(const char* key, JsonObject& out) const {
  const Member* m = find(key);
  if (!m || text_[m->begin] != '{') return false;
  out = JsonObject(text_.data() + m->begin, m->end - m->begin);
  return out.valid();
}

}  // namespace auhono
