#include "auhono/dns_reply.h"

namespace auhono {

size_t buildDnsReply(const uint8_t* q, size_t n, const uint8_t ip[4], uint8_t* out, size_t cap) {
  constexpr size_t kHeader = 12;
  if (!q || !out || cap < 512 || n < kHeader + 5 || n > 512) return 0;

  const uint16_t flags = static_cast<uint16_t>((q[2] << 8) | q[3]);
  const uint16_t qd = static_cast<uint16_t>((q[4] << 8) | q[5]);
  const uint16_t an = static_cast<uint16_t>((q[6] << 8) | q[7]);
  const uint16_t ns = static_cast<uint16_t>((q[8] << 8) | q[9]);
  if ((flags & 0x8000) != 0) return 0;              // là phản hồi, không phải truy vấn
  if (((flags >> 11) & 0x0F) != 0) return 0;        // opcode khác QUERY
  if (qd != 1 || an != 0 || ns != 0) return 0;      // chỉ nhận đúng 1 câu hỏi (ARCOUNT/EDNS được bỏ qua)

  // QNAME: chuỗi nhãn [len][bytes]... kết thúc bằng 0. Cấm con trỏ nén trong câu hỏi.
  size_t pos = kHeader;
  size_t nameLen = 0;
  for (;;) {
    if (pos >= n) return 0;
    const uint8_t l = q[pos];
    if (l == 0) { ++pos; break; }
    if ((l & 0xC0) != 0 || l > 63) return 0;
    nameLen += static_cast<size_t>(l) + 1;
    if (nameLen > 255 || pos + 1 + l > n) return 0;
    pos += 1 + l;
  }
  if (pos + 4 > n) return 0;
  const uint16_t qtype = static_cast<uint16_t>((q[pos] << 8) | q[pos + 1]);
  const uint16_t qclass = static_cast<uint16_t>((q[pos + 2] << 8) | q[pos + 3]);
  if (qclass != 1) return 0;                          // chỉ lớp IN
  const size_t qend = pos + 4;

  const bool wantA = (qtype == 1 || qtype == 255);
  size_t o = 0;
  out[o++] = q[0]; out[o++] = q[1];                   // ID
  const uint16_t rflags = static_cast<uint16_t>(0x8400 | (flags & 0x0100) | 0x0080);  // QR, AA, RD (sao chép), RA
  out[o++] = static_cast<uint8_t>(rflags >> 8); out[o++] = static_cast<uint8_t>(rflags & 0xFF);
  out[o++] = 0; out[o++] = 1;                         // QDCOUNT
  out[o++] = 0; out[o++] = wantA ? 1 : 0;             // ANCOUNT
  out[o++] = 0; out[o++] = 0;                         // NSCOUNT
  out[o++] = 0; out[o++] = 0;                         // ARCOUNT
  for (size_t i = kHeader; i < qend; i++) out[o++] = q[i];  // nhắc lại câu hỏi
  if (wantA) {
    static const uint8_t kAnswer[] = {0xC0, 0x0C,     // tên: con trỏ tới câu hỏi
                                      0x00, 0x01,     // TYPE A
                                      0x00, 0x01,     // CLASS IN
                                      0x00, 0x00, 0x00, 0x1E,  // TTL 30 s
                                      0x00, 0x04};    // RDLENGTH
    for (uint8_t b : kAnswer) out[o++] = b;
    for (int i = 0; i < 4; i++) out[o++] = ip[i];
  }
  return o;
}

}  // namespace auhono
