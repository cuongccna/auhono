// Cập nhật firmware từ xa (OTA) có xác thực chữ ký.
//
// Quy trình (ota.cpp):
//   1. GET /v1/ota/check?current=<FW_VERSION> (có ký HMAC, body rỗng).
//   2. Nếu update=true: tải `url` qua HTTPS (xác thực chứng chỉ), ghi thẳng vào phân vùng OTA
//      bằng Update, đồng thời tính SHA-256 khi tải.
//   3. Kiểm SHA-256 == manifest.sha256 VÀ chữ ký ECDSA P-256 (DER, hex trong manifest.signature)
//      trên SHA-256 đó, bằng khóa công khai nhúng lúc build (keys/ota_public.pem).
//   4. Chỉ khi cả hai đúng mới Update.end() (đặt phân vùng khởi động) rồi khởi động lại.
//      Sai một trong hai: Update.abort(), bản đang chạy giữ nguyên.
#pragma once
#include "auhono/device_client.h"

enum class OtaOutcome {
  NoUpdate,     // server không có bản mới
  CheckFailed,  // không hỏi được server / manifest lỗi
  Rejected,     // tải xong nhưng sha256/chữ ký sai, hoặc lỗi ghi flash: đã hủy
  Installed,    // đã cài, cần khởi động lại (ESP.restart() do người gọi)
};

OtaOutcome otaCheckAndUpdate(auhono::DeviceClient& client, auhono::IPlatform& platform);
