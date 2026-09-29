// Bộ phân tích HTTP có giới hạn, form urlencoded, DNS bắt mọi tên: hành vi đúng + kẻ xấu + fuzz (chạy dưới ASan/UBSan).
#include <unity.h>

#include <cstdlib>
#include <cstring>
#include <random>
#include <string>
#include <vector>

#include "auhono/dns_reply.h"
#include "auhono/http_request.h"
#include "auhono/portal_form.h"
#include "auhono/url_form.h"

using namespace auhono;

static HttpRequestParser::State feedStr(HttpRequestParser& p, const std::string& s) {
  return p.feed(reinterpret_cast<const uint8_t*>(s.data()), s.size());
}

// ── HTTP request ───────────────────────────────────────────────────────────

static void test_http_get_probe() {
  HttpRequestParser p;
  TEST_ASSERT_EQUAL(HttpRequestParser::State::Done,
                    feedStr(p, "GET /generate_204 HTTP/1.1\r\nHost: connectivitycheck.gstatic.com\r\nUser-Agent: x\r\n\r\n"));
  TEST_ASSERT_TRUE(p.method() == HttpMethod::Get);
  TEST_ASSERT_EQUAL_STRING("/generate_204", p.path().c_str());
  TEST_ASSERT_EQUAL_STRING("connectivitycheck.gstatic.com", p.host().c_str());
  TEST_ASSERT_EQUAL_UINT(0, p.contentLength());
}

static void test_http_post_body_byte_by_byte() {
  const std::string body = "t=abcd&pick=&ssid=Qu%C3%A1n+A&pass=12345678";
  const std::string req = "POST /save HTTP/1.1\r\nHost: 192.168.4.1\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: " +
                          std::to_string(body.size()) + "\r\n\r\n" + body;
  HttpRequestParser p;
  HttpRequestParser::State st = HttpRequestParser::State::NeedMore;
  for (size_t i = 0; i < req.size(); i++) {  // mỗi lần MỘT byte (TCP có thể cắt bất kỳ chỗ nào)
    TEST_ASSERT_EQUAL(HttpRequestParser::State::NeedMore, st);
    st = p.feed(reinterpret_cast<const uint8_t*>(&req[i]), 1);
  }
  TEST_ASSERT_EQUAL(HttpRequestParser::State::Done, st);
  TEST_ASSERT_TRUE(p.method() == HttpMethod::Post);
  TEST_ASSERT_TRUE(p.body() == body);
}

