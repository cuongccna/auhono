// Bộ đếm `seq` tăng nghiêm ngặt, hạn chế mòn flash.
//
// Chính sách: không ghi NVS mỗi request. Ta lưu một "trần" (ceiling): mọi seq <= trần
// có thể đã được dùng. Khi seq sắp vượt trần, ghi trần mới = seq + stride - 1 TRƯỚC khi dùng.
// Sau khi khởi động lại, seq tiếp theo = trần + 1 (nhảy vọt; khoảng trống là chấp nhận được
// vì server chỉ đòi seq > last_seq). Số lần ghi: 1 lần mỗi lần khởi động + 1 lần mỗi `stride` request.
#pragma once
#include <cstdint>

namespace auhono {

/// Nơi lưu trần seq bền vững (NVS trên chip, bộ nhớ giả khi test).
class ISeqStore {
 public:
  virtual ~ISeqStore() = default;
  virtual bool load(uint64_t& value) = 0;  // false nếu chưa có / lỗi đọc
  virtual bool save(uint64_t value) = 0;   // false nếu ghi lỗi
};

class SeqCounter {
 public:
  static constexpr uint64_t kDefaultStride = 64;
  /// Server dùng số nguyên an toàn của JS (2^53); ta không bao giờ đi quá mức này.
  static constexpr uint64_t kMaxSeq = 1ULL << 52;

  explicit SeqCounter(ISeqStore& store, uint64_t stride = kDefaultStride);

  /// Đọc trần đã lưu; seq đầu tiên sẽ là trần + 1 (hoặc 1 nếu chưa có gì).
  void begin();

  /// seq mới, luôn lớn hơn mọi giá trị đã trả về (kể cả trước lần khởi động lại).
  /// Nếu ghi NVS lỗi vẫn trả giá trị: server sẽ trả 409 nếu bị trùng và ta tự đồng bộ lại.
  uint64_t next();

  /// Xử lý 409 replay: bảo đảm next() > serverLastSeq. Giá trị vô lý (> kMaxSeq) bị bỏ qua.
  void raiseTo(uint64_t serverLastSeq);

  uint64_t last() const { return last_; }
  uint32_t saveFailures() const { return saveFailures_; }

 private:
  ISeqStore& store_;
  uint64_t stride_;
  uint64_t last_ = 0;     // seq đã dùng gần nhất
  uint64_t ceiling_ = 0;  // trần đã lưu bền vững
  uint32_t saveFailures_ = 0;
};

}  // namespace auhono
