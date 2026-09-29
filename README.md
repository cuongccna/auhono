# auhono

Cảm biến nhiệt độ tủ đông cho quán ăn, tiệm hải sản, cửa hàng sữa. Thiết bị ESP32-C3 + đầu dò DS18B20
gửi số đo lên Cloudflare Workers; khi tủ quá nóng hoặc mất điện/mất mạng, chủ quán nhận tin Zalo (ZNS).

| Thư mục     | Nội dung                                                              | Giai đoạn |
|-------------|-----------------------------------------------------------------------|-----------|
| `docs/`     | [Kế hoạch 8 tuần](docs/PLAN.md), [giao thức thiết bị](docs/PROTOCOL.md), [mẫu tin ZNS](docs/zns-templates.md) | 0 |
| `firmware/` | Phần mềm trên chip (PlatformIO, Arduino)                              | 1 |
| `server/`   | Cloudflare Worker + D1: nhận số đo, logic cảnh báo, gửi ZNS, API      | 2 |
| `app/`      | Zalo Mini App cho chủ quán                                            | 3 |

Bắt đầu từ [`server/README.md`](server/README.md) (chạy được và có test đầy đủ nhất).
