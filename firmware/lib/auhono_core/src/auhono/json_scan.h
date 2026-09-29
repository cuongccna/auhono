// Bộ quét JSON tối giản cho phản hồi của server (không dùng thư viện ngoài, không đệ quy).
// Chỉ đọc các khóa Ở CẤP NGOÀI CÙNG của một object; giá trị lồng nhau được bỏ qua chính xác
// (chuỗi có dấu ngoặc/dấu nháy không làm lệch), nên khóa trùng tên ở cấp trong không bị nhầm.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace auhono {

class JsonObject {
 public:
  JsonObject(const char* text, size_t len);

  /// Văn bản là một object JSON hoàn chỉnh, hợp lệ về cú pháp cấu trúc.
  bool valid() const { return valid_; }

  bool has(const char* key) const;
  bool getString(const char* key, std::string& out) const;
  bool getBool(const char* key, bool& out) const;
  /// Số nguyên không dấu, chỉ chữ số (không dấu, phần thập phân, mũ), không tràn 64 bit.
  bool getUInt(const char* key, uint64_t& out) const;
  /// Số thập phân -> centi-độ (làm tròn tới 0,01). Từ chối số mũ và giá trị ngoài ±100000.
  bool getCenti(const char* key, int32_t& out) const;
  bool getObject(const char* key, JsonObject& out) const;

 private:
  struct Member {
    std::string key;
    size_t begin;  // vị trí đầu giá trị trong text_
    size_t end;    // sau ký tự cuối của giá trị
  };
  const Member* find(const char* key) const;

  std::string text_;
  std::vector<Member> members_;
  bool valid_ = false;
};

}  // namespace auhono
