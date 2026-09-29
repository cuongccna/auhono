// CRC-32 (IEEE 802.3, đa thức 0xEDB88320 dạng đảo, khởi tạo/xor cuối 0xFFFFFFFF). Dùng để kiểm bản ghi lưu NVS:
// đọc lên mà CRC sai (mất điện giữa lúc ghi, flash lỗi) thì coi như không có, không bao giờ dùng dữ liệu nửa vời.
#pragma once
#include <cstddef>
#include <cstdint>

namespace auhono {

uint32_t crc32(const uint8_t* data, size_t len);

}  // namespace auhono
