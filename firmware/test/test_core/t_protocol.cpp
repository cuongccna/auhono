// Vector giao thức từ docs/PROTOCOL.md (đã đối chiếu với server bằng openssl) và các vector chuẩn
// của SHA-256 / HMAC để chắc chắn bộ mật mã dùng trong test đúng.
#include <unity.h>

#include <cstring>
#include <string>

#include "auhono/hex.h"
#include "auhono/signer.h"
#include "soft_crypto.h"

using namespace auhono;

static const char* kKeyHex = "41bc43e33ceb8fd260f6888bcf8b89858310b99545a24ac3a6a76bb1b7b8a507";
static const char* kBody = "{\"readings\":[{\"t\":1800000000,\"c\":-19.5}]}";
static const char* kBodyHash = "76d37a0d15295407d0cf6b872b02a1a239a43d23d8ce8bcfd65be46622156899";
static const char* kCanonical =
    "POST\n/v1/readings\nAUH-000001\n1800000000\n7\n"
    "76d37a0d15295407d0cf6b872b02a1a239a43d23d8ce8bcfd65be46622156899";
static const char* kSignature = "8c2bca443f59548fb5ac50fa912d6e58bff435fdc5a563b46767e6699fcdb12a";

static std::string sha256Hex(const std::string& s) {
  uint8_t h[32];
  softcrypto::sha256(reinterpret_cast<const uint8_t*>(s.data()), s.size(), h);
  return toHex(h, 32);
}

