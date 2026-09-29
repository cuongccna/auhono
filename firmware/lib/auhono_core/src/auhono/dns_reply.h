// Máy chủ DNS "bắt mọi tên" cho cổng cấu hình (captive portal): mọi truy vấn A đều trả về IP của thiết bị.
//
// Vì sao tự viết thay vì DNSServer của Arduino: DNSServer sao chép các nhãn tên miền vào mảng cố định mà không kiểm
// độ dài/không kiểm còn trong gói hay không -> gói UDP dị dạng từ bất kỳ ai trên Wi-Fi mở có thể làm hỏng bộ nhớ.
// Hàm này thuần túy, kiểm mọi biên, không cấp phát và có test/fuzz chạy trên máy.
#pragma once
#include <cstddef>
#include <cstdint>

namespace auhono {

/// Dựng phản hồi DNS cho gói truy vấn `q` (n byte). Trả độ dài phản hồi (<= 512, ghi vào `out`, cần cap >= 512),
/// hoặc 0 nếu nên BỎ QUA gói (không phải truy vấn chuẩn 1 câu hỏi lớp IN, tên sai/nén, gói cụt...).
///  - Câu hỏi loại A (và ANY): trả một bản ghi A = ip, TTL 30 s.
///  - Loại khác (AAAA, HTTPS/SVCB...): trả "không có dữ liệu" (NOERROR, 0 bản ghi) để trình duyệt chuyển sang IPv4 ngay.
size_t buildDnsReply(const uint8_t* q, size_t n, const uint8_t ip[4], uint8_t* out, size_t cap);

}  // namespace auhono
