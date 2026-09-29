// Phân tích phản hồi của server (docs/PROTOCOL.md): thành công, lệch giờ, replay, các lỗi khác;
// và manifest OTA của GET /v1/ota/check.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "auhono/upload_policy.h"

namespace auhono {

enum class ReplyKind : uint8_t {
  Ok,            // 200 + {"ok":true,...}
  ClockSkew,     // 401 + {"error":"clock_skew","server_time":N}
  Replay,        // 409 + {"error":"replay","last_seq":N}
  Unauthorized,  // 401 khác (sai khóa / bị thu hồi)
  TooLarge,      // 413
  BadRequest,    // 400
  ServerError,   // 5xx
  NetworkError,  // status <= 0: không kết nối được / timeout
  Unknown,       // mã khác, hoặc 200 nhưng body không đúng (vd. trang đăng nhập Wi-Fi công cộng)
};

struct ServerReply {
  ReplyKind kind = ReplyKind::Unknown;
  int status = 0;
  uint32_t accepted = 0;
  bool hasServerTime = false;
  uint64_t serverTime = 0;
  bool hasConfig = false;
  Thresholds config;
  bool hasLastSeq = false;
  uint64_t lastSeq = 0;
};

/// `status` <= 0 nghĩa là lỗi mạng (HTTPClient trả mã âm).
/// `requireOkField`: với 200, đòi body là JSON có "ok":true (đúng cho POST /v1/readings). Đặt false
/// cho endpoint có dạng phản hồi khác (GET /v1/ota/check); khi đó chỉ mã 200 được xét và
/// body do người gọi tự kiểm tra (parseOtaManifest).
ServerReply parseReply(int status, const char* body, size_t len, bool requireOkField = true);

/// Kết quả của GET /v1/time: {"server_time":N}
bool parseServerTime(const char* body, size_t len, uint64_t& serverTime);

// ── OTA ────────────────────────────────────────────────────────────────────

enum class OtaParse : uint8_t { NoUpdate, Update, Invalid };

struct OtaManifest {
  std::string version;
  std::string url;                 // luôn bắt đầu bằng https://
  uint8_t sha256[32] = {0};        // SHA-256 của toàn bộ file .bin
  std::vector<uint8_t> signature;  // chữ ký ECDSA P-256 dạng DER (giải mã từ hex)
};

/// {"update":false} -> NoUpdate; {"update":true,"version","url","sha256","signature"} hợp lệ -> Update.
/// Mọi trường thiếu/sai định dạng, url không phải https:// -> Invalid (không cài gì).
OtaParse parseOtaManifest(const char* body, size_t len, OtaManifest& out);

}  // namespace auhono
