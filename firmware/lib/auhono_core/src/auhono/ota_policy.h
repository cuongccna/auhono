// Chính sách OTA thuần túy: so sánh phiên bản (chống hạ cấp/phát lại), nhãn phiên bản nhúng trong ảnh, kiểm tra
// đầu ảnh, sổ theo dõi lần cài (chống vòng lặp OTA), cửa ngõ "khi nào được cài", và điều kiện rollback mềm.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

namespace auhono {

// ── Phiên bản ──────────────────────────────────────────────────────────────
enum class VersionOrder : uint8_t {
  Invalid,  // không phân tích được / không so sánh được
  Older,    // offered < current
  Same,
  Newer,    // offered > current
};

/// So sánh "offered" với "current" theo kiểu semver rút gọn: 1-4 số nguyên cách nhau dấu chấm, sau đó có thể có hậu tố
/// "-pre" (bản tiền phát hành, NHỎ HƠN bản không hậu tố cùng số) hoặc "+build" (bỏ qua). Ví dụ 1.0.10 > 1.0.9;
/// 1.0.0-dev < 1.0.0; 1.0.0+abc == 1.0.0. Hai hậu tố tiền phát hành khác nhau -> Invalid (từ chối cho chắc).
VersionOrder compareVersions(const std::string& current, const std::string& offered);

// ── Nhãn phiên bản nhúng trong ảnh ─────────────────────────────────────────
// Firmware nhúng chuỗi "AUHONO-FWVER:<phiên bản>;" vào .rodata. Vì ảnh được ký ECDSA, nhãn này ĐƯỢC XÁC THỰC cùng ảnh:
// kẻ chiếm server/kho lưu trữ không thể dán nhãn phiên bản mới lên ảnh cũ đã ký (phát lại bản có lỗ hổng): ta đối chiếu
// nhãn trong ảnh với manifest và với phiên bản đang chạy TRƯỚC khi kích hoạt ảnh.
constexpr char kFwTagMarker[] = "AUHONO-FWVER:";
constexpr size_t kFwTagMarkerLen = sizeof(kFwTagMarker) - 1;

/// Quét luồng byte của ảnh (từng đoạn tùy ý) tìm nhãn. Xử lý nhãn nằm vắt ngang hai đoạn. Bỏ qua lần khớp mà phần sau
/// dấu ':' không phải phiên bản hợp lệ kết thúc bằng ';' (ví dụ chính hằng số dò tìm trong mã, theo sau là '\0').
class FwTagScanner {
 public:
  void feed(const uint8_t* data, size_t len);
  /// Đã thấy ít nhất một nhãn hợp lệ.
  bool found() const { return found_; }
  /// Có hai nhãn hợp lệ KHÁC NHAU (ảnh bị ghép/độc hại): phải từ chối.
  bool conflicting() const { return conflict_; }
  const std::string& version() const { return version_; }

 private:
  size_t matched_ = 0;      // số ký tự đầu của marker đã khớp
  bool collecting_ = false;
  std::string cur_;
  bool found_ = false;
  bool conflict_ = false;
  std::string version_;
};

// ── Đầu ảnh ────────────────────────────────────────────────────────────────
enum class ImageCheck : uint8_t { Ok, TooShort, BadMagic, BadSegments, WrongChip, FlashTooBig, NoAppDesc };
constexpr size_t kImageHeaderCheckLen = 36;  // 24 (header) + 8 (segment header) + 4 (magic của esp_app_desc_t)

/// Kiểm tra vài byte đầu của ảnh TRƯỚC khi xóa/ghi khe OTA: byte magic 0xE9, số segment hợp lý, chip_id = ESP32-C3 (0x0005),
/// mã dung lượng flash <= của chip (`maxFlashSizeCode`: 0=1MB,1=2MB,2=4MB,3=8MB,4=16MB) và có esp_app_desc_t (0xABCD5432).
/// Bắt sớm ảnh sai chip / sai kích thước flash mà không tốn một lần xóa flash.
ImageCheck checkImageHeader(const uint8_t* p, size_t len, uint8_t maxFlashSizeCode);
const char* imageCheckText(ImageCheck c);

// ── Sổ cài OTA (chống vòng lặp, rollback mềm) ──────────────────────────────
struct OtaRecord {
  char version[33] = {0};           // phiên bản đang/đã cài gần nhất
  uint8_t installs = 0;             // số lần ĐÃ cài phiên bản này mà chưa được xác nhận
  uint8_t unconfirmedBoots = 0;     // số lần khởi động của bản mới khi chưa xác nhận
  bool pending = false;             // bản mới đang chờ xác nhận
};

constexpr uint8_t kMaxInstallsPerVersion = 3;   // cài một phiên bản mà 3 lần đều không được xác nhận -> ngừng đề nghị lại
constexpr uint8_t kMaxUnconfirmedBoots = 3;     // bản mới khởi động 3 lần mà chưa liên lạc được server -> rollback mềm
constexpr size_t kOtaRecordEncodedLen = 3 + 33 + 4;

size_t encodeOtaRecord(const OtaRecord& r, uint8_t* out, size_t cap);
bool decodeOtaRecord(const uint8_t* data, size_t len, OtaRecord& out);

class IOtaStore {
 public:
  virtual ~IOtaStore() = default;
  virtual bool load(OtaRecord& r) = 0;  // false: chưa có/hỏng
  virtual bool save(const OtaRecord& r) = 0;
};

class OtaLedger {
 public:
  explicit OtaLedger(IOtaStore& store) : store_(store) {}
  void load();

