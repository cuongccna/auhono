// Gửi số đo trong bộ đệm lên server: gói <= 20 số đo, cũ nhất trước, xử lý từng loại phản hồi.
#pragma once
#include <cstddef>
#include <cstdint>

#include "auhono/device_client.h"
#include "auhono/readings.h"
#include "auhono/server_reply.h"
#include "auhono/upload_policy.h"

namespace auhono {

struct FlushResult {
  bool ok = true;              // không gặp lỗi (kể cả khi còn dữ liệu vì chạm giới hạn số gói)
  size_t remaining = 0;        // số đo còn trong bộ đệm sau lần flush
  ReplyKind lastKind = ReplyKind::Ok;
  size_t sentReadings = 0;     // số đo đã được server nhận (200)
  size_t discardedReadings = 0;  // số đo bị bỏ vì server báo 400 (dữ liệu hỏng, gửi lại vô ích)
  bool reachedServer = false;  // có ít nhất một phản hồi 200
  bool thresholdsChanged = false;  // ngưỡng mới từ server (cần lưu NVS)
};

class ReadingsUploader {
 public:
  /// Số gói tối đa mỗi lần flush (1440 / 20 = 72, dư một ít).
  static constexpr size_t kMaxBatchesPerFlush = 80;
  /// Server bỏ số đo cũ hơn 24 giờ; bỏ trước khi gửi những số đo sắp hết hạn.
  static constexpr uint32_t kMaxAgeSeconds = 24 * 3600;
  static constexpr uint32_t kAgeMarginSeconds = 60;

  ReadingsUploader(DeviceClient& client, ReadingBuffer& buffer, Thresholds& thresholds,
                   IPlatform& platform, const char* firmwareVersion)
      : client_(client), buffer_(buffer), thresholds_(thresholds), platform_(platform), fw_(firmwareVersion) {}

  /// Gửi tới khi hết hàng đợi hoặc gặp lỗi. Số đo chỉ bị xóa khỏi bộ đệm SAU khi server trả 200
  /// (hoặc 400: dữ liệu bị từ chối vĩnh viễn).
  FlushResult flush();

 private:
  DeviceClient& client_;
  ReadingBuffer& buffer_;
  Thresholds& thresholds_;
  IPlatform& platform_;
  const char* fw_;
};

}  // namespace auhono