static void test_sha256_standard_vectors() {
  TEST_ASSERT_EQUAL_STRING("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", sha256Hex("").c_str());
  TEST_ASSERT_EQUAL_STRING("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", sha256Hex("abc").c_str());
  // Hai khối: kiểm tra phần đệm và độ dài
  TEST_ASSERT_EQUAL_STRING("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
                           sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq").c_str());
}

static void test_hmac_rfc4231_case2() {
  const std::string key = "Jefe", msg = "what do ya want for nothing?";
  uint8_t mac[32];
  softcrypto::hmacSha256(reinterpret_cast<const uint8_t*>(key.data()), key.size(),
                         reinterpret_cast<const uint8_t*>(msg.data()), msg.size(), mac);
  TEST_ASSERT_EQUAL_STRING("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843", toHex(mac, 32).c_str());
}

static void test_body_hash_matches_protocol() {
  TEST_ASSERT_EQUAL_STRING(kBodyHash, sha256Hex(kBody).c_str());
}

static void test_canonical_matches_protocol() {
  const std::string c = buildCanonical("POST", "/v1/readings", "AUH-000001", 1800000000ULL, 7, kBodyHash);
  TEST_ASSERT_EQUAL_STRING(kCanonical, c.c_str());
  TEST_ASSERT_EQUAL_UINT(strlen(kCanonical), c.size());
  TEST_ASSERT_TRUE(c.back() != '\n');  // không có ký tự thừa ở cuối
}

static void test_signature_matches_protocol_vector() {
  uint8_t key[32];
  size_t n = 0;
  TEST_ASSERT_TRUE(fromHex(kKeyHex, 64, key, sizeof key, &n));
  TEST_ASSERT_EQUAL_UINT(32, n);

  SoftCrypto crypto;
  Signer signer(crypto, "AUH-000001", key);
  const SignedHeaders h = signer.sign("POST", "/v1/readings", 1800000000ULL, 7,
                                      reinterpret_cast<const uint8_t*>(kBody), strlen(kBody));
  TEST_ASSERT_EQUAL_STRING("AUH-000001", h.deviceId.c_str());
  TEST_ASSERT_EQUAL_STRING("1800000000", h.timestamp.c_str());
  TEST_ASSERT_EQUAL_STRING("7", h.seq.c_str());
  TEST_ASSERT_EQUAL_STRING(kSignature, h.signature.c_str());
  TEST_ASSERT_EQUAL_UINT(64, h.signature.size());
}

static void test_get_with_empty_body_hashes_empty_string() {
  uint8_t key[32];
  fromHex(kKeyHex, 64, key, sizeof key, nullptr);
  SoftCrypto crypto;
  Signer signer(crypto, "AUH-000001", key);
  // Query KHÔNG nằm trong chữ ký: hai đường dẫn khác query phải cho cùng chữ ký.
  const SignedHeaders a = signer.sign("GET", "/v1/ota/check?current=1.0.0", 100, 1, nullptr, 0);
  const SignedHeaders b = signer.sign("GET", "/v1/ota/check", 100, 1, nullptr, 0);
  TEST_ASSERT_EQUAL_STRING(b.signature.c_str(), a.signature.c_str());

  // Kiểm lại bằng cách dựng canonical thủ công với băm chuỗi rỗng.
  const std::string canon = buildCanonical("GET", "/v1/ota/check", "AUH-000001", 100, 1,
                                           "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  uint8_t mac[32];
  softcrypto::hmacSha256(key, 32, reinterpret_cast<const uint8_t*>(canon.data()), canon.size(), mac);
  TEST_ASSERT_EQUAL_STRING(toHex(mac, 32).c_str(), a.signature.c_str());
}

static void test_method_is_uppercased_and_fields_change_signature() {
  uint8_t key[32];
  fromHex(kKeyHex, 64, key, sizeof key, nullptr);
  SoftCrypto crypto;
  Signer signer(crypto, "AUH-000001", key);
  const auto base = signer.sign("POST", "/v1/readings", 1, 1, nullptr, 0).signature;
  TEST_ASSERT_EQUAL_STRING(base.c_str(), signer.sign("post", "/v1/readings", 1, 1, nullptr, 0).signature.c_str());
  TEST_ASSERT_FALSE(base == signer.sign("POST", "/v1/readings", 2, 1, nullptr, 0).signature);   // timestamp
  TEST_ASSERT_FALSE(base == signer.sign("POST", "/v1/readings", 1, 2, nullptr, 0).signature);   // seq
  TEST_ASSERT_FALSE(base == signer.sign("POST", "/v1/time", 1, 1, nullptr, 0).signature);       // path
  const uint8_t b = 'x';
  TEST_ASSERT_FALSE(base == signer.sign("POST", "/v1/readings", 1, 1, &b, 1).signature);        // body
}

static void test_hex_roundtrip_and_strictness() {
  const uint8_t d[] = {0x00, 0x0a, 0xff, 0x7f};
  TEST_ASSERT_EQUAL_STRING("000aff7f", toHex(d, 4).c_str());
  uint8_t out[4];
  size_t n = 0;
  TEST_ASSERT_TRUE(fromHex("000AFF7f", 8, out, 4, &n));
  TEST_ASSERT_EQUAL_UINT8_ARRAY(d, out, 4);
  TEST_ASSERT_FALSE(fromHex("abc", 3, out, 4, &n));       // lẻ
  TEST_ASSERT_FALSE(fromHex("zz", 2, out, 4, &n));        // ký tự sai
  TEST_ASSERT_FALSE(fromHex("0011223344", 10, out, 4, &n));  // vượt bộ đệm
  TEST_ASSERT_TRUE(constTimeEqual(d, d, 4));
  uint8_t e[] = {0x00, 0x0a, 0xff, 0x7e};
  TEST_ASSERT_FALSE(constTimeEqual(d, e, 4));
}

void run_protocol_tests() {
  RUN_TEST(test_sha256_standard_vectors);
  RUN_TEST(test_hmac_rfc4231_case2);
  RUN_TEST(test_body_hash_matches_protocol);
  RUN_TEST(test_canonical_matches_protocol);
  RUN_TEST(test_signature_matches_protocol_vector);
  RUN_TEST(test_get_with_empty_body_hashes_empty_string);
  RUN_TEST(test_method_is_uppercased_and_fields_change_signature);
  RUN_TEST(test_hex_roundtrip_and_strictness);
}