  enum class BootVerdict : uint8_t { Normal, Rollback };
  /// Gọi đầu setup(). Nếu đang chờ xác nhận và đúng là bản mới: tăng đếm khởi động; vượt kMaxUnconfirmedBoots -> Rollback
  /// (bộ nạp của core cũng rollback nếu bật; đây là lớp phòng thủ mềm cho trường hợp nó không làm được).
  /// Nếu ghi nhận bản mới nhưng ta đang chạy bản khác (đã bị rollback): xóa cờ chờ, giữ số lần cài để chặn đề nghị lại.
  BootVerdict onBoot(const std::string& runningVersion);

  /// Có được cài `version` không (chưa vượt kMaxInstallsPerVersion)?
  bool mayInstall(const std::string& version) const;
  /// Ghi sổ TRƯỚC khi kích hoạt ảnh. false nếu không ghi được -> KHÔNG được cài (không thể chặn vòng lặp).
  bool beforeInstall(const std::string& version);
  /// Bản đang chạy đã liên lạc được server: xác nhận, xóa đếm.
  void onConfirmed();

  const OtaRecord& record() const { return rec_; }

 private:
  IOtaStore& store_;
  OtaRecord rec_;
};

// ── Khi nào được phép tải/cài ──────────────────────────────────────────────
enum class OtaDeferral : uint8_t {
  None,           // được cài
  UnsentData,     // còn số đo chưa gửi: gửi trước
  Breach,         // đang có số đo vượt ngưỡng: ưu tiên cảnh báo
  UploadFailing,  // lần gửi gần nhất lỗi: mạng/server đang trục trặc, cài dở dang là rủi ro
  TooEarly,       // mới khởi động: chờ ổn định
  PortalOpen,     // đang có người cấu hình Wi-Fi
  LowHeap,        // không đủ heap cho phiên TLS thứ hai + ghi flash
};
struct OtaGateInputs {
  size_t bufferCount = 0;
  bool breachActive = false;
  bool lastUploadOk = false;
  uint32_t uptimeS = 0;
  bool portalActive = false;
  uint32_t freeHeap = 0;
  uint32_t maxBlock = 0;
};
constexpr uint32_t kOtaMinUptimeS = 120;
constexpr size_t kOtaMaxBacklog = 0;
OtaDeferral otaGate(const OtaGateInputs& in);
const char* otaDeferralText(OtaDeferral d);

// ── Rollback mềm/hẹn giờ cho bản mới chưa xác nhận ─────────────────────────
constexpr uint32_t kRollbackNoContactWindowS = 15u * 60u;   // Wi-Fi đã nối nhưng 15 phút không liên lạc được server
constexpr uint32_t kRollbackHardCapS = 60u * 60u;           // hoặc 60 phút kể từ khi khởi động dù Wi-Fi có nối hay không
/// `wifiUpNoContactS`: số giây Wi-Fi đã nối mà chưa có liên lạc thành công nào kể từ khi khởi động (0 nếu Wi-Fi chưa nối).
/// Chỉ đếm thời gian Wi-Fi nối để cúp điện router ngay sau OTA không làm rollback oan một bản tốt.
bool shouldRollbackUnconfirmed(bool pendingVerify, uint32_t uptimeS, uint32_t wifiUpNoContactS);

}  // namespace auhono
