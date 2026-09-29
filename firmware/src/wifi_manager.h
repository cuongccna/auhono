// Kết nối Wi-Fi (STA) không chặn, tự nối lại với backoff. Không ghi flash (persistent = false).
#pragma once
#include <stdint.h>

#include "auhono/backoff.h"
#include "storage.h"

class WifiManager {
 public:
  explicit WifiManager(auhono::IRandom& rng) : backoff_(rng) {}

  /// Bắt đầu kết nối tới mạng đã lưu. Gọi lại khi đổi mạng.
  void begin(const WifiCreds& creds, uint32_t nowMs);
  /// Dừng STA (khi mở cổng cấu hình ở chế độ AP thuần).
  void stop();

  /// Gọi liên tục trong loop().
  void loop(uint32_t nowMs);

  bool connected() const { return connected_; }
  /// Thời gian (ms) đã mất kết nối liên tục, 0 nếu đang nối. Tính từ lúc begin() nếu chưa từng nối.
  uint32_t disconnectedForMs(uint32_t nowMs) const;
  /// Bắt đầu đếm lại thời gian mất kết nối (sau khi cổng cấu hình đóng mà không đổi mạng).
  void resetDisconnectTimer(uint32_t nowMs) { downSince_ = nowMs; }

 private:
  WifiCreds creds_;
  auhono::Backoff backoff_;
  bool active_ = false;
  bool connected_ = false;
  uint32_t downSince_ = 0;
  uint32_t nextAttemptAt_ = 0;
};
