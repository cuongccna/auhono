// OTA: so sánh phiên bản (chống hạ cấp), nhãn phiên bản nhúng trong ảnh, đầu ảnh, sổ cài (chống vòng lặp/rollback mềm),
// cửa ngõ hoãn cài, và các chính sách bảo trì/cứu hộ.
#include <unity.h>

#include <cstring>
#include <random>
#include <string>
#include <vector>

#include "auhono/maintenance.h"
#include "auhono/ota_policy.h"

using namespace auhono;

// ── Phiên bản ──────────────────────────────────────────────────────────────

static void test_version_compare_table() {
  struct Row { const char* cur; const char* off; VersionOrder want; };
  const Row rows[] = {
      {"1.0.0", "1.0.1", VersionOrder::Newer}, {"1.0.9", "1.0.10", VersionOrder::Newer},   // số, không phải chữ
      {"1.0.0", "1.0.0", VersionOrder::Same},  {"1.0.1", "1.0.0", VersionOrder::Older},    // hạ cấp
      {"2.0.0", "1.9.9", VersionOrder::Older}, {"1.0", "1.0.0", VersionOrder::Same},       // thiếu thành phần = 0
      {"1.0.0", "1.0.0.1", VersionOrder::Newer},
      {"1.0.0-dev", "1.0.0", VersionOrder::Newer}, {"1.0.0", "1.0.0-rc1", VersionOrder::Older},
      {"1.0.0-rc1", "1.0.0-rc1", VersionOrder::Same}, {"1.0.0-rc1", "1.0.0-rc2", VersionOrder::Invalid},
      {"1.0.0+abc", "1.0.0+xyz", VersionOrder::Same}, {"0.0.0-dev", "1.0.0", VersionOrder::Newer},
      {"1.0.0", "", VersionOrder::Invalid}, {"1.0.0", "abc", VersionOrder::Invalid}, {"", "1.0.0", VersionOrder::Invalid},
      {"1.0.0", "1..0", VersionOrder::Invalid}, {"1.0.0", "1.0.0.0.0", VersionOrder::Invalid},
      {"1.0.0", "v1.0.1", VersionOrder::Invalid}, {"1.0.0", "1.0.1 ", VersionOrder::Invalid},
      {"1.0.0", "9999999999.0.0", VersionOrder::Invalid},   // quá nhiều chữ số: từ chối, không tràn
      {"1.0.0", "1.0.0-", VersionOrder::Invalid},
  };
  for (const Row& r : rows) TEST_ASSERT_EQUAL_MESSAGE(static_cast<int>(r.want), static_cast<int>(compareVersions(r.cur, r.off)), r.off);
}

// ── Nhãn phiên bản trong ảnh ───────────────────────────────────────────────

static std::vector<uint8_t> fakeImage(const std::string& tag) {
  std::vector<uint8_t> img(4096, 0x5A);
  for (size_t i = 0; i < img.size(); i += 7) img[i] = static_cast<uint8_t>(i);  // "mã máy" bất kỳ
  const size_t pos = 1500;
  memcpy(img.data() + pos, tag.data(), tag.size());
  return img;
}

static void test_tag_scanner_finds_tag_regardless_of_chunking() {
  const std::vector<uint8_t> img = fakeImage("AUHONO-FWVER:1.2.3;");
  for (size_t chunk : {1u, 2u, 3u, 5u, 13u, 64u, 1000u, 4096u}) {
    FwTagScanner sc;
    for (size_t off = 0; off < img.size(); off += chunk) sc.feed(img.data() + off, std::min(chunk, img.size() - off));
    TEST_ASSERT_TRUE(sc.found());
    TEST_ASSERT_FALSE(sc.conflicting());
    TEST_ASSERT_EQUAL_STRING("1.2.3", sc.version().c_str());
  }
  // Nhãn vắt ngang ranh giới đoạn ở MỌI vị trí
  const std::string tag = "AUHONO-FWVER:10.20.30-rc1;";
  for (size_t split = 1; split < tag.size(); split++) {
    FwTagScanner sc;
    sc.feed(reinterpret_cast<const uint8_t*>(tag.data()), split);
    sc.feed(reinterpret_cast<const uint8_t*>(tag.data()) + split, tag.size() - split);
    TEST_ASSERT_TRUE(sc.found());
    TEST_ASSERT_EQUAL_STRING("10.20.30-rc1", sc.version().c_str());
  }
}

