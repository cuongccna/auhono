// Kết nối Wi-Fi (STA) không chặn, tự nối lại với backoff, và ghi nhận VÌ SAO chưa nối được.
//
// Thiết kế cho tình huống thực tế:
//  - Router khởi động lại sau mất điện mất 2-10 phút: thiết bị thử lại lặng lẽ (10 s -> 20 -> 30 -> 60 s, ±20% mỗi máy),
//    không mở Wi-Fi cấu hình sớm (chính sách mở cổng ở auhono::shouldOpenPortal), không ghi flash (persistent = false).
//  - Lớp tự-nối-lại của Arduino bị TẮT: ta điều khiển toàn bộ nhịp thử (xác định, dễ suy luận, không quét kênh dồn dập).
//  - Cổng cấu hình mở thì STA VẪN tiếp tục thử (router về lại thì tự nối); chỉ tạm dừng ("holdOff") khi có điện thoại
//    đang kết nối vào AP hoặc đang quét, vì thử nối/quét làm AP nhảy kênh và rớt điện thoại.
//  - Lý do rớt (không thấy mạng / sai mật khẩu / khác) lấy từ sự kiện STA_DISCONNECTED để báo cho chủ quán.
#pragma once
#include <stdint.h>

#include "auhono/backoff.h"
#include "auhono/wifi_creds.h"
#include "auhono/wifi_policy.h"

class WifiManager {
 public:
  explicit WifiManager(auhono::IRandom& rng) : backoff_(rng, auhono::Backoff::kWifiStepsMs, 4) {}

  /// Bắt đầu (hoặc bắt đầu lại) kết nối tới mạng đã lưu. Giữ nguyên AP nếu cổng cấu hình đang mở.
  void begin(const auhono::WifiCreds& creds, uint32_t nowMs);
  /// Dừng thử kết nối (không có Wi-Fi lưu).
  void stop();

  /// Gọi liên tục trong loop().
  void loop(uint32_t nowMs);

  /// Tạm dừng các lần thử nối lại (khi điện thoại đang dùng AP cấu hình hoặc đang quét).
  void setHoldOff(bool hold) { holdOff_ = hold; }
  /// Ngắt rồi nối lại sớm (bước cứu hộ 1: nối được Wi-Fi nhưng lâu không liên lạc được server).
  void forceReconnect(uint32_t nowMs);
  /// Tắt hẳn rồi bật lại driver Wi-Fi (bước cứu hộ 2). Không làm gì nếu cổng cấu hình đang mở.
  void restartDriver(uint32_t nowMs);
  /// Đặt công suất phát thấp (8,5 dBm) để giảm dòng đỉnh khi nguồn yếu (dùng sau khi phát hiện brownout).
  static void setLowPower(bool low);

  bool active() const { return active_; }
  bool connected() const { return connected_; }
  auhono::WifiFail lastFail() const { return lastFail_; }
  const auhono::WifiCreds& creds() const { return creds_; }
  /// Thời gian (ms) đã mất kết nối liên tục, 0 nếu đang nối. Tính từ lúc begin() nếu chưa từng nối.
  uint32_t disconnectedForMs(uint32_t nowMs) const;
  /// Thời gian (ms) lý do rớt hiện tại (lastFail) đã kéo dài liên tục.
  uint32_t failStableMs(uint32_t nowMs) const;
  /// Bắt đầu đếm lại thời gian mất kết nối (sau khi cổng cấu hình mở/đóng mà không đổi mạng).
  void resetDisconnectTimer(uint32_t nowMs);

 private:
  void attempt(uint32_t nowMs);
  void consumeEvents(uint32_t nowMs);

  auhono::WifiCreds creds_;
  auhono::Backoff backoff_;
  bool active_ = false;
  bool connected_ = false;
  bool holdOff_ = false;
  auhono::WifiFail lastFail_ = auhono::WifiFail::None;
  uint32_t failSince_ = 0;
  uint32_t seenEventSeq_ = 0;
  uint32_t downSince_ = 0;
  uint32_t nextAttemptAt_ = 0;
  uint32_t lastAttemptAt_ = 0;
};
