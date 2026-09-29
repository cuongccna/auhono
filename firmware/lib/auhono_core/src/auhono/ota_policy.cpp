#include "auhono/ota_policy.h"

#include <cstring>

#include "auhono/crc32.h"
#include "auhono/maintenance.h"

namespace auhono {

// ── Phiên bản ──────────────────────────────────────────────────────────────
namespace {

struct ParsedVersion {
  uint32_t nums[4] = {0, 0, 0, 0};
  bool pre = false;
  std::string preTag;
};

bool parseVersion(const std::string& s, ParsedVersion& out) {
  if (s.empty() || s.size() > 32) return false;
  size_t i = 0;
  size_t comps = 0;
  ParsedVersion pv;
  for (;;) {
    if (i >= s.size() || s[i] < '0' || s[i] > '9') return false;
    uint64_t v = 0;
    size_t digits = 0;
    while (i < s.size() && s[i] >= '0' && s[i] <= '9') {
      v = v * 10 + static_cast<uint64_t>(s[i] - '0');
      if (++digits > 9) return false;
      ++i;
    }
    if (comps >= 4) return false;
    pv.nums[comps++] = static_cast<uint32_t>(v);
    if (i < s.size() && s[i] == '.') { ++i; continue; }
    break;
  }
  if (i < s.size()) {
    if (s[i] == '+') {
      // metadata bản dựng: bỏ qua, nhưng vẫn kiểm ký tự
    } else if (s[i] == '-') {
      pv.pre = true;
      size_t plus = s.find('+', i);
      pv.preTag = s.substr(i + 1, plus == std::string::npos ? std::string::npos : plus - i - 1);
      if (pv.preTag.empty()) return false;
    } else {
      return false;
    }
    for (size_t k = i; k < s.size(); k++) {
      const char c = s[k];
      const bool ok = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '.' || c == '-' || c == '+' || c == '_';
      if (!ok) return false;
    }
  }
  out = pv;
  return true;
}

}  // namespace

VersionOrder compareVersions(const std::string& current, const std::string& offered) {
  ParsedVersion c, o;
  if (!parseVersion(current, c) || !parseVersion(offered, o)) return VersionOrder::Invalid;
  for (int i = 0; i < 4; i++) {
    if (o.nums[i] > c.nums[i]) return VersionOrder::Newer;
    if (o.nums[i] < c.nums[i]) return VersionOrder::Older;
  }
  if (c.pre == o.pre) {
    if (!c.pre) return VersionOrder::Same;
    return c.preTag == o.preTag ? VersionOrder::Same : VersionOrder::Invalid;
  }
  return o.pre ? VersionOrder::Older : VersionOrder::Newer;  // bản không hậu tố > bản tiền phát hành cùng số
}

// ── Nhãn phiên bản ─────────────────────────────────────────────────────────
namespace {
bool isTagChar(uint8_t c) {
  return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '.' || c == '-' || c == '_' || c == '+';
}
}  // namespace

void FwTagScanner::feed(const uint8_t* data, size_t len) {
  for (size_t i = 0; i < len; i++) {
    const uint8_t c = data[i];
    if (collecting_) {
      if (c == ';') {
        collecting_ = false;
        if (!cur_.empty()) {
          if (!found_) { found_ = true; version_ = cur_; }
          else if (cur_ != version_) conflict_ = true;
        }
        continue;
      }
      if (isTagChar(c) && cur_.size() < 32) { cur_.push_back(static_cast<char>(c)); continue; }
      collecting_ = false;  // ký tự lạ/quá dài: không phải nhãn thật; xét c như một khởi đầu marker mới
    }
    if (c == static_cast<uint8_t>(kFwTagMarker[matched_])) {
      if (++matched_ == kFwTagMarkerLen) { matched_ = 0; collecting_ = true; cur_.clear(); }
    } else {
      // marker không có chữ nào lặp lại ở đầu ngoài 'A' ở vị trí 0 nên chỉ cần xét lại ký tự đầu.
      matched_ = (c == static_cast<uint8_t>(kFwTagMarker[0])) ? 1 : 0;
    }
  }
}

// ── Đầu ảnh ────────────────────────────────────────────────────────────────
ImageCheck checkImageHeader(const uint8_t* p, size_t len, uint8_t maxFlashSizeCode) {
  if (!p || len < kImageHeaderCheckLen) return ImageCheck::TooShort;
  if (p[0] != 0xE9) return ImageCheck::BadMagic;
  if (p[1] == 0 || p[1] > 16) return ImageCheck::BadSegments;
  const uint16_t chip = static_cast<uint16_t>(p[12] | (p[13] << 8));
  if (chip != 0x0005) return ImageCheck::WrongChip;  // ESP_CHIP_ID_ESP32C3
  if ((p[3] >> 4) > maxFlashSizeCode) return ImageCheck::FlashTooBig;
  const uint32_t appMagic = static_cast<uint32_t>(p[32]) | (static_cast<uint32_t>(p[33]) << 8) | (static_cast<uint32_t>(p[34]) << 16) |
                            (static_cast<uint32_t>(p[35]) << 24);
  if (appMagic != 0xABCD5432u) return ImageCheck::NoAppDesc;
  return ImageCheck::Ok;
}

const char* imageCheckText(ImageCheck c) {
  switch (c) {
    case ImageCheck::Ok:          return "ok";
    case ImageCheck::TooShort:    return "anh qua ngan";
    case ImageCheck::BadMagic:    return "khong phai anh firmware ESP";
    case ImageCheck::BadSegments: return "so segment sai";
    case ImageCheck::WrongChip:   return "anh cho chip khac (khong phai ESP32-C3)";
    case ImageCheck::FlashTooBig: return "anh doi hoi flash lon hon chip";
    case ImageCheck::NoAppDesc:   return "thieu esp_app_desc";
  }
  return "?";
}

// ── Sổ cài ─────────────────────────────────────────────────────────────────
size_t encodeOtaRecord(const OtaRecord& r, uint8_t* out, size_t cap) {
  if (cap < kOtaRecordEncodedLen) return 0;
  size_t i = 0;
  out[i++] = 0x5A;                                  // magic
  out[i++] = static_cast<uint8_t>((r.installs & 0x0F) | (r.unconfirmedBoots << 4));
  out[i++] = r.pending ? 1 : 0;
  for (size_t k = 0; k < 33; k++) out[i++] = static_cast<uint8_t>(r.version[k]);
  const uint32_t crc = crc32(out, i);
  for (int b = 0; b < 4; b++) out[i++] = static_cast<uint8_t>(crc >> (8 * b));
  return i;
}

bool decodeOtaRecord(const uint8_t* d, size_t len, OtaRecord& out) {
  if (!d || len != kOtaRecordEncodedLen || d[0] != 0x5A) return false;
  uint32_t stored = 0;
  for (int b = 0; b < 4; b++) stored |= static_cast<uint32_t>(d[len - 4 + static_cast<size_t>(b)]) << (8 * b);
  if (crc32(d, len - 4) != stored) return false;
  if (d[2] > 1 || d[3 + 32] != 0) return false;     // cờ hợp lệ, chuỗi có '\0' kết thúc
  OtaRecord r;
  r.installs = d[1] & 0x0F;
  r.unconfirmedBoots = static_cast<uint8_t>(d[1] >> 4);
  r.pending = d[2] == 1;
  for (size_t k = 0; k < 33; k++) r.version[k] = static_cast<char>(d[3 + k]);
  for (size_t k = 0; r.version[k]; k++) {
    const uint8_t c = static_cast<uint8_t>(r.version[k]);
    if (!isTagChar(c)) return false;
  }
  out = r;
  return true;
}

void OtaLedger::load() {
  OtaRecord r;
  if (store_.load(r)) rec_ = r; else rec_ = OtaRecord();
}

OtaLedger::BootVerdict OtaLedger::onBoot(const std::string& running) {
  if (!rec_.pending) return BootVerdict::Normal;
  if (running != rec_.version) {
    // Ta là bản CŨ chạy lại sau rollback: bản mới không được xác nhận. Giữ `installs` để chặn đề nghị lại.
    rec_.pending = false;
    rec_.unconfirmedBoots = 0;
    store_.save(rec_);
    return BootVerdict::Normal;
  }
  if (rec_.unconfirmedBoots < 15) ++rec_.unconfirmedBoots;
  store_.save(rec_);
  if (rec_.unconfirmedBoots > kMaxUnconfirmedBoots) return BootVerdict::Rollback;
  return BootVerdict::Normal;
}

bool OtaLedger::mayInstall(const std::string& version) const {
  return !(version == rec_.version && rec_.installs >= kMaxInstallsPerVersion);
}

bool OtaLedger::beforeInstall(const std::string& version) {
  if (version.empty() || version.size() > 32) return false;
  OtaRecord next = rec_;
  if (version != next.version) {
    std::memset(next.version, 0, sizeof next.version);
    std::memcpy(next.version, version.data(), version.size());
    next.installs = 0;
  }
  if (next.installs < 15) ++next.installs;
  next.pending = true;
  next.unconfirmedBoots = 0;
  if (!store_.save(next)) return false;
  rec_ = next;
  return true;
}

void OtaLedger::onConfirmed() {
  if (!rec_.pending && rec_.installs == 0 && rec_.unconfirmedBoots == 0) return;  // không cần ghi flash
  rec_.pending = false;
  rec_.installs = 0;
  rec_.unconfirmedBoots = 0;
  store_.save(rec_);
}

// ── Cửa ngõ ────────────────────────────────────────────────────────────────
OtaDeferral otaGate(const OtaGateInputs& in) {
  if (in.uptimeS < kOtaMinUptimeS) return OtaDeferral::TooEarly;
  if (in.portalActive) return OtaDeferral::PortalOpen;
  if (in.breachActive) return OtaDeferral::Breach;
  if (in.bufferCount > kOtaMaxBacklog) return OtaDeferral::UnsentData;
  if (!in.lastUploadOk) return OtaDeferral::UploadFailing;
  if (!tlsHeapOk(in.freeHeap, in.maxBlock)) return OtaDeferral::LowHeap;
  return OtaDeferral::None;
}

const char* otaDeferralText(OtaDeferral d) {
  switch (d) {
    case OtaDeferral::None:          return "ok";
    case OtaDeferral::UnsentData:    return "con so do chua gui";
    case OtaDeferral::Breach:        return "dang vuot nguong";
    case OtaDeferral::UploadFailing: return "lan gui gan nhat loi";
    case OtaDeferral::TooEarly:      return "moi khoi dong";
    case OtaDeferral::PortalOpen:    return "cong cau hinh dang mo";
    case OtaDeferral::LowHeap:       return "heap thap";
  }
  return "?";
}

bool shouldRollbackUnconfirmed(bool pendingVerify, uint32_t uptimeS, uint32_t wifiUpNoContactS) {
  if (!pendingVerify) return false;
  return wifiUpNoContactS >= kRollbackNoContactWindowS || uptimeS >= kRollbackHardCapS;
}

}  // namespace auhono