static void test_tag_scanner_ignores_the_probe_constant_and_garbage() {
  // Chính hằng số dò tìm nằm trong mã của firmware, theo sau là '\0': không phải nhãn
  std::vector<uint8_t> img(200, 0);
  memcpy(img.data() + 10, "AUHONO-FWVER:", 13);
  FwTagScanner sc;
  sc.feed(img.data(), img.size());
  TEST_ASSERT_FALSE(sc.found());
  // "AUHONO-FWVER:" theo sau bởi rác không kết thúc bằng ';', hoặc phiên bản quá dài
  FwTagScanner g;
  const std::string junk = "AUHONO-FWVER:1.0.0 AUHONO-FWVER:" + std::string(40, '1') + ";AUHONO-FWVER:;AUHONO-AUHONO-FWVER:2.0.0;";
  g.feed(reinterpret_cast<const uint8_t*>(junk.data()), junk.size());
  TEST_ASSERT_TRUE(g.found());   // chỉ "2.0.0" (sau "AUHONO-" lặp) là hợp lệ
  TEST_ASSERT_EQUAL_STRING("2.0.0", g.version().c_str());
  // Không có nhãn
  FwTagScanner none;
  const std::vector<uint8_t> plain(5000, 0xAB);
  none.feed(plain.data(), plain.size());
  TEST_ASSERT_FALSE(none.found());
}

static void test_tag_scanner_detects_conflicting_tags() {
  FwTagScanner sc;
  const std::string two = "xxAUHONO-FWVER:1.0.0;yyAUHONO-FWVER:9.9.9;";
  sc.feed(reinterpret_cast<const uint8_t*>(two.data()), two.size());
  TEST_ASSERT_TRUE(sc.found());
  TEST_ASSERT_TRUE(sc.conflicting());   // ảnh bị ghép/độc hại: phải từ chối
  FwTagScanner same;
  const std::string dup = "AUHONO-FWVER:1.0.0;AUHONO-FWVER:1.0.0;";   // trùng nhau là bình thường
  same.feed(reinterpret_cast<const uint8_t*>(dup.data()), dup.size());
  TEST_ASSERT_FALSE(same.conflicting());
}

// ── Đầu ảnh ────────────────────────────────────────────────────────────────

static std::vector<uint8_t> goodHeader() {
  std::vector<uint8_t> h(64, 0);
  h[0] = 0xE9; h[1] = 5; h[2] = 2; h[3] = 0x2F;   // 4 MB (mã 2), 80 MHz
  h[12] = 0x05; h[13] = 0x00;                     // ESP32-C3
  h[32] = 0x32; h[33] = 0x54; h[34] = 0xCD; h[35] = 0xAB;   // 0xABCD5432
  return h;
}

static void test_image_header_checks() {
  std::vector<uint8_t> h = goodHeader();
  TEST_ASSERT_EQUAL(ImageCheck::Ok, checkImageHeader(h.data(), h.size(), 2));
  TEST_ASSERT_EQUAL(ImageCheck::TooShort, checkImageHeader(h.data(), 35, 2));
  TEST_ASSERT_EQUAL(ImageCheck::TooShort, checkImageHeader(nullptr, 0, 2));
  auto mod = [&](size_t i, uint8_t v) { std::vector<uint8_t> x = goodHeader(); x[i] = v; return x; };
  std::vector<uint8_t> x = mod(0, 0x7F);
  TEST_ASSERT_EQUAL(ImageCheck::BadMagic, checkImageHeader(x.data(), x.size(), 2));   // ví dụ HTML 404 tải nhầm
  x = mod(1, 0);
  TEST_ASSERT_EQUAL(ImageCheck::BadSegments, checkImageHeader(x.data(), x.size(), 2));
  x = mod(1, 17);
  TEST_ASSERT_EQUAL(ImageCheck::BadSegments, checkImageHeader(x.data(), x.size(), 2));
  x = mod(12, 0x00);   // chip_id = 0 (ESP32)
  TEST_ASSERT_EQUAL(ImageCheck::WrongChip, checkImageHeader(x.data(), x.size(), 2));
  x = mod(12, 0x09);   // ESP32-S3
  TEST_ASSERT_EQUAL(ImageCheck::WrongChip, checkImageHeader(x.data(), x.size(), 2));
  x = mod(3, 0x3F);    // 8 MB trên chip 4 MB
  TEST_ASSERT_EQUAL(ImageCheck::FlashTooBig, checkImageHeader(x.data(), x.size(), 2));
  x = mod(3, 0x1F);    // 2 MB trên chip 4 MB: chạy được
  TEST_ASSERT_EQUAL(ImageCheck::Ok, checkImageHeader(x.data(), x.size(), 2));
  x = mod(35, 0x00);
  TEST_ASSERT_EQUAL(ImageCheck::NoAppDesc, checkImageHeader(x.data(), x.size(), 2));
  for (int c = 0; c <= static_cast<int>(ImageCheck::NoAppDesc); c++) TEST_ASSERT_TRUE(strlen(imageCheckText(static_cast<ImageCheck>(c))) > 0);
}

