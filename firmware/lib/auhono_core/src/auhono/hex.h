// Chuyển đổi hex <-> byte và so sánh thời gian không đổi.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

namespace auhono {

/// Hex thường (a-f), không có khoảng trắng. Ví dụ {0x0a,0xff} -> "0aff".
std::string toHex(const uint8_t* data, size_t len);

/// Giải mã hex CHẶT: độ dài phải chẵn, chỉ ký tự 0-9a-fA-F, không vượt outCap.
/// Trả false nếu sai; khi đó *outLen không đáng tin.
bool fromHex(const char* s, size_t n, uint8_t* out, size_t outCap, size_t* outLen);

/// So sánh hai vùng nhớ cùng độ dài, thời gian không phụ thuộc nội dung.
bool constTimeEqual(const uint8_t* a, const uint8_t* b, size_t len);

}  // namespace auhono
