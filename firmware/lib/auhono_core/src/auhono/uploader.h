// Gửi số đo trong bộ đệm lên server: gói <= 20 số đo, cũ nhất trước, xử lý từng loại phản hồi.
//
// Thời gian: số đo trong bộ đệm mang giờ ĐƠN ĐIỆU (giây từ lúc khởi động). Ngay trước MỖI lần gửi (kể cả gửi lại
// sau khi đồng hồ được chỉnh) giờ unix được tính lại: unix = unixNow - (monoNow - t). Vì vậy:
//   - số đo lấy trước khi có NTP vẫn được gửi với giờ đúng;
//   - NTP/clock_skew chỉnh đồng hồ giữa chừng không làm sai hay đảo thứ tự dấu thời gian.
// Server bỏ số đo cũ hơn 24 giờ hoặc ở tương lai quá 5 phút: ta bỏ trước (đếm lại), kẹp về `unixNow`.
#pragma once
#include <cstddef>
#include <cstdint>

#include "auhono/device_client.h"
#include "auhono/readings.h"
#include "auhono/retry_policy.h"
#include "auhono/server_reply.h"
#include "auhono/upload_policy.h"

namespace auhono {

struct FlushResult {
  bool ok = true;              // không gặp lỗi (kể cả khi còn dữ liệu vì chạm giới hạn gói/thời gian)
  size_t remaining = 0;        // số đo còn trong bộ đệm sau lần flush
  ReplyKind lastKind = ReplyKind::Ok;
  int lastStatus = 0;          // mã HTTP của phản hồi cuối (<= 0: lỗi mạng)
  FailClass failClass = FailClass::None;  // chọn nhịp thử lại (retry_policy.h)
  size_t sentReadings = 0;     // số đo đã được server nhận (200)
  size_t serverDroppedReadings = 0;  // server nhận gói nhưng báo accepted < gửi (ngoài cửa sổ giờ...)
  size_t discardedReadings = 0;  // số đo bị bỏ vì server từ chối vĩnh viễn (400/413 ngay cả khi gửi riêng lẻ)
  size_t staleDropped = 0;     // số đo bỏ vì quá cũ (>24 giờ) hoặc không đổi được sang giờ unix
  bool reachedServer = false;  // có ít nhất một phản hồi 200
  bool thresholdsChanged = false;  // ngưỡng mới từ server (cần lưu NVS)
  bool clockNotReady = false;  // đồng hồ chưa đáng tin: chưa thử gửi gì
  bool certError = false;      // lần thất bại cuối là lỗi xác thực chứng chỉ TLS
};

class ReadingsUploader {
 public:
  /// Giới hạn công việc MỖI lần flush để vòng lặp chính không bị chặn quá lâu (mỗi request ~1-3 s vì
  /// bắt tay TLS mới): còn dữ liệu thì main gọi lại sau ít giây, giữa chừng vẫn đo/đèn/nút bấm bình thường.
  static constexpr size_t kMaxBatchesPerFlush = 6;
  static constexpr uint32_t kFlushBudgetMs = 20000;
  /// Server bỏ số đo cũ hơn 24 giờ; bỏ trước những số đo sắp hết hạn. Biên = dung sai lệch giờ của server
  /// (±300 s) + dự phòng, để số đo sát mốc không bị server loại vì đồng hồ máy chậm vài phút.
  static constexpr uint32_t kMaxAgeSeconds = 24 * 3600;
  static constexpr uint32_t kAgeMarginSeconds = 360;
  /// Tối đa số đo bị bỏ vĩnh viễn (server cứ trả 400 dù gửi riêng từng số đo) MỖI lần flush. Vượt mức này
  /// thì coi là server/giao thức có vấn đề chứ không phải số đo hỏng: dừng, GIỮ dữ liệu, thử lại chậm.
  static constexpr size_t kMaxPoisonDropsPerFlush = 2;

  ReadingsUploader(DeviceClient& client, ReadingBuffer& buffer, Thresholds& thresholds,
                   IPlatform& platform, const char* firmwareVersion)
      : client_(client), buffer_(buffer), thresholds_(thresholds), platform_(platform), fw_(firmwareVersion) {}

  /// Chẩn đoán kèm mọi gói (số đo và nhịp tim). Gọi trước mỗi flush/heartbeat để giá trị luôn mới. Không gọi = không có diag
  /// (body giữ nguyên như giao thức cũ).
  void setDiag(const Diag& d) { diag_ = d; hasDiag_ = true; }
  void clearDiag() { hasDiag_ = false; }

  /// Gói nhịp tim: `readings: []` + diag (bắt buộc đã setDiag). KHÔNG đụng tới bộ đệm, gửi đúng MỘT request, không chia đôi,
  /// không bao giờ bỏ gì: 400/413 chỉ là thất bại (Persistent) để tầng trên thử lại chậm. Cùng ký/seq/xử lý giờ như gói số đo.
  FlushResult heartbeat();

  /// Gửi tới khi hết hàng đợi, gặp lỗi, hoặc hết ngân sách. Số đo chỉ bị xóa khỏi bộ đệm SAU khi server
  /// trả 200 (hoặc từ chối vĩnh viễn từng số đo riêng lẻ, xem kMaxPoisonDropsPerFlush).
  ///
  /// 400/413 cho cả gói: chia đôi gói rồi gửi lại (tìm số đo "độc"), KHÔNG xóa cả gói.
  FlushResult flush();

 private:
  DeviceClient& client_;
  ReadingBuffer& buffer_;
  Thresholds& thresholds_;
  IPlatform& platform_;
  const char* fw_;
  Diag diag_;
  bool hasDiag_ = false;
};

}  // namespace auhono