// ── Sổ cài ─────────────────────────────────────────────────────────────────

namespace {
struct MemOtaStore : IOtaStore {
  bool has = false;
  OtaRecord rec;
  int saves = 0;
  bool failSave = false;
  bool load(OtaRecord& r) override { if (!has) return false; r = rec; return true; }
  bool save(const OtaRecord& r) override { if (failSave) return false; rec = r; has = true; ++saves; return true; }
};
}  // namespace

static void test_ota_record_codec_detects_corruption() {
  OtaRecord r;
  strcpy(r.version, "1.2.3-rc1");
  r.installs = 2; r.unconfirmedBoots = 3; r.pending = true;
  uint8_t buf[kOtaRecordEncodedLen];
  TEST_ASSERT_EQUAL_UINT(kOtaRecordEncodedLen, encodeOtaRecord(r, buf, sizeof buf));
  OtaRecord out;
  TEST_ASSERT_TRUE(decodeOtaRecord(buf, sizeof buf, out));
  TEST_ASSERT_EQUAL_STRING("1.2.3-rc1", out.version);
  TEST_ASSERT_EQUAL_UINT8(2, out.installs);
  TEST_ASSERT_EQUAL_UINT8(3, out.unconfirmedBoots);
  TEST_ASSERT_TRUE(out.pending);
  for (size_t i = 0; i < sizeof buf; i++) {
    uint8_t bad[kOtaRecordEncodedLen];
    memcpy(bad, buf, sizeof bad);
    bad[i] = static_cast<uint8_t>(bad[i] ^ 0x10);
    TEST_ASSERT_FALSE(decodeOtaRecord(bad, sizeof bad, out));
  }
  TEST_ASSERT_FALSE(decodeOtaRecord(buf, sizeof buf - 1, out));
  TEST_ASSERT_EQUAL_UINT(0, encodeOtaRecord(r, buf, 10));
}

static void test_ota_loop_protection_stops_after_three_installs() {
  MemOtaStore st;
  OtaLedger l(st);
  l.load();
  TEST_ASSERT_TRUE(l.mayInstall("1.0.1"));
  // Server cứ đề nghị 1.0.1; bản này khởi động rồi bị rollback mỗi lần (crash/không liên lạc được server)
  for (int i = 0; i < 3; i++) {
    TEST_ASSERT_TRUE(l.mayInstall("1.0.1"));
    TEST_ASSERT_TRUE(l.beforeInstall("1.0.1"));
    // ... khởi động lại thành bản cũ 1.0.0 (rollback): thấy cờ chờ xác nhận nhưng đang chạy 1.0.0
    OtaLedger oldFw(st);
    oldFw.load();
    TEST_ASSERT_TRUE(oldFw.onBoot("1.0.0") == OtaLedger::BootVerdict::Normal);
    l.load();
    TEST_ASSERT_FALSE(l.record().pending);
  }
  TEST_ASSERT_FALSE(l.mayInstall("1.0.1"));   // đủ 3 lần: ngừng, không cài lại mỗi lần khởi động (mòn flash!)
  TEST_ASSERT_TRUE(l.mayInstall("1.0.2"));    // bản KHÁC thì thử được
  TEST_ASSERT_TRUE(l.beforeInstall("1.0.2"));
}

