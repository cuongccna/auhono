# Giao thức thiết bị ↔ máy chủ

Mọi request của thiết bị đi qua HTTPS và được ký HMAC-SHA256. Máy chủ: `server/src/app.ts`.
Firmware phải khớp chính xác từng byte với mô tả dưới đây.

## Khóa

```
device_key = HMAC-SHA256(key = MASTER_SECRET, msg = "device-key:" + device_id)   // 32 byte
activation = 10 ký tự đầu của base32-Crockford(HMAC-SHA256(MASTER_SECRET, "activation:" + device_id))
```

`scripts/provision.ts` sinh `device_key` (hex) để nạp vào chip lúc ráp và mã kích hoạt in trong QR.
Máy chủ không lưu khóa thiết bị: lộ database không lộ khóa. Lộ `MASTER_SECRET` thì phải nạp lại toàn bộ.

## Request

Header bắt buộc:

| Header        | Ý nghĩa                                                    |
|---------------|------------------------------------------------------------|
| `X-Device-Id` | ví dụ `AUH-000001`                                         |
| `X-Timestamp` | unix giây (UTC), lệch server tối đa ±300 s                 |
| `X-Seq`       | số nguyên **tăng nghiêm ngặt** mỗi request (lưu trong NVS) |
| `X-Signature` | hex thường của HMAC-SHA256(device_key, canonical)          |

```
canonical = METHOD "\n" PATH "\n" device_id "\n" timestamp "\n" seq "\n" hex(SHA256(body))
```

- `PATH` không gồm query string. `METHOD` viết hoa. Body rỗng (GET) thì băm chuỗi rỗng.
- Xuống dòng là `\n` (0x0A), không có ký tự thừa ở cuối.

### Vector kiểm thử (đã đối chiếu bằng openssl; `server/test/protocol-vector.test.ts`)

```
MASTER_SECRET = test-master-secret-do-not-use-in-prod
device_id     = AUH-000001
device_key    = 41bc43e33ceb8fd260f6888bcf8b89858310b99545a24ac3a6a76bb1b7b8a507
body          = {"readings":[{"t":1800000000,"c":-19.5}]}
timestamp     = 1800000000     seq = 7     POST /v1/readings
canonical     = "POST\n/v1/readings\nAUH-000001\n1800000000\n7\n76d37a0d15295407d0cf6b872b02a1a239a43d23d8ce8bcfd65be46622156899"
signature     = 8c2bca443f59548fb5ac50fa912d6e58bff435fdc5a563b46767e6699fcdb12a
```

## Phản hồi lỗi (thiết bị phải xử lý)

| Mã  | Body                                   | Thiết bị làm gì                                                     |
|-----|----------------------------------------|---------------------------------------------------------------------|
| 401 | `{"error":"unauthorized"}`             | Sai khóa/thiết bị bị thu hồi. Thử lại chậm (backoff), đừng dồn dập. |
| 401 | `{"error":"clock_skew","server_time"}` | Đặt lại đồng hồ theo `server_time`, tăng seq, gửi lại.              |
| 409 | `{"error":"replay","last_seq":N}`      | Đặt `seq = max(seq, N) + 1` rồi gửi lại (vd. sau khi xóa flash).    |
| 413 | `{"error":"too_large"}`                | Body > 4096 byte: chia nhỏ gói.                                     |
| 400 | `{"error":"bad_request"}`              | Dữ liệu sai định dạng: bỏ gói, không gửi lại nguyên xi.             |

Chỉ request đã **ký đúng** mới nhận `clock_skew`/`replay`; request lạ luôn chỉ nhận 401 chung.
`GET /v1/time` (không cần ký) trả `{"server_time":…}` để chip chỉnh giờ khi NTP lỗi.

## `POST /v1/readings`

```json
{ "fw": "1.0.0", "readings": [ { "t": 1800000000, "c": -19.5 } ] }
```

- 1–20 số đo mỗi gói; `t` unix giây, `c` °C trong [-60, 125]. Thiết bị **bỏ** số đo lỗi
  (DS18B20 trả -127 khi đứt dây, 85 khi vừa reset) — đừng gửi.
- Server bỏ số đo cũ hơn 24 giờ hoặc ở tương lai quá 5 phút; ts trùng thì bỏ qua (an toàn khi gửi lại).
- Phản hồi 200:

```json
{ "ok": true, "accepted": 5, "server_time": 1800000004, "config": { "min_c": -40, "max_c": -18 } }
```

Chip dùng `config` để biết khi nào **gửi ngay** (số đo vượt ngưỡng), và `server_time` để hiệu chỉnh đồng hồ.

## `GET /v1/ota/check?current=1.0.0`

Có ký (body rỗng). Trả `{"update":false}` hoặc:

```json
{ "update": true, "version": "1.0.1", "url": "https://…/fw.bin", "sha256": "…", "signature": "…" }
```

Chip tải `url`, kiểm `sha256` **và chữ ký Ed25519** (khóa công khai nhúng trong firmware) rồi mới cài.
Nếu không kiểm chữ ký firmware thì khóa HMAC của thiết bị không còn ý nghĩa bảo vệ.

## Nhịp gửi khuyến nghị

- Đo mỗi 60 s; gom và gửi mỗi 5 phút; vượt ngưỡng thì gửi ngay.
- Gửi thất bại: giữ số đo trong RAM/flash (tối đa ~24 giờ), gửi bù khi có mạng (mỗi gói ≤ 20 số đo).
- Backoff khi lỗi: 30 s → 1 → 2 → 5 phút (không vượt 5 phút), cộng ngẫu nhiên ±20% để nhiều máy không dồn cùng lúc sau mất điện.
