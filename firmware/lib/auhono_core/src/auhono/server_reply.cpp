#include "auhono/server_reply.h"

#include "auhono/hex.h"
#include "auhono/json_scan.h"

namespace auhono {

namespace {

bool startsWith(const std::string& s, const char* prefix) {
  return s.rfind(prefix, 0) == 0;
}

bool isVersionChar(char c) {
  return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '.' ||
         c == '-' || c == '_' || c == '+';
}

}  // namespace

ServerReply parseReply(int status, const char* body, size_t len, bool requireOkField) {
  ServerReply r;
  r.status = status;
  if (status <= 0) { r.kind = ReplyKind::NetworkError; return r; }
  if (status >= 500) { r.kind = ReplyKind::ServerError; return r; }

  const JsonObject json(body, len);
  std::string error;
  if (json.valid()) json.getString("error", error);

  switch (status) {
    case 200: {
      if (!requireOkField) { r.kind = ReplyKind::Ok; return r; }
      bool ok = false;
      // Bắt buộc có "ok":true: tránh nhầm với trang HTML/JSON của mạng Wi-Fi công cộng.
      if (!json.valid() || !json.getBool("ok", ok) || !ok) { r.kind = ReplyKind::Unknown; return r; }
      r.kind = ReplyKind::Ok;
      uint64_t v = 0;
      if (json.getUInt("accepted", v) && v <= 1000) r.accepted = static_cast<uint32_t>(v);
      if (json.getUInt("server_time", v)) { r.hasServerTime = true; r.serverTime = v; }
      JsonObject cfg("", 0);
      int32_t mn = 0, mx = 0;
      if (json.getObject("config", cfg) && cfg.getCenti("min_c", mn) && cfg.getCenti("max_c", mx) &&
          Thresholds::isSane(mn, mx)) {
        r.hasConfig = true;
        r.config.minCenti = static_cast<int16_t>(mn);
        r.config.maxCenti = static_cast<int16_t>(mx);
      }
      return r;
    }
    case 401: {
      uint64_t t = 0;
      if (error == "clock_skew" && json.getUInt("server_time", t)) {
        r.kind = ReplyKind::ClockSkew;
        r.hasServerTime = true;
        r.serverTime = t;
      } else {
        r.kind = ReplyKind::Unauthorized;
      }
      return r;
    }
    case 409: {
      r.kind = (error == "replay") ? ReplyKind::Replay : ReplyKind::Unknown;
      uint64_t n = 0;
      if (r.kind == ReplyKind::Replay && json.getUInt("last_seq", n)) { r.hasLastSeq = true; r.lastSeq = n; }
      return r;
    }
    case 413: r.kind = ReplyKind::TooLarge; return r;
    case 400: r.kind = ReplyKind::BadRequest; return r;
    default: r.kind = ReplyKind::Unknown; return r;
  }
}

bool parseServerTime(const char* body, size_t len, uint64_t& serverTime) {
  const JsonObject json(body, len);
  return json.valid() && json.getUInt("server_time", serverTime);
}

OtaParse parseOtaManifest(const char* body, size_t len, OtaManifest& out) {
  const JsonObject json(body, len);
  bool update = false;
  if (!json.valid() || !json.getBool("update", update)) return OtaParse::Invalid;
  if (!update) return OtaParse::NoUpdate;

  OtaManifest m;
  std::string sha, sig;
  if (!json.getString("version", m.version) || !json.getString("url", m.url) ||
      !json.getString("sha256", sha) || !json.getString("signature", sig)) {
    return OtaParse::Invalid;
  }
  if (m.version.empty() || m.version.size() > 32) return OtaParse::Invalid;
  for (char c : m.version) if (!isVersionChar(c)) return OtaParse::Invalid;

  // Chỉ https; không khoảng trắng/ký tự điều khiển (tránh chèn header).
  if (!startsWith(m.url, "https://") || m.url.size() > 512 || m.url.size() <= 8) return OtaParse::Invalid;
  for (char c : m.url) if (static_cast<unsigned char>(c) <= 0x20 || c == 0x7f) return OtaParse::Invalid;

  size_t n = 0;
  if (sha.size() != 64 || !fromHex(sha.data(), sha.size(), m.sha256, sizeof m.sha256, &n) || n != 32) {
    return OtaParse::Invalid;
  }
  // DER của chữ ký ECDSA P-256 dài 8..72 byte (thường 70-72).
  if (sig.size() < 16 || sig.size() > 144) return OtaParse::Invalid;
  m.signature.resize(sig.size() / 2);
  if (!fromHex(sig.data(), sig.size(), m.signature.data(), m.signature.size(), &n) || n != m.signature.size()) {
    return OtaParse::Invalid;
  }
  out = std::move(m);
  return OtaParse::Update;
}

}  // namespace auhono