static void test_ota_confirmation_resets_and_new_fw_boots_counted() {
  MemOtaStore st;
  OtaLedger l(st);
  l.load();
  TEST_ASSERT_TRUE(l.beforeInstall("1.0.1"));
  // Bản mới (1.0.1) khởi động: 3 lần đầu Normal (bản mới có thể sống được nếu liên lạc kịp), lần 4 thì rollback mềm
  OtaLedger fw(st);
  fw.load();
  TEST_ASSERT_TRUE(fw.onBoot("1.0.1") == OtaLedger::BootVerdict::Normal);
  fw.load();
  TEST_ASSERT_TRUE(fw.onBoot("1.0.1") == OtaLedger::BootVerdict::Normal);
  fw.load();
  TEST_ASSERT_TRUE(fw.onBoot("1.0.1") == OtaLedger::BootVerdict::Normal);
  fw.load();
  TEST_ASSERT_TRUE(fw.onBoot("1.0.1") == OtaLedger::BootVerdict::Rollback);
  // Ngược lại: nếu xác nhận được thì mọi thứ về sạch
  MemOtaStore st2;
  OtaLedger ok(st2);
  ok.load();
  TEST_ASSERT_TRUE(ok.beforeInstall("2.0.0"));
  ok.onBoot("2.0.0");
  ok.onConfirmed();
  TEST_ASSERT_FALSE(ok.record().pending);
  TEST_ASSERT_EQUAL_UINT8(0, ok.record().installs);
  const int writes = st2.saves;
  ok.onConfirmed();                     // gọi lại: không ghi flash thừa
  TEST_ASSERT_EQUAL_INT(writes, st2.saves);
  OtaLedger normal(st2);
  normal.load();
  TEST_ASSERT_TRUE(normal.onBoot("2.0.0") == OtaLedger::BootVerdict::Normal);
}

static void test_ota_refuses_when_ledger_cannot_be_written() {
  MemOtaStore st;
  st.failSave = true;
  OtaLedger l(st);
  l.load();
  TEST_ASSERT_FALSE(l.beforeInstall("1.0.1"));   // không ghi sổ được -> không được cài (không chặn nổi vòng lặp)
  TEST_ASSERT_FALSE(l.beforeInstall(""));
  TEST_ASSERT_FALSE(l.beforeInstall(std::string(40, '1')));
}

static void test_ota_ledger_corrupt_store_is_treated_as_empty() {
  MemOtaStore st;   // load() trả false (bản ghi hỏng/không có)
  OtaLedger l(st);
  l.load();
  TEST_ASSERT_TRUE(l.mayInstall("1.0.1"));
  TEST_ASSERT_TRUE(l.onBoot("1.0.0") == OtaLedger::BootVerdict::Normal);
  TEST_ASSERT_EQUAL_INT(0, st.saves);            // không ghi flash khi bình thường
}

// ── Cửa ngõ và rollback ────────────────────────────────────────────────────

static OtaGateInputs idleInputs() {
  OtaGateInputs g;
  g.bufferCount = 0; g.breachActive = false; g.lastUploadOk = true; g.uptimeS = 600; g.portalActive = false;
  g.freeHeap = 120 * 1024; g.maxBlock = 80 * 1024;
  return g;
}

static void test_ota_gate_defers_for_unsent_data_and_breach() {
  OtaGateInputs g = idleInputs();
  TEST_ASSERT_EQUAL(OtaDeferral::None, otaGate(g));
  g.bufferCount = 1;
  TEST_ASSERT_EQUAL(OtaDeferral::UnsentData, otaGate(g));   // gửi số đo trước, cài sau
  g = idleInputs(); g.breachActive = true;
  TEST_ASSERT_EQUAL(OtaDeferral::Breach, otaGate(g));       // đang vượt ngưỡng: ưu tiên cảnh báo
  g = idleInputs(); g.lastUploadOk = false;
  TEST_ASSERT_EQUAL(OtaDeferral::UploadFailing, otaGate(g));
  g = idleInputs(); g.uptimeS = 30;
  TEST_ASSERT_EQUAL(OtaDeferral::TooEarly, otaGate(g));
  g = idleInputs(); g.portalActive = true;
  TEST_ASSERT_EQUAL(OtaDeferral::PortalOpen, otaGate(g));
  g = idleInputs(); g.freeHeap = 50 * 1024;
  TEST_ASSERT_EQUAL(OtaDeferral::LowHeap, otaGate(g));
  g = idleInputs(); g.maxBlock = 10 * 1024;                 // đủ tổng nhưng phân mảnh
  TEST_ASSERT_EQUAL(OtaDeferral::LowHeap, otaGate(g));
  for (int d = 0; d <= static_cast<int>(OtaDeferral::LowHeap); d++) TEST_ASSERT_TRUE(strlen(otaDeferralText(static_cast<OtaDeferral>(d))) > 0);
}

