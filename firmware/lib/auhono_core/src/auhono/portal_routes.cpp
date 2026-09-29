#include "auhono/portal_routes.h"

namespace auhono {

bool isPortalHost(const std::string& host, const std::string& apIp) {
  std::string h = host;
  for (char& c : h) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + 32);
  if (h == apIp) return true;
  return h == apIp + ":80";
}

PortalRoute routeRequest(HttpMethod method, const std::string& path, const std::string& host, const std::string& apIp) {
  // Host lạ (captive.apple.com, connectivitycheck.gstatic.com, tên gõ tay...): luôn về IP của thiết bị,
  // kể cả POST (client sẽ tải lại bằng GET).
  if (!isPortalHost(host, apIp)) return PortalRoute::Redirect;
  const bool read = method == HttpMethod::Get || method == HttpMethod::Head;
  if ((path == "/" || path == "/index.html") && read) return PortalRoute::Form;
  if (path == "/save" && method == HttpMethod::Post) return PortalRoute::Save;
  if (path == "/rescan" && method == HttpMethod::Get) return PortalRoute::Rescan;
  return PortalRoute::Redirect;
}

bool isCaptiveProbePath(const std::string& path) {
  static const char* const kPaths[] = {
      "/generate_204", "/gen_204", "/hotspot-detect.html", "/library/test/success.html", "/connecttest.txt",
      "/ncsi.txt", "/redirect", "/success.txt", "/canonical.html", "/check_network_status.txt", "/fwlink/"};
  for (const char* p : kPaths) if (path == p) return true;
  return false;
}

}  // namespace auhono