static void test_http_variants_accepted() {
  HttpRequestParser a;   // LF trần, dòng trống đầu, HTTP/1.0, header viết hoa/thường lẫn lộn
  TEST_ASSERT_EQUAL(HttpRequestParser::State::Done, feedStr(a, "\r\nGET / HTTP/1.0\nhOsT:   192.168.4.1  \n\n"));
  TEST_ASSERT_EQUAL_STRING("192.168.4.1", a.host().c_str());
  HttpRequestParser b;   // URL tuyệt đối (proxy-style)
  TEST_ASSERT_EQUAL(HttpRequestParser::State::Done, feedStr(b, "GET http://captive.apple.com/hotspot-detect.html?x=1 HTTP/1.1\r\n\r\n"));
  TEST_ASSERT_EQUAL_STRING("/hotspot-detect.html", b.path().c_str());
  TEST_ASSERT_EQUAL_STRING("x=1", b.query().c_str());
  TEST_ASSERT_EQUAL_STRING("captive.apple.com", b.host().c_str());
  HttpRequestParser c;   // CONNECT: phương thức lạ được nhận (route sẽ chuyển hướng/từ chối)
  TEST_ASSERT_EQUAL(HttpRequestParser::State::Done, feedStr(c, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n"));
  TEST_ASSERT_TRUE(c.method() == HttpMethod::Other);
}

static void test_http_limits_are_enforced() {
  {  // dòng đầu quá dài, không bao giờ cấp phát theo số client gửi
    HttpRequestParser p;
    const std::string huge = "GET /" + std::string(1000000, 'a');
    feedStr(p, huge);
    TEST_ASSERT_EQUAL(HttpRequestParser::State::Error, p.state());
    TEST_ASSERT_TRUE(p.error() == HttpError::RequestLineTooLong);
    TEST_ASSERT_EQUAL_INT(414, httpStatusFor(p.error()));
  }
  {  // một header quá dài
    HttpRequestParser p;
    feedStr(p, "GET / HTTP/1.1\r\nX-A: " + std::string(5000, 'a'));
    TEST_ASSERT_TRUE(p.error() == HttpError::HeadersTooLarge);
    TEST_ASSERT_EQUAL_INT(431, httpStatusFor(p.error()));
  }
  {  // quá nhiều header nhỏ
    HttpRequestParser p;
    std::string s = "GET / HTTP/1.1\r\n";
    for (int i = 0; i < 40; i++) s += "A: b\r\n";
    feedStr(p, s);
    TEST_ASSERT_TRUE(p.error() == HttpError::HeadersTooLarge);
  }
  {  // Content-Length khổng lồ: từ chối NGAY, không đọc/cấp phát gì
    HttpRequestParser p;
    feedStr(p, "POST /save HTTP/1.1\r\nContent-Length: 2000000000\r\n\r\n");
    TEST_ASSERT_TRUE(p.error() == HttpError::BodyTooLarge);
    TEST_ASSERT_EQUAL_INT(413, httpStatusFor(p.error()));
  }
  {  // đúng biên body
    HttpRequestParser p;
    feedStr(p, "POST /save HTTP/1.1\r\nContent-Length: 1024\r\n\r\n" + std::string(1024, 'x'));
    TEST_ASSERT_EQUAL(HttpRequestParser::State::Done, p.state());
    HttpRequestParser q;
    feedStr(q, "POST /save HTTP/1.1\r\nContent-Length: 1025\r\n\r\n");
    TEST_ASSERT_TRUE(q.error() == HttpError::BodyTooLarge);
  }
}

static void test_http_malformed_requests() {
  const char* bad[] = {
      "GET\r\n\r\n",                               // thiếu phần
      "GET / HTTP/2.0\r\n\r\n",                    // phiên bản lạ
      "GET / HTTP/1.1 extra\r\n\r\n",              // thừa
      "GET /a b HTTP/1.1\r\n\r\n",                 // khoảng trắng trong URL
      "GET / HTTP/1.1\r\n folded: x\r\n\r\n",      // obs-fold
      "GET / HTTP/1.1\r\nNoColon\r\n\r\n",
      "GET / HTTP/1.1\r\n: x\r\n\r\n",
      "POST /save HTTP/1.1\r\nContent-Length: -5\r\n\r\n",
      "POST /save HTTP/1.1\r\nContent-Length: +5\r\n\r\n",
      "POST /save HTTP/1.1\r\nContent-Length: 0x10\r\n\r\n",
      "POST /save HTTP/1.1\r\nContent-Length: 5 5\r\n\r\n",
      "POST /save HTTP/1.1\r\nContent-Length:\r\n\r\n",
      "POST /save HTTP/1.1\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\n",   // buôn lậu request
      "GET / HTTP/1.1\r\nHost: a\x01\r\n\r\n",
  };
  for (const char* s : bad) {
    HttpRequestParser p;
    feedStr(p, s);
    TEST_ASSERT_EQUAL_MESSAGE(static_cast<int>(HttpRequestParser::State::Error), static_cast<int>(p.state()), s);
  }
  HttpRequestParser nul;
  const std::string withNul("GET /\0x HTTP/1.1\r\n\r\n", 20);
  feedStr(nul, withNul);
  TEST_ASSERT_EQUAL(HttpRequestParser::State::Error, nul.state());
  HttpRequestParser chunked;
  feedStr(chunked, "POST /save HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n");
  TEST_ASSERT_TRUE(chunked.error() == HttpError::Unsupported);
  // Hai Content-Length giống nhau là được
  HttpRequestParser same;
  feedStr(same, "POST /save HTTP/1.1\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\nab");
  TEST_ASSERT_EQUAL(HttpRequestParser::State::Done, same.state());
}

static void test_http_after_done_or_error_extra_bytes_ignored() {
  HttpRequestParser p;
  feedStr(p, "GET / HTTP/1.1\r\n\r\n");
  const std::string path = p.path();
  feedStr(p, "GET /other HTTP/1.1\r\n\r\n");     // pipelining: bỏ qua
  TEST_ASSERT_TRUE(p.path() == path);
  HttpRequestParser e;
  feedStr(e, "BAD\r\n");
  TEST_ASSERT_EQUAL(HttpRequestParser::State::Error, e.state());
  TEST_ASSERT_EQUAL(HttpRequestParser::State::Error, feedStr(e, "GET / HTTP/1.1\r\n\r\n"));
  p.reset();
  TEST_ASSERT_EQUAL(HttpRequestParser::State::NeedMore, p.state());
}

static void test_http_fuzz_random_and_mutated() {
  std::mt19937 rng(12345);
  const std::string seedReq = "POST /save HTTP/1.1\r\nHost: 192.168.4.1\r\nContent-Length: 20\r\n\r\nssid=abc&pass=defghij";
  for (int iter = 0; iter < 30000; iter++) {
    std::string s;
    if (iter % 2 == 0) {
      const size_t n = rng() % 300;
      for (size_t i = 0; i < n; i++) s.push_back(static_cast<char>(rng()));
    } else {
      s = seedReq;
      const int muts = 1 + static_cast<int>(rng() % 6);
      for (int m = 0; m < muts; m++) {
        const size_t pos = rng() % s.size();
        switch (rng() % 3) {
          case 0: s[pos] = static_cast<char>(rng()); break;
          case 1: s.erase(pos, 1 + rng() % 4); break;
          default: s.insert(pos, std::string(1 + rng() % 3, static_cast<char>(rng()))); break;
        }
        if (s.empty()) s = "x";
      }
    }
    HttpRequestParser p;
    // đưa vào theo các mảnh ngẫu nhiên
    size_t off = 0;
    while (off < s.size()) {
      const size_t chunk = 1 + rng() % 17;
      const size_t n = chunk < s.size() - off ? chunk : s.size() - off;
      p.feed(reinterpret_cast<const uint8_t*>(s.data() + off), n);
      off += n;
    }
    // Bất biến: chưa bao giờ giữ nhiều hơn giới hạn
    TEST_ASSERT_TRUE(p.body().size() <= HttpLimits().maxBody);
    TEST_ASSERT_TRUE(p.path().size() <= HttpLimits().maxRequestLine);
  }
}

// ── Form ───────────────────────────────────────────────────────────────────

static void test_form_parsing_vietnamese_and_specials() {
  std::vector<FormField> f;
  // ssid = "Quán Cà Phê" (UTF-8 %-mã hóa), pass có ký tự đặc biệt, '+' là khoảng trắng
  TEST_ASSERT_TRUE(parseUrlEncoded("t=ab&pick=&ssid=Qu%C3%A1n+C%C3%A0+Ph%C3%AA&pass=p%40ss%26w%3Dord%2B1", f));
  TEST_ASSERT_EQUAL_STRING("Quán Cà Phê", formValue(f, "ssid").c_str());
  TEST_ASSERT_EQUAL_STRING("p@ss&w=ord+1", formValue(f, "pass").c_str());
  TEST_ASSERT_EQUAL_STRING("ab", formValue(f, "t").c_str());
  TEST_ASSERT_EQUAL_STRING("", formValue(f, "pick").c_str());
  TEST_ASSERT_EQUAL_STRING("", formValue(f, "missing").c_str());
  // Trường lặp lại: lấy trường đầu; cặp rỗng bỏ qua; không dấu '='
  TEST_ASSERT_TRUE(parseUrlEncoded("&&a=1&a=2&flag&", f));
  TEST_ASSERT_EQUAL_STRING("1", formValue(f, "a").c_str());
  TEST_ASSERT_EQUAL_UINT(3, f.size());
  TEST_ASSERT_TRUE(parseUrlEncoded("", f));
  TEST_ASSERT_EQUAL_UINT(0, f.size());
}

static void test_form_rejects_malformed() {
  std::vector<FormField> f;
  TEST_ASSERT_FALSE(parseUrlEncoded("a=%", f));
  TEST_ASSERT_FALSE(parseUrlEncoded("a=%4", f));
  TEST_ASSERT_FALSE(parseUrlEncoded("a=%ZZ", f));
  TEST_ASSERT_FALSE(parseUrlEncoded("a=%00", f));                 // NUL
  TEST_ASSERT_FALSE(parseUrlEncoded("a=" + std::string(257, 'x'), f));    // giá trị quá dài
  TEST_ASSERT_FALSE(parseUrlEncoded(std::string(33, 'n') + "=1", f));     // tên quá dài
  std::string many;
  for (int i = 0; i < 9; i++) many += "k" + std::to_string(i) + "=v&";
  TEST_ASSERT_FALSE(parseUrlEncoded(many, f));                    // quá nhiều trường
  std::string out;
  TEST_ASSERT_TRUE(urlDecode("%e1%ba%a1", out));                  // chữ thường cũng được
  TEST_ASSERT_EQUAL_STRING("\xE1\xBA\xA1", out.c_str());
}

static void test_form_to_wifi_creds_end_to_end() {
  // Toàn bộ đường đi: byte HTTP -> form -> SSID/mật khẩu hợp lệ (kể cả SSID tiếng Việt và ô chọn bằng token)
  const std::string tok = ssidToken("Tiệm Hải Sản");
  const std::string body = "t=x&pick=" + tok + "&ssid=&pass=matkhau99";
  std::vector<FormField> f;
  TEST_ASSERT_TRUE(parseUrlEncoded(body, f));
  std::string ssid;
  TEST_ASSERT_TRUE(resolveSsid(formValue(f, "ssid"), formValue(f, "pick"), ssid));
  TEST_ASSERT_EQUAL_STRING("Tiệm Hải Sản", ssid.c_str());
  TEST_ASSERT_EQUAL(FormError::None, validateSsid(ssid));
  TEST_ASSERT_EQUAL(FormError::None, validatePassword(formValue(f, "pass")));
  // Mạng mở (mật khẩu rỗng) và mật khẩu 8..63 ký tự
  TEST_ASSERT_EQUAL(FormError::None, validatePassword(""));
  TEST_ASSERT_EQUAL(FormError::PasswordTooShort, validatePassword("1234567"));
  TEST_ASSERT_EQUAL(FormError::None, validatePassword(std::string(63, 'a')));
  TEST_ASSERT_EQUAL(FormError::PasswordTooLong, validatePassword(std::string(64, 'a')));
}

// ── DNS ────────────────────────────────────────────────────────────────────

static std::vector<uint8_t> dnsQuery(const std::string& name, uint16_t qtype, uint16_t id = 0xBEEF, uint16_t flags = 0x0100) {
  std::vector<uint8_t> q = {static_cast<uint8_t>(id >> 8), static_cast<uint8_t>(id), static_cast<uint8_t>(flags >> 8),
                            static_cast<uint8_t>(flags), 0, 1, 0, 0, 0, 0, 0, 0};
  size_t start = 0;
  while (start <= name.size()) {
    size_t dot = name.find('.', start);
    if (dot == std::string::npos) dot = name.size();
    q.push_back(static_cast<uint8_t>(dot - start));
    for (size_t i = start; i < dot; i++) q.push_back(static_cast<uint8_t>(name[i]));
    start = dot + 1;
  }
  q.push_back(0);
  q.push_back(static_cast<uint8_t>(qtype >> 8)); q.push_back(static_cast<uint8_t>(qtype));
  q.push_back(0); q.push_back(1);
  return q;
}

static void test_dns_answers_a_with_device_ip() {
  const uint8_t ip[4] = {192, 168, 4, 1};
  const std::vector<uint8_t> q = dnsQuery("connectivitycheck.gstatic.com", 1);
  uint8_t out[512];
  const size_t n = buildDnsReply(q.data(), q.size(), ip, out, sizeof out);
  TEST_ASSERT_TRUE(n > q.size());
  TEST_ASSERT_EQUAL_HEX8(0xBE, out[0]); TEST_ASSERT_EQUAL_HEX8(0xEF, out[1]);   // ID
  TEST_ASSERT_TRUE((out[2] & 0x80) != 0);                                        // QR
  TEST_ASSERT_TRUE((out[2] & 0x01) != 0);                                        // RD sao chép
  TEST_ASSERT_EQUAL_HEX8(0x00, out[3] & 0x0F);                                   // NOERROR
  TEST_ASSERT_EQUAL_UINT8(1, out[7]);                                            // 1 answer
  TEST_ASSERT_EQUAL_UINT8(192, out[n - 4]); TEST_ASSERT_EQUAL_UINT8(168, out[n - 3]);
  TEST_ASSERT_EQUAL_UINT8(4, out[n - 2]); TEST_ASSERT_EQUAL_UINT8(1, out[n - 1]);
}

static void test_dns_other_types_get_empty_noerror() {
  const uint8_t ip[4] = {192, 168, 4, 1};
  uint8_t out[512];
  for (uint16_t type : {28, 65, 15, 16, 33}) {   // AAAA, HTTPS, MX, TXT, SRV
    const std::vector<uint8_t> q = dnsQuery("captive.apple.com", type);
    const size_t n = buildDnsReply(q.data(), q.size(), ip, out, sizeof out);
    TEST_ASSERT_EQUAL_UINT(q.size(), n);       // chỉ nhắc lại câu hỏi
    TEST_ASSERT_EQUAL_UINT8(0, out[7]);        // không có bản ghi trả lời
    TEST_ASSERT_EQUAL_HEX8(0x00, out[3] & 0x0F);
  }
}

static void test_dns_rejects_hostile_packets() {
  const uint8_t ip[4] = {192, 168, 4, 1};
  uint8_t out[512];
  std::vector<uint8_t> good = dnsQuery("a.b.c", 1);
  TEST_ASSERT_TRUE(buildDnsReply(good.data(), good.size(), ip, out, sizeof out) > 0);
  // Cắt cụt ở mọi độ dài
  for (size_t len = 0; len < good.size(); len++) TEST_ASSERT_EQUAL_UINT(0, buildDnsReply(good.data(), len, ip, out, sizeof out));
  // Nhãn dài 63 hợp lệ nhưng 64 và con trỏ nén thì không
  std::vector<uint8_t> p = good;
  p[12] = 64;
  TEST_ASSERT_EQUAL_UINT(0, buildDnsReply(p.data(), p.size(), ip, out, sizeof out));
  p = good; p[12] = 0xC0;
  TEST_ASSERT_EQUAL_UINT(0, buildDnsReply(p.data(), p.size(), ip, out, sizeof out));
  // Nhãn dài hơn phần còn lại của gói (đọc quá biên)
  p = good; p[12] = 60;
  TEST_ASSERT_EQUAL_UINT(0, buildDnsReply(p.data(), p.size(), ip, out, sizeof out));
  // Không có byte kết thúc tên
  std::vector<uint8_t> noterm(good.begin(), good.begin() + 12);
  for (int i = 0; i < 40; i++) { noterm.push_back(1); noterm.push_back('a'); }
  TEST_ASSERT_EQUAL_UINT(0, buildDnsReply(noterm.data(), noterm.size(), ip, out, sizeof out));
  // Là phản hồi (QR=1), opcode khác 0, 2 câu hỏi, có answer, lớp CH
  p = good; p[2] |= 0x80;
  TEST_ASSERT_EQUAL_UINT(0, buildDnsReply(p.data(), p.size(), ip, out, sizeof out));
  p = good; p[2] = 0x28;   // opcode 5
  TEST_ASSERT_EQUAL_UINT(0, buildDnsReply(p.data(), p.size(), ip, out, sizeof out));
  p = good; p[5] = 2;
  TEST_ASSERT_EQUAL_UINT(0, buildDnsReply(p.data(), p.size(), ip, out, sizeof out));
  p = good; p[7] = 1;
  TEST_ASSERT_EQUAL_UINT(0, buildDnsReply(p.data(), p.size(), ip, out, sizeof out));
  p = good; p[p.size() - 1] = 3;   // CLASS CH
  TEST_ASSERT_EQUAL_UINT(0, buildDnsReply(p.data(), p.size(), ip, out, sizeof out));
  // Tên > 255 byte
  std::string longName;
  for (int i = 0; i < 30; i++) longName += std::string(10, 'a') + ".";
  longName += "com";
  const std::vector<uint8_t> big = dnsQuery(longName, 1);
  TEST_ASSERT_EQUAL_UINT(0, buildDnsReply(big.data(), big.size(), ip, out, sizeof out));
  // Bộ đệm đầu ra quá nhỏ / con trỏ null
  TEST_ASSERT_EQUAL_UINT(0, buildDnsReply(good.data(), good.size(), ip, out, 100));
  TEST_ASSERT_EQUAL_UINT(0, buildDnsReply(nullptr, 0, ip, out, sizeof out));
}

static void test_dns_fuzz() {
  std::mt19937 rng(777);
  const uint8_t ip[4] = {192, 168, 4, 1};
  const std::vector<uint8_t> seed = dnsQuery("connectivitycheck.gstatic.com", 1);
  for (int iter = 0; iter < 100000; iter++) {
    std::vector<uint8_t> q;
    if (iter % 3 == 0) {
      q.resize(rng() % 600);
      for (auto& b : q) b = static_cast<uint8_t>(rng());
    } else {
      q = seed;
      const int muts = 1 + static_cast<int>(rng() % 4);
      for (int m = 0; m < muts; m++) {
        const size_t pos = rng() % q.size();
        if (rng() % 4 == 0) q.resize(1 + rng() % q.size()); else q[pos] = static_cast<uint8_t>(rng());
        if (q.empty()) q.push_back(0);
      }
    }
    std::vector<uint8_t> out(512);
    const size_t n = buildDnsReply(q.data(), q.size(), ip, out.data(), out.size());
    TEST_ASSERT_TRUE(n <= 512);
  }
}

void run_portal_http_tests() {
  RUN_TEST(test_http_get_probe);
  RUN_TEST(test_http_post_body_byte_by_byte);
  RUN_TEST(test_http_variants_accepted);
  RUN_TEST(test_http_limits_are_enforced);
  RUN_TEST(test_http_malformed_requests);
  RUN_TEST(test_http_after_done_or_error_extra_bytes_ignored);
  RUN_TEST(test_http_fuzz_random_and_mutated);
  RUN_TEST(test_form_parsing_vietnamese_and_specials);
  RUN_TEST(test_form_rejects_malformed);
  RUN_TEST(test_form_to_wifi_creds_end_to_end);
  RUN_TEST(test_dns_answers_a_with_device_ip);
  RUN_TEST(test_dns_other_types_get_empty_noerror);
  RUN_TEST(test_dns_rejects_hostile_packets);
  RUN_TEST(test_dns_fuzz);
}
