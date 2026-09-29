# Auhono server

Cloudflare Worker + D1 (Hono, TypeScript). Nhận số đo từ thiết bị, chạy logic cảnh báo, gửi Zalo ZNS, phục vụ API cho Mini App.

- Giao thức thiết bị: [`../docs/PROTOCOL.md`](../docs/PROTOCOL.md)
- Mẫu tin ZNS: [`../docs/zns-templates.md`](../docs/zns-templates.md)

## Cấu trúc

| File                | Vai trò                                                                          |
|---------------------|----------------------------------------------------------------------------------|
| `src/alerts.ts`     | **Máy trạng thái cảnh báo** (hàm thuần): chống báo nhầm/làm phiền, offline       |
| `src/crypto.ts`     | Suy khóa thiết bị, ký/kiểm HMAC                                                  |
| `src/app.ts`        | API HTTP: thiết bị (`/v1/readings`, `/v1/ota/check`) và chủ quán (`/v1/devices…`) |
| `src/ingest.ts`     | Lưu số đo + chạy máy trạng thái + ghi sự kiện (1 batch D1)                       |
| `src/cron.ts`       | Cron 5 phút: phát hiện im lặng, nhắc lại; gộp số đo > 7 ngày theo giờ           |
| `src/notify.ts`     | Hàng đợi gửi tin (outbox, thử lại) + giao diện `Notifier`                        |
| `src/zns.ts`        | `Notifier` cho Zalo ZNS (+ làm mới token OA)                                     |
| `scripts/provision.ts` | Sinh khóa/mã kích hoạt/QR cho thiết bị lúc ráp                                |

## Chạy thử

```bash
npm install          # .npmrc đã bật legacy-peer-deps
npm test             # vitest trong workerd thật, D1 giả lập
npm run typecheck
```

## Triển khai lần đầu

```bash
npx wrangler d1 create auhono                 # dán database_id vào wrangler.jsonc
npm run db:migrate:remote
openssl rand -hex 32 | npx wrangler secret put MASTER_SECRET   # GIỮ BẢN SAO Ở NƠI AN TOÀN
npx wrangler secret put ZALO_APP_ID; npx wrangler secret put ZALO_APP_SECRET; npx wrangler secret put ZALO_OA_REFRESH_TOKEN
npm run deploy

MASTER_SECRET=<cùng giá trị> npm run provision -- --start 1 --count 8
npx wrangler d1 execute auhono --remote --file out/devices.sql
```

Chưa cấu hình ZNS thì cảnh báo chỉ được ghi log (`LogNotifier`), hàng đợi vẫn chạy.

## Bảo mật — cần biết

- **`MASTER_SECRET` là điểm yếu chung**: lộ nó là giả mạo được mọi thiết bị. Mất nó là mất khả năng xác thực máy đã giao.
  Sao lưu offline. (Đánh đổi có chủ đích: không lưu khóa trong DB, không cần bảng khóa.)
- Chống phát lại bằng `seq` tăng nghiêm ngặt (cập nhật nguyên tử trong D1) + cửa sổ thời gian ±5 phút.
- **Chưa có giới hạn tốc độ** trên `/v1/devices/claim` (mã 50 bit, khó dò nhưng nên có). Thêm Cloudflare Rate Limiting
  rule cho `/v1/*` ở dashboard trước khi mở rộng.
- Đọc-sửa-ghi trạng thái cảnh báo không khóa: hai gói cùng thiết bị tới cùng lúc có thể làm mất một bước đếm.
  Chip gửi tuần tự nên bỏ qua ở quy mô thử nghiệm.
- Quota D1 gói free: ~100k dòng ghi/ngày. Mỗi thiết bị ghi ~2k dòng/ngày ⇒ tới khoảng 50 thiết bị thì cần gói trả phí (~5$/tháng).