static void test_soft_rollback_timing() {
  TEST_ASSERT_FALSE(shouldRollbackUnconfirmed(false, 999999, 999999));    // không chờ xác nhận: không bao giờ
  TEST_ASSERT_FALSE(shouldRollbackUnconfirmed(true, 600, 0));             // vừa khởi động, Wi-Fi chưa nối
  TEST_ASSERT_FALSE(shouldRollbackUnconfirmed(true, 3000, 0));            // router chưa lên 50 phút: chưa kết luận bản mới lỗi
  TEST_ASSERT_FALSE(shouldRollbackUnconfirmed(true, 1000, 899));
  TEST_ASSERT_TRUE(shouldRollbackUnconfirmed(true, 1000, 900));           // Wi-Fi nối 15 phút mà không liên lạc được server
  TEST_ASSERT_TRUE(shouldRollbackUnconfirmed(true, 3600, 0));             // trần cứng 60 phút
}

// ── Bảo trì ────────────────────────────────────────────────────────────────

static MaintenanceInputs healthy() {
  MaintenanceInputs m;
  m.uptimeS = 3600; m.bufferCount = 0; m.lastUploadOk = true; m.sinceContactS = 100; m.wifiUp = true;
  return m;
}

static void test_reboot_policy() {
  MaintenanceInputs m = healthy();
  TEST_ASSERT_EQUAL(RebootReason::None, decideReboot(m));
  m.uptimeS = kPlannedRebootAfterS;
  TEST_ASSERT_EQUAL(RebootReason::Planned, decideReboot(m));                 // 7 ngày và rảnh
  m.bufferCount = 3;                                                          // còn tồn: không khởi động lại (mất số đo)
  TEST_ASSERT_EQUAL(RebootReason::None, decideReboot(m));
  m = healthy(); m.uptimeS = kPlannedRebootAfterS; m.breachActive = true;     // đang vượt ngưỡng: đừng cắt ngang
  TEST_ASSERT_EQUAL(RebootReason::None, decideReboot(m));
  m = healthy(); m.uptimeS = kPlannedRebootAfterS; m.lastUploadOk = false;
  TEST_ASSERT_EQUAL(RebootReason::None, decideReboot(m));
  m = healthy(); m.uptimeS = kForcedRebootAfterS; m.bufferCount = 500; m.lastUploadOk = false;
  TEST_ASSERT_EQUAL(RebootReason::Planned, decideReboot(m));                 // 14 ngày: bất kể tồn đọng
  m.breachActive = true;
  TEST_ASSERT_EQUAL(RebootReason::None, decideReboot(m));                    // ...trừ khi đang có báo động
  m = healthy(); m.uptimeS = kForcedRebootAfterS; m.portalActive = true;
  TEST_ASSERT_EQUAL(RebootReason::None, decideReboot(m));                    // đang cấu hình
  m = healthy(); m.uptimeS = kForcedRebootAfterS; m.otaBusy = true;
  TEST_ASSERT_EQUAL(RebootReason::None, decideReboot(m));
  // Số học 32 bit: 14 ngày (1,2 triệu giây) rất xa mốc tràn millis() 49,7 ngày / int32 24,8 ngày
  TEST_ASSERT_TRUE(kForcedRebootAfterS * 1000ull < 0x7FFFFFFFull);
}

static void test_reboot_for_low_heap_and_no_contact_with_reason() {
  MaintenanceInputs m = healthy();
  m.lowHeapStrikes = kMaxLowHeapStrikes - 1;
  TEST_ASSERT_EQUAL(RebootReason::None, decideReboot(m));
  m.lowHeapStrikes = kMaxLowHeapStrikes;
  TEST_ASSERT_EQUAL(RebootReason::LowHeap, decideReboot(m));
  m = healthy(); m.sinceContactS = kNoContactRebootS - 1;
  TEST_ASSERT_EQUAL(RebootReason::None, decideReboot(m));
  m.sinceContactS = kNoContactRebootS;
  TEST_ASSERT_EQUAL(RebootReason::NoContact, decideReboot(m));
  m.wifiUp = false;                                                            // Wi-Fi mất (cúp điện router): KHÔNG khởi động lại
  TEST_ASSERT_EQUAL(RebootReason::None, decideReboot(m));
  m = healthy(); m.sinceContactS = kNoContactRebootS; m.otaBusy = true;
  TEST_ASSERT_EQUAL(RebootReason::None, decideReboot(m));
  for (int r = 0; r <= static_cast<int>(RebootReason::PortalFault); r++) TEST_ASSERT_TRUE(strlen(rebootReasonText(static_cast<RebootReason>(r))) > 0);
}

