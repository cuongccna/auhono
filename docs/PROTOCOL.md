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

### Gói nhịp tim và chẩn đoán (`diag`)

`readings` có thể **rỗng** (0–20 phần tử) và body có thể kèm `diag`:

```json
{ "fw": "1.0.0", "readings": [], "diag": { "sensor": "fault", "fault_s": 1200, "rst": "brownout", "rssi": -71, "heap": 84000, "up": 86400 } }
```

| Trường   | Kiểu / giới hạn                          | Ý nghĩa                                                       |
|----------|------------------------------------------|---------------------------------------------------------------|
| `sensor` | `"ok"` hoặc `"fault"`                    | Đầu dò đọc được hay không                                     |
| `fault_s`| số nguyên 0..2^31                        | Bao nhiêu giây kể từ số đo hợp lệ cuối cùng                   |
| `rst`    | chuỗi `[A-Za-z0-9_]{1,16}`               | Lý do khởi động lại gần nhất (`poweron`, `brownout`, `wdt`...) |
| `rssi`   | số nguyên -120..0                        | Cường độ Wi-Fi (dBm)                                          |
| `heap`   | số nguyên >= 0                           | Bộ nhớ trống (byte)                                           |
| `up`     | số nguyên >= 0                           | Thời gian chạy từ lần khởi động (giây)                        |

Mọi trường đều tùy chọn; trường lạ bị máy chủ bỏ qua. **Không có `diag` thì body và chữ ký giữ nguyên như trước**
(vector chuẩn ở trên không có `diag`).

**Khi nào gửi nhịp tim:** nếu quá 5 phút không có số đo hợp lệ (đứt dây đầu dò, cảm biến hỏng), thiết bị vẫn gửi gói
`readings: []` + `diag` mỗi 5 phút. Nhờ đó máy chủ biết thiết bị **còn sống nhưng không đọc được nhiệt độ** (báo
"lỗi cảm biến") thay vì "mất kết nối" (mất điện/mất Wi-Fi). Máy chủ đếm gói nhịp tim là "còn liên lạc" nhưng không
tính là số đo. Thiết bị cũ không gửi nhịp tim thì máy chủ vẫn báo "mất kết nối" như trước.
Nên kèm `diag` trong các gói số đo bình thường để hỗ trợ từ xa (RSSI, lý do khởi động lại).

Máy chủ trả phản hồi 200 như gói số đo bình thường (`accepted: 0`).

## Wi-Fi cấu hình của thiết bị (AP) có mật khẩu WPA2

Cổng cấu hình không còn là Wi-Fi mở. Cả thiết bị lẫn máy chủ tự suy ra cùng một mật khẩu từ khóa thiết bị, nên không
cần lưu thêm gì lúc ráp máy:

```
ap_ssid     = "Auhono-" + 4 ký tự cuối của device_id            (vd. AUH-000001 -> Auhono-0001)
ap_password = 10 ký tự đầu: ALPHABET[byte % 32] của HMAC-SHA256(device_key, "ap-password:v1")
              (ALPHABET = 0123456789ABCDEFGHJKMNPQRSTVWXYZ, giống mã kích hoạt)
wifi_qr     = "WIFI:T:WPA;S:<ap_ssid>;P:<ap_password>;H:false;;"      (điện thoại quét bằng camera là tự vào Wi-Fi)
```

Vector chuẩn (đã đối chiếu bằng openssl; `server/test/protocol-vector.test.ts`):

```
device_key  = 41bc43e33ceb8fd260f6888bcf8b89858310b99545a24ac3a6a76bb1b7b8a507   (device AUH-000001, master thử)
HMAC(key, "ap-password:v1") = 7db6c1ac7f11f6a3dfc0...
ap_password = XP1CZHP3Z0
wifi_qr     = WIFI:T:WPA;S:Auhono-0001;P:XP1CZHP3Z0;H:false;;
```

`scripts/provision.ts` in mật khẩu và nội dung mã QR Wi-Fi để dán lên hộp cùng mã kích hoạt. Chủ quán mất tem có
thể xem lại mật khẩu trong app (`GET /v1/devices/:id/setup`, chỉ chủ thiết bị).

## `GET /v1/ota/check?current=1.0.0`

Có ký (body rỗng). Trả `{"update":false}` hoặc:

```json
{ "update": true, "version": "1.0.1", "url": "https://…/fw.bin", "sha256": "…", "signature": "…" }
```

Chip tải `url` (bắt buộc `https://`), kiểm `sha256` **và chữ ký** rồi mới cài; sai một trong hai thì hủy, giữ bản đang chạy.
Nếu không kiểm chữ ký firmware thì khóa HMAC của thiết bị không còn ý nghĩa bảo vệ.

- `sha256`: hex thường 64 ký tự của SHA-256(file `.bin`).
- `signature`: ECDSA **P-256 (secp256r1) / SHA-256** ký lên toàn bộ nội dung file `.bin`, mã hóa **DER**
  (ASN.1 SEQUENCE{r,s}, 70–72 byte) viết thành hex thường. Khóa công khai (PEM SPKI, `firmware/keys/ota_public.pem`)
  nhúng vào firmware lúc build.
- Ký bằng `firmware/tools/ota_sign.py`; script in sẵn câu `INSERT INTO firmware_releases`.

## Nhịp gửi khuyến nghị

- Đo mỗi 60 s; gom và gửi mỗi 5 phút; vượt ngưỡng thì gửi ngay.
- Gửi thất bại: giữ số đo trong RAM/flash (tối đa ~24 giờ), gửi bù khi có mạng (mỗi gói ≤ 20 số đo).
- Backoff khi lỗi: 30 s → 1 → 2 → 5 phút (không vượt 5 phút), cộng ngẫu nhiên ±20% để nhiều máy không dồn cùng lúc sau mất điện.
