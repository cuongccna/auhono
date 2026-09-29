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

## Hành vi cảnh báo (đã tính tới tình huống thực tế)

| Tình huống | Cách xử lý |
|------------|------------|
| Mở cửa tủ lấy hàng / xả đá | Chỉ báo khi vượt ngưỡng **liên tục** 15 phút (chỉnh 5–60 phút cho từng tủ) |
| Cảm biến nhiễu / máy nén chạy-ngắt quanh ngưỡng | Về trong ngưỡng < 2 phút không reset bộ đếm |
| Lắp thiết bị vào tủ đang ấm, vừa rã đông, hoặc đổi ngưỡng | Chưa "armed" cho tới khi tủ đạt ngưỡng ít nhất một lần; quá 12 giờ vẫn ấm thì báo. Đổi ngưỡng hủy báo động cũ (không gửi "đã ổn") |
| Tủ hỏng kéo dài qua đêm | Nhắc lại theo lịch thưa dần: +30 phút, +2 giờ, +4 giờ, +8 giờ, +12 giờ (~26 giờ) rồi dừng. Nhắc lại chỉ gửi **người nhận chính** (đăng ký đầu tiên) |
| Chủ quán đã biết sự cố | Nút "Đã biết" (`POST /v1/devices/:id/ack`, 1–24 giờ) dừng nhắc lại; hết hạn mà chưa xong thì nhắc tiếp |
| Nghỉ Tết / chuyển tủ / rút điện có chủ ý | Nút "Tạm dừng" (`POST /v1/devices/:id/pause`, 1–60 ngày): không tốn tin nhắn, tự bật lại khi hết hạn |
| Bão báo động (dao động ngưỡng, lỗi bất thường) | Trần 20 tin/thiết bị/24 giờ (`DAILY_MESSAGE_CAP`); vượt trần thì tin bị `suppressed` (vẫn ghi sự kiện) |
| Nhiệt độ về bình thường thoáng qua | Chỉ báo "đã ổn" khi bình thường liên tục 5 phút |
| Mất điện / mất Wi-Fi / đứt dây đầu dò | Im lặng > 15 phút thì báo "mất kết nối"; nhắc lại +2 giờ, +6 giờ, +12 giờ; có số đo lại thì báo "đã kết nối lại" |
| Thiết bị mới lắp nhưng chưa từng kết nối (Wi-Fi 5 GHz, sai mật khẩu) | Sau 60 phút kể từ lúc gắn chủ thì báo |
| Trang chi tiết thiết bị | `GET /v1/devices/:id` trả trạng thái kèm `alarm_since`, `last_notified_at`, `armed`, `paused_until`, `acked_until` |
| Chưa có người nhận cảnh báo | `GET /v1/devices` trả `recipient_count: 0` để app cảnh báo chủ quán |
| ZNS lỗi tạm thời | Hàng đợi thử lại tối đa 8 lần, giãn cách 5/10/15... phút (chịu được ZNS lỗi vài giờ); thất bại hẳn hiện ở `notify_failures_24h` |
| Cron và request thiết bị chạy cùng lúc | Khóa lạc quan theo `version` + nhận việc nguyên tử: không báo trùng, không "mất kết nối" oan |

## Chi phí tin nhắn

Xem [`../docs/COST.md`](../docs/COST.md). Theo dõi thực tế bằng `npm run usage`.

## Telegram (kênh miễn phí, dự phòng cho ZNS)

Mỗi người nhận có thể nhận qua ZNS, Telegram, hoặc cả hai (`mode`: `zns` | `both` | `telegram`). Hai kênh độc lập: ZNS lỗi
hay hết trần chi phí thì tin Telegram vẫn đi. Telegram không bị trần 20 tin/ngày (miễn phí) và nhắc lại gửi cho mọi người đã liên kết.
Bạn (người vận hành) cũng nhận báo lỗi hệ thống qua Telegram (cron lỗi, tin thất bại hẳn).

```bash
# 1. Chat với @BotFather: /newbot -> lấy TOKEN và tên bot
# 2. Bí mật + tên bot
openssl rand -hex 24                               # dùng làm TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
#    đặt "TELEGRAM_BOT_USERNAME": "TenBotCuaBan" trong wrangler.jsonc rồi npm run deploy
# 3. Đăng ký webhook (đọc bí mật từ biến môi trường)
TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... WORKER_URL=https://auhono-server.<tài-khoản>.workers.dev bash scripts/telegram-setup.sh
# 4. (tùy chọn) nhận báo lỗi hệ thống: nhắn bất kỳ gì cho bot, rồi lấy chat id của bạn
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"chat":{"id":[0-9]*'
npx wrangler secret put OPERATOR_TELEGRAM_CHAT_ID
```

