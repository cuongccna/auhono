// Phân tích body application/x-www-form-urlencoded có giới hạn (form của cổng cấu hình).
#pragma once
#include <cstddef>
#include <string>
#include <vector>

namespace auhono {

struct FormField {
  std::string name;
  std::string value;
};

constexpr size_t kMaxFormFields = 8;
constexpr size_t kMaxFormNameLen = 32;
constexpr size_t kMaxFormValueLen = 256;

/// Giải mã %XX và '+' -> ' '. false nếu %XX sai/cụt hoặc giải ra byte NUL.
bool urlDecode(const std::string& in, std::string& out);

/// Tách "a=1&b=2". false nếu: mã % sai, byte NUL, quá kMaxFormFields trường, tên > kMaxFormNameLen,
/// giá trị > kMaxFormValueLen (sau giải mã). Cặp rỗng ("&&") bị bỏ qua; trường không có '=' có giá trị rỗng.
bool parseUrlEncoded(const std::string& body, std::vector<FormField>& out);

/// Giá trị của trường đầu tiên tên `name`, hoặc "" nếu không có.
std::string formValue(const std::vector<FormField>& fields, const char* name);

}  // namespace auhono
