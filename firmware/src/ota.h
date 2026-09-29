// Cập nhật firmware từ xa (OTA) có xác thực chữ ký, chống hạ cấp và chống vòng lặp.
//
// Quy trình (ota.cpp):
//   1. GET /v1/ota/check?current=<FW_VERSION> (có ký HMAC, body rỗng). Phản hồi 200 cũng là bằng chứng "đã liên lạc được
//      server" nên dùng để XÁC NHẬN bản firmware mới (kể cả khi cảm biến hỏng và không có số đo nào để gửi).
//   2. Bản offered phải MỚI HƠN bản đang chạy (auhono::compareVersions): không hạ cấp, không phát lại bản cũ.
//   3. Hoãn nếu còn số đo chưa gửi / đang vượt ngưỡng / lần gửi gần nhất lỗi / heap thấp (auhono::otaGate): gửi trước, cài sau.
//   4. Tải qua HTTPS (theo chuyển hướng CÙNG giao thức https, tối đa 4 lần; CDN/GitHub/R2 hay chuyển hướng), đọc 36 byte đầu để
//      kiểm chip/dung lượng flash TRƯỚC khi ghi flash; ghi thẳng vào khe OTA kia bằng Update, băm SHA-256 và dò nhãn phiên bản
//      "AUHONO-FWVER:x.y.z;" song song. Trong lúc tải vòng lặp chính vẫn đo/đèn/nút (ctx.tick) và HỦY tải nếu vừa vượt ngưỡng.
//   5. Đối chiếu sha256 VÀ chữ ký ECDSA P-256 (khóa nhúng lúc build) VÀ nhãn phiên bản trong ảnh (được ký) == manifest và > bản
//      đang chạy. Chỉ khi cả ba đúng: ghi sổ cài (chống vòng lặp) rồi Update.end() (đặt khe khởi động).
#pragma once
#include <stddef.h>
#include <stdint.h>

#include "auhono/device_client.h"
#include "auhono/ota_policy.h"

enum class OtaOutcome {
  NoUpdate,     // server không có bản mới (hoặc cùng phiên bản)
  CheckFailed,  // không hỏi được server / manifest lỗi / phiên bản không so sánh được
  Deferred,     // có bản mới nhưng đang hoãn (còn số đo chưa gửi, đang vượt ngưỡng, heap thấp...): hỏi lại sớm
  Blocked,      // phiên bản này đã cài quá số lần cho phép mà không được xác nhận: bỏ qua tới khi server đề nghị bản khác
  Rejected,     // tải/kiểm chứng thất bại, hạ cấp, hoặc bị hủy: đã hủy, giữ bản đang chạy
  Installed,    // đã cài, cần khởi động lại (ESP.restart() do người gọi)
};

struct OtaContext {
  // Ảnh chụp trạng thái cho cửa ngõ hoãn cài:
  size_t bufferCount = 0;
  bool breachActive = false;
  bool lastUploadOk = false;
  uint32_t uptimeS = 0;
  bool portalActive = false;
  // Sổ cài (bắt buộc):
  auhono::OtaLedger* ledger = nullptr;
  // Gọi liên tục trong lúc tải: giữ nhịp đo/đèn/nút. Trả false để HỦY tải (vd. vừa vượt ngưỡng: ưu tiên cảnh báo). Có thể null.
  bool (*tick)(void* user) = nullptr;
  void* user = nullptr;
  // Kết quả ra:
  bool contacted = false;  // yêu cầu kiểm tra có ký nhận được HTTP 200 => xác nhận đã liên lạc được server
};

OtaOutcome otaCheckAndUpdate(auhono::DeviceClient& client, auhono::IPlatform& platform, OtaContext& ctx, bool insecureRescue);
