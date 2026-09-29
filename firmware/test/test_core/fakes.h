// Đối tượng giả dùng chung cho các test.
#pragma once
#include <cstdint>
#include <deque>
#include <string>
#include <vector>

#include "auhono/backoff.h"
#include "auhono/device_client.h"
#include "auhono/seq_counter.h"

/// "Flash" giả: sống sót qua các lần "khởi động lại" mô phỏng.
struct FakeSeqStore : auhono::ISeqStore {
  bool has = false;
  uint64_t value = 0;
  int saves = 0;
  bool failSave = false;
  bool load(uint64_t& v) override { if (!has) return false; v = value; return true; }
  bool save(uint64_t v) override {
    if (failSave) return false;
    has = true; value = v; ++saves;
    return true;
  }
};

struct FakeRandom : auhono::IRandom {
  uint32_t v = 0;
  uint32_t step = 1;
  uint32_t next() override { uint32_t r = v; v += step; return r; }
};

struct FakePlatform : auhono::IPlatform {
  uint32_t ms = 0;
  uint32_t mono = 0;   // giây từ lúc khởi động (đơn điệu)
  uint32_t unix_ = 0;
  bool trusted = false;
  int wdtFeeds = 0;
  int setUnixCalls = 0;
  uint32_t millis() override { return ms; }
  uint32_t monoSeconds() override { return mono; }
  uint32_t unixNow() override { return unix_; }
  bool clockTrusted() override { return trusted; }
  void setUnix(uint32_t t) override { unix_ = t; trusted = true; ++setUnixCalls; }
  void feedWatchdog() override { ++wdtFeeds; }
};

/// HTTP giả: trả lần lượt các phản hồi đã hẹn, ghi lại mọi request (body được sao chép).
struct FakeHttp : auhono::IHttp {
  struct Recorded {
    auhono::HttpRequest req;
    std::string body;
  };
  std::deque<auhono::HttpResponse> script;
  std::vector<Recorded> log;
  auhono::HttpResponse fallback{200, "{\"ok\":true,\"accepted\":1,\"server_time\":1800000000,\"config\":{\"min_c\":-40,\"max_c\":-18}}"};

  auhono::HttpResponse perform(const auhono::HttpRequest& req) override {
    Recorded r;
    r.req = req;
    if (req.body) r.body.assign(reinterpret_cast<const char*>(req.body), req.bodyLen);
    log.push_back(r);
    if (script.empty()) return fallback;
    auhono::HttpResponse out = script.front();
    script.pop_front();
    return out;
  }
};

inline std::string okBody(unsigned accepted = 1, unsigned long long serverTime = 1800000000ULL) {
  return "{\"ok\":true,\"accepted\":" + std::to_string(accepted) + ",\"server_time\":" +
         std::to_string(serverTime) + ",\"config\":{\"min_c\":-40,\"max_c\":-18}}";
}