static void test_heap_guards() {
  TEST_ASSERT_TRUE(tlsHeapOk(100 * 1024, 60 * 1024));
  TEST_ASSERT_FALSE(tlsHeapOk(55 * 1024, 60 * 1024));    // tổng thấp
  TEST_ASSERT_FALSE(tlsHeapOk(100 * 1024, 19 * 1024));   // phân mảnh: không có khối liền đủ lớn dù tổng đủ
  TEST_ASSERT_TRUE(heapCritical(39 * 1024, 60 * 1024));
  TEST_ASSERT_TRUE(heapCritical(100 * 1024, 10 * 1024));
  TEST_ASSERT_FALSE(heapCritical(60 * 1024, 30 * 1024));
  // Vùng đệm giữa "không đủ mở TLS" và "nguy kịch" để không khởi động lại vì dao động nhỏ
  TEST_ASSERT_FALSE(tlsHeapOk(50 * 1024, 30 * 1024));
  TEST_ASSERT_FALSE(heapCritical(50 * 1024, 30 * 1024));
}

static void test_recovery_escalation() {
  uint8_t stage = 0;
  TEST_ASSERT_EQUAL(RecoveryStep::None, nextRecoveryStep(kCycleWifiAfterS - 1, stage));
  TEST_ASSERT_EQUAL(RecoveryStep::CycleWifi, nextRecoveryStep(kCycleWifiAfterS, stage));
  TEST_ASSERT_EQUAL(RecoveryStep::None, nextRecoveryStep(kCycleWifiAfterS + 60, stage));    // không lặp lại bước đã làm
  TEST_ASSERT_EQUAL(RecoveryStep::RestartWifiDriver, nextRecoveryStep(kRestartWifiAfterS, stage));
  TEST_ASSERT_EQUAL(RecoveryStep::None, nextRecoveryStep(kRestartWifiAfterS * 5, stage));
  stage = 0;                                                                                  // liên lạc lại được -> reset
  TEST_ASSERT_EQUAL(RecoveryStep::CycleWifi, nextRecoveryStep(kRestartWifiAfterS, stage));    // trễ bước vẫn theo thứ tự
}

static void test_tls_rescue_only_after_persistent_cert_failures() {
  TlsRescue r;
  for (int i = 0; i < 11; i++) r.onAttempt(false, true, false);
  TEST_ASSERT_FALSE(r.rescueAllowed());
  r.onAttempt(false, true, false);
  TEST_ASSERT_TRUE(r.rescueAllowed());   // 12 lần liên tiếp bị từ chối vì chứng chỉ
  // Lỗi mạng thường (timeout, DNS) không cộng dồn và không xóa
  TlsRescue n;
  for (int i = 0; i < 100; i++) n.onAttempt(false, false, false);
  TEST_ASSERT_FALSE(n.rescueAllowed());
  // Một lần TLS chạy được (có mã HTTP) hoặc thành công thì hết nghi ngờ
  r.onAttempt(false, false, true);
  TEST_ASSERT_FALSE(r.rescueAllowed());
  TlsRescue s;
  for (int i = 0; i < 20; i++) s.onAttempt(false, true, false);
  s.onAttempt(true, false, true);
  TEST_ASSERT_FALSE(s.rescueAllowed());
}

void run_ota_tests() {
  RUN_TEST(test_version_compare_table);
  RUN_TEST(test_tag_scanner_finds_tag_regardless_of_chunking);
  RUN_TEST(test_tag_scanner_ignores_the_probe_constant_and_garbage);
  RUN_TEST(test_tag_scanner_detects_conflicting_tags);
  RUN_TEST(test_image_header_checks);
  RUN_TEST(test_ota_record_codec_detects_corruption);
  RUN_TEST(test_ota_loop_protection_stops_after_three_installs);
  RUN_TEST(test_ota_confirmation_resets_and_new_fw_boots_counted);
  RUN_TEST(test_ota_refuses_when_ledger_cannot_be_written);
  RUN_TEST(test_ota_ledger_corrupt_store_is_treated_as_empty);
  RUN_TEST(test_ota_gate_defers_for_unsent_data_and_breach);
  RUN_TEST(test_soft_rollback_timing);
  RUN_TEST(test_reboot_policy);
  RUN_TEST(test_reboot_for_low_heap_and_no_contact_with_reason);
  RUN_TEST(test_heap_guards);
  RUN_TEST(test_recovery_escalation);
  RUN_TEST(test_tls_rescue_only_after_persistent_cert_failures);
}
