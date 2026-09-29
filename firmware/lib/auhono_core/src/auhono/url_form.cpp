#include "auhono/url_form.h"

namespace auhono {

namespace {
int hexVal(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
}  // namespace

bool urlDecode(const std::string& in, std::string& out) {
  std::string r;
  r.reserve(in.size());
  for (size_t i = 0; i < in.size(); i++) {
    const char c = in[i];
    if (c == '+') { r.push_back(' '); continue; }
    if (c != '%') { r.push_back(c); continue; }
    if (i + 2 >= in.size()) return false;  // "%" hoặc "%A" cụt
    const int h = hexVal(in[i + 1]);
    const int l = hexVal(in[i + 2]);
    if (h < 0 || l < 0) return false;
    const char b = static_cast<char>((h << 4) | l);
    if (b == 0) return false;
    r.push_back(b);
    i += 2;
  }
  out = std::move(r);
  return true;
}

bool parseUrlEncoded(const std::string& body, std::vector<FormField>& out) {
  std::vector<FormField> fields;
  size_t pos = 0;
  while (pos <= body.size()) {
    size_t amp = body.find('&', pos);
    if (amp == std::string::npos) amp = body.size();
    if (amp > pos) {
      const std::string pair = body.substr(pos, amp - pos);
      const size_t eq = pair.find('=');
      FormField f;
      if (!urlDecode(pair.substr(0, eq), f.name)) return false;
      if (eq != std::string::npos && !urlDecode(pair.substr(eq + 1), f.value)) return false;
      if (f.name.size() > kMaxFormNameLen || f.value.size() > kMaxFormValueLen) return false;
      if (fields.size() >= kMaxFormFields) return false;
      fields.push_back(std::move(f));
    }
    pos = amp + 1;
  }
  out = std::move(fields);
  return true;
}

std::string formValue(const std::vector<FormField>& fields, const char* name) {
  for (const FormField& f : fields) if (f.name == name) return f.value;
  return std::string();
}

}  // namespace auhono