Liên kết một người nhận: app gọi `POST /v1/devices/:id/recipients/:rid/telegram-link` → `https://t.me/<bot>?start=<token>`
(một lần, hết hạn 24 giờ). Người nhận mở liên kết, bấm **Start**. Webhook chỉ chấp nhận khi header `X-Telegram-Bot-Api-Secret-Token`
đúng, chỉ liên kết từ chat riêng (không nhóm/kênh). `/stop` trong chat để ngừng nhận.

## Vận hành (SQL hữu ích)

```bash
# Thu hồi thiết bị (mất, bị lộ khóa). Phải cấp thiết bị/khóa mới; khóa suy từ id nên không xoay riêng được.
npx wrangler d1 execute auhono --remote --command "UPDATE devices SET revoked = 1 WHERE id = 'AUH-000123'"
# Gỡ chủ (khách bán/đổi máy, mất điện thoại): để chủ mới quét QR lại
npx wrangler d1 execute auhono --remote --command "UPDATE devices SET account_id = NULL, claimed_at = NULL WHERE id = 'AUH-000123'"
# Chip xóa flash nên seq về 0 (thiết bị tự nhảy qua khi nhận 409 replay; chỉ cần đặt lại khi cần)
npx wrangler d1 execute auhono --remote --command "UPDATE devices SET last_seq = 0 WHERE id = 'AUH-000123'"
# Tin nhắn lỗi gần đây
npx wrangler d1 execute auhono --remote --command "SELECT phone, last_error, updated_at FROM notifications WHERE status = 'failed' ORDER BY id DESC LIMIT 20"
```

## Giới hạn gói Cloudflare

- **Workers miễn phí giới hạn ~50 truy vấn D1 mỗi lần chạy** và 10 ms CPU/request. Cron đã tối ưu (1 truy vấn đọc cho cả đội)
  nhưng khi đội thiết bị lớn hoặc có nhiều tin nhắn cùng lúc, nên dùng **Workers Paid (~5$/tháng)**, rẻ hơn nhiều so với
  rủi ro bỏ sót cảnh báo. Trước khi bán đại trà, coi đây là chi phí cố định.
- D1: mỗi thiết bị ghi ~2,3k dòng/ngày ⇒ ~40 thiết bị chạm mức 100k dòng ghi/ngày của gói miễn phí.

## Bảo mật — cần biết

- **`MASTER_SECRET` là điểm yếu chung**: lộ nó là giả mạo được mọi thiết bị. Mất nó là mất khả năng xác thực máy đã giao.
  Sao lưu offline. (Đánh đổi có chủ đích: không lưu khóa trong DB, không cần bảng khóa.)
- Chống phát lại bằng `seq` tăng nghiêm ngặt (cập nhật nguyên tử trong D1) + cửa sổ thời gian ±5 phút.
- Kích hoạt: tối đa 10 lần nhập sai mã/giờ/tài khoản (429 `too_many_attempts`). Các endpoint khác **chưa có** giới hạn tốc độ:
  thêm Cloudflare Rate Limiting rule cho `/v1/*` trước khi mở rộng.
- Trạng thái cảnh báo dùng khóa lạc quan (`version`): va chạm giữa cron và request thiết bị được phát hiện và thử lại.
- Quota D1 gói free: ~100k dòng ghi/ngày. Mỗi thiết bị ghi ~2k dòng/ngày ⇒ tới khoảng 50 thiết bị thì cần gói trả phí (~5$/tháng).

## Chưa làm (biết rõ, quyết định sau)

- **Chia sẻ thiết bị cho nhiều tài khoản** (vợ chồng cùng xem app): hiện mỗi thiết bị thuộc một tài khoản; người khác chỉ nhận tin nhắn.
- **Tin nhắn thử** cho người nhận mới (để phát hiện gõ nhầm số trước khi có sự cố) — tốn thêm phí ZNS và một mẫu tin.
- **Xác nhận đồng ý của người nhận**: chủ quán có thể nhập số của người khác; nên có bước xác nhận trước khi bán đại trà.
- **SMS** làm kênh dự phòng thứ ba (thường đắt hơn ZNS): hiện có hàng đợi thử lại, `notify_failures_24h` và Telegram.
- **Khóa riêng từng thiết bị xoay được**: khóa suy từ `MASTER_SECRET` + id nên thu hồi = cấp id mới.
- **Ngưỡng theo mùa/tủ khác nhau** (xả đá định kỳ có lịch): hiện dùng ngưỡng cố định + thời gian vượt liên tục.
