# Auhono firmware (ESP32-C3)

Firmware cho cảm biến nhiệt độ tủ đông: đo bằng DS18B20, gửi lên server (`../server`) qua HTTPS có ký HMAC,
tự cập nhật OTA có kiểm chữ ký. Hợp đồng giao thức: [`../docs/PROTOCOL.md`](../docs/PROTOCOL.md) (firmware khớp từng byte).

## Cấu trúc

| Đường dẫn                   | Nội dung                                                                                 |
|-----------------------------|------------------------------------------------------------------------------------------|
| `lib/auhono_core/`          | **Logic thuần C++17, không phụ thuộc phần cứng, có test chạy trên máy**: ký request, seq, bộ đệm số đo, JSON, backoff, ngưỡng, parser phản hồi, LED, form cấu hình... |
| `src/`                      | Phần "dán" với phần cứng: Wi-Fi, HTTPS, NVS, DS18B20, OTA, cổng cấu hình, LED, `main.cpp` |
| `include/config.h`          | Chân GPIO, nhịp đo/gửi, timeout (đổi chân bằng build flag)                                |
| `test/test_core/`           | Test Unity (`pio test -e native`), gồm vector giao thức trong PROTOCOL.md                |
| `partitions.csv`            | Bảng phân vùng 4 MB: 2 khe OTA + phân vùng `ident` giữ danh tính                          |
| `certs/roots.pem`           | Bộ CA gốc TLS mà thiết bị tin cậy (tạo bằng `tools/make_roots.py`)                        |
| `keys/ota_public.pem`       | Khóa công khai kiểm chữ ký OTA (**tự tạo**, xem bên dưới; khóa bí mật ở `keys/private/`, gitignore) |
| `tools/`                    | `flash_identity.py`, `gen_ota_keys.sh`, `ota_sign.py`, `make_roots.py`, `pio_pre.py`      |

## Đấu dây

```
ESP32-C3 (bo nhỏ)                DS18B20 chống nước (3 dây)
  3V3  ───────────┬───────────── đỏ   (VDD)
                  │
                [4,7 kΩ]         (điện trở kéo lên, đặt giữa DATA và 3V3)
                  │
  GPIO4 ──────────┴───────────── vàng/trắng (DATA)
  GND  ────────────────────────── đen  (GND)

  LED trạng thái : LED on-board, GPIO8 (đa số bo C3 SuperMini: sáng khi mức THẤP)
  Nút            : nút BOOT on-board, GPIO9 (mức thấp khi nhấn)
  Nguồn          : cục sạc USB 5V (không pin, không deep sleep)
```

Bo của bạn khác chân/khác mức LED thì đổi bằng build flag trong `platformio.ini`
(`-DONEWIRE_PIN`, `-DLED_PIN`, `-DLED_ACTIVE_LOW`, `-DBUTTON_PIN`). Đừng nhấn giữ nút BOOT lúc **cấp điện**
(GPIO9 là chân strapping: giữ lúc reset sẽ vào chế độ nạp).

## Build và test

```bash
pip install platformio
cd firmware

pio test -e native        # test logic trên máy tính (không cần chip, không cần Arduino)
tools/gen_ota_keys.sh     # LẦN ĐẦU: tạo cặp khóa ký OTA (xem mục OTA)
# sửa platformio.ini: AUHONO_SERVER_URL (https://..., không có / cuối), AUHONO_FW_VERSION
pio run -e esp32c3        # biên dịch
pio run -e esp32c3 -t upload   # nạp qua USB
pio device monitor        # xem log (115200)
```

- `pio run` dừng ngay với thông báo dễ hiểu (`tools/pio_pre.py`) nếu thiếu `keys/ota_public.pem`,
  `certs/roots.pem`, hoặc `keys/ota_public.pem` lỡ chứa khóa bí mật.
- `-DALLOW_INSECURE_TLS` (mặc định TẮT, đang comment trong `platformio.ini`) chỉ để thử với server cục bộ tự ký;
  bật lên là **không xác thực chứng chỉ server**, build in cảnh báo. Không bao giờ dùng cho máy giao khách.
- `AUHONO_SERVER_URL` phải bắt đầu bằng `https://`, sai là không biên dịch được (`static_assert`).
- Thay đổi CA: sửa `WANTED` trong `tools/make_roots.py` rồi chạy lại (dùng kho CA của hệ thống hoặc `--source cacert.pem`).
  Mặc định gồm 12 CA gốc (Let's Encrypt, Google Trust Services, GlobalSign, DigiCert G2, Sectigo/USERTrust, SSL.com, Amazon).
  Server dùng CA khác thì thêm vào, nếu không thiết bị sẽ không kết nối được.

## Nạp danh tính (lúc ráp máy)

Mỗi chip cần **mã thiết bị + khóa 32 byte** riêng. Chúng nằm ở phân vùng NVS riêng tên `ident` (16 KB tại `0x3F0000`),
**ngoài ảnh firmware**: nạp lại firmware, OTA, hay "reset Wi-Fi" đều không đụng tới.

1. Sinh danh sách trên máy có `MASTER_SECRET` (xem `../server/README.md`):
   `MASTER_SECRET=... npm run provision -- --start 1 --count 8` → `server/out/devices.csv`
   (`device_id,device_key_hex,activation_code,qr_payload`). File này chứa khóa bí mật: đừng commit.
2. Với mỗi chip cắm USB:

   ```bash
   pip install esp-idf-nvs-partition-gen esptool
   python3 tools/flash_identity.py --csv ../server/out/devices.csv --device AUH-000001 --port /dev/ttyUSB0
   ```

   Script đọc dòng của `AUH-000001`, dựng ảnh NVS bằng `esp_idf_nvs_partition_gen`, ghi vào đúng địa chỉ phân vùng
   `ident` (lấy từ `partitions.csv`, một nguồn sự thật) bằng esptool (tự kiểm MD5), rồi xóa tệp tạm. Không in khóa ra màn hình.
   `--no-flash --out ident_AUH-000001.bin` chỉ tạo ảnh (tệp quyền 0600, đã gitignore) để nạp sau.
3. Nạp firmware (`pio run -e esp32c3 -t upload`) — thứ tự với bước 2 tùy ý. **Không** dùng `pio run -t erase`
   (xóa cả chip, mất danh tính). Cần xóa Wi-Fi thì xem "Reset về xuất xưởng".
4. Dán nhãn/QR (`qr_payload`) lên hộp. Mở log: `Auhono fw 1.0.0, thiet bi AUH-000001`. Thiếu danh tính thì đèn nháy 3 lần liên tục.

> Chưa bật mã hóa flash / secure boot. Ai có chip trong tay đọc được khóa qua cổng nạp. Với lô thử nghiệm thì chấp nhận;
> trước khi bán đại trà nên bật flash encryption + secure boot (khi đó cần xem lại `partitions.csv` và quy trình OTA).

## Cấu hình Wi-Fi (chủ quán, không cần người hỗ trợ)

1. Cắm điện lần đầu: thiết bị phát Wi-Fi **mở** tên `Auhono-XXXX` (4 ký tự cuối của mã thiết bị), đèn nháy nhanh.
2. Điện thoại kết nối vào Wi-Fi đó: trang cấu hình tự bật (nếu không, mở `http://192.168.4.1`).
3. Chọn Wi-Fi của quán (danh sách quét, hoặc gõ tay nếu mạng ẩn) và nhập mật khẩu → "Lưu và kết nối".
   Trang ghi rõ **chỉ Wi-Fi 2.4 GHz**. Mã thiết bị hiển thị trên trang.
4. Thiết bị tắt Wi-Fi cấu hình và kết nối; đèn sáng liên tục là xong.

Cổng cấu hình cũng tự mở lại khi mất Wi-Fi đã lưu liên tục **20 phút** (vd. đổi modem), hoặc khi giữ nút **5 giây**.
Cổng tự đóng sau **10 phút** không ai lưu (đã có Wi-Fi lưu thì quay lại thử mạng đó, **không khởi động lại** nên giữ được số đo trong RAM;
chưa có Wi-Fi nào thì khởi động lại và mở lại cổng). Trang không có JavaScript, mọi chuỗi đều được escape, có CSP,
giới hạn SSID ≤ 32 byte và mật khẩu 8–63 ký tự ASCII, tối đa 4 điện thoại.

## Đèn LED

| Đèn                                           | Nghĩa                                                          | Việc cần làm                                        |
|-----------------------------------------------|----------------------------------------------------------------|-----------------------------------------------------|
| Nháy **nhanh** (5 lần/giây)                   | Đang ở chế độ cấu hình Wi-Fi (AP `Auhono-XXXX`)                 | Kết nối điện thoại vào Wi-Fi đó, nhập Wi-Fi của quán |
| Nháy **chậm** (1 s sáng / 1 s tắt)            | Đang kết nối Wi-Fi, hoặc chưa gửi thành công lần nào           | Chờ ~1–2 phút; quá lâu thì kiểm tra Wi-Fi/mật khẩu   |
| **Sáng liên tục**                             | Trực tuyến, lần gửi gần nhất thành công                        | Bình thường                                         |
| **Nháy đôi** (hai nháy ngắn rồi nghỉ)         | Có Wi-Fi nhưng server từ chối / lỗi / lệch giờ                 | Xem log; kiểm tra thiết bị có bị thu hồi, server sống |
| Sáng, **tắt ngắn** mỗi ~1,5 s ("nháy ngược")  | Lỗi cảm biến (3 lần đọc liên tiếp hỏng: đứt dây, thiếu trở kéo) | Kiểm tra dây DS18B20 và điện trở 4,7 kΩ              |
| **3 nháy ngắn** rồi nghỉ                      | Chưa nạp danh tính (mã + khóa)                                 | Chạy `tools/flash_identity.py`                       |

Thứ tự ưu tiên: thiếu danh tính > cấu hình > lỗi cảm biến > chưa có Wi-Fi/chưa gửi > server lỗi > bình thường.

## Nút bấm và reset về xuất xưởng

- Giữ nút BOOT **5 giây**: mở cổng cấu hình Wi-Fi.
- Tiếp tục giữ tới **15 giây**: xóa Wi-Fi đã lưu (giữ danh tính), rồi mở cổng cấu hình.
- Xóa hẳn dữ liệu người dùng bằng dòng lệnh (giữ danh tính, ngưỡng, seq): `python -m esptool --chip esp32c3 erase_region 0x9000 0x5000`
  (phân vùng `nvs`). Danh tính ở `ident` nên không mất.

## Hoạt động

- **Đo** mỗi 60 s (DS18B20 12-bit, không chặn). Số đo lỗi (-127 đứt dây, 85,0 vừa cấp điện, NaN, ngoài [-55, 125]) bị **bỏ**, không bao giờ gửi.
- **Gửi** gói định kỳ mỗi 5 phút, ≤ 20 số đo/gói, cũ nhất trước. Số đo vượt ngưỡng `config.min_c/max_c` (server trả về, cache trong NVS;
  mặc định -40/-18 °C tới khi có phản hồi đầu) thì gửi **ngay**, tối đa 1 lần/60 s.
- Số đo được xóa khỏi RAM **chỉ sau khi server trả 200** (hoặc 400 = dữ liệu bị từ chối vĩnh viễn). Lỗi thì giữ lại, gửi bù sau
  với backoff 30 s → 1 → 2 → 5 phút (trần 5 phút) ±20% ngẫu nhiên. Số đo cũ hơn 24 giờ bị bỏ (server cũng bỏ).
- **Đồng hồ**: NTP (`pool.ntp.org`, `time.google.com`, `time.cloudflare.com`). Chưa có giờ đáng tin (> năm 2025) thì **không ghi số đo**.
  NTP im lặng 20 s thì hỏi `GET /v1/time`; `401 clock_skew` thì chỉnh giờ theo `server_time` rồi ký lại; `409 replay` thì `seq = max(seq, last_seq) + 1`.
- **Watchdog** 60 s (task WDT) tự reset nếu vòng lặp đứng; 12 giờ không liên lạc được server dù Wi-Fi báo nối thì tự khởi động lại.
- **Wi-Fi**: tự nối lại với backoff, không ghi flash mỗi lần nối (`WiFi.persistent(false)`).

## OTA: quy trình phát hành

Thiết bị hỏi `GET /v1/ota/check?current=<FW_VERSION>` khi khởi động (sau lần liên lạc thành công đầu) và mỗi ~6 giờ.

**Định dạng chữ ký (ECDSA thay vì Ed25519 vì mbedtls trên chip không có Ed25519):**
ECDSA **P-256 (secp256r1) / SHA-256**, ký lên **toàn bộ nội dung file `.bin`** (tương đương ký digest SHA-256 của nó);
chữ ký mã hóa **DER** (ASN.1 `SEQUENCE{r,s}`, 70–72 byte) rồi viết **hex thường** (140–144 ký tự) vào trường `signature`.
`sha256` trong manifest là hex thường (64 ký tự) của SHA-256 của file `.bin`.

Quy trình chip: tải qua HTTPS (xác thực chứng chỉ, chỉ `https://`, độ dài phải rõ và vừa khe OTA) → ghi thẳng vào khe OTA kia bằng `Update`,
tính SHA-256 song song → đối chiếu `sha256` **và** kiểm chữ ký bằng `keys/ota_public.pem` (nhúng lúc build) →
**chỉ khi cả hai đúng** mới `Update.end()` (đặt khe khởi động) và khởi động lại. Sai một trong hai: `Update.abort()`, giữ bản đang chạy.

Phát hành bản mới:

```bash
# 1. (một lần) tạo khóa; SAO LƯU keys/private/ota_private.pem ngoại tuyến, mất nó là hết đường OTA cho máy đã giao
tools/gen_ota_keys.sh && git add keys/ota_public.pem   # chỉ commit khóa CÔNG KHAI

# 2. tăng AUHONO_FW_VERSION trong platformio.ini rồi build
pio run -e esp32c3            # -> .pio/build/esp32c3/firmware.bin

# 3. ký (cần: pip install cryptography); in sha256, chữ ký và câu lệnh SQL
python3 tools/ota_sign.py .pio/build/esp32c3/firmware.bin \
    --key keys/private/ota_private.pem --pub keys/ota_public.pem \
    --version 1.0.1 --url https://<kho-luu-tru>/auhono/firmware-1.0.1.bin

# 4. tải firmware.bin lên đúng URL https đó (R2/S3/GitHub Releases...), rồi chạy câu INSERT in ra:
npx wrangler d1 execute auhono --remote --command "INSERT INTO firmware_releases (...) VALUES (...);"
```

Server trả bản có `created_at` mới nhất; máy có `FW_VERSION` khác sẽ cập nhật. Thử trên **một máy** trước khi để cả lô nhận.
Tự kiểm chữ ký độc lập bằng openssl: `openssl dgst -sha256 -verify keys/ota_public.pem -signature sig.der firmware.bin`
(`sig.der` là chữ ký hex giải ra nhị phân).

**Rollback** (giới hạn của Arduino core): sdkconfig của core 2.0.17 có `CONFIG_APP_ROLLBACK_ENABLE=y`. Mặc định core tự "xác nhận" bản mới ngay khi khởi động
nên rollback vô nghĩa; firmware ghi đè `verifyRollbackLater()` để dời xác nhận tới lần liên lạc server thành công đầu tiên
(`esp_ota_mark_app_valid_cancel_rollback()`). Nếu bản mới không liên lạc được server trong 15 phút, nó tự
`esp_ota_mark_app_invalid_rollback_and_reboot()`. Nếu bản mới **treo/reset liên tục** trước khi xác nhận, bootloader quay về bản cũ.
Chưa kiểm chứng trên chip thật: bootloader tiền biên dịch của core có bật rollback hay không nên thử một lần bằng cách nạp OTA một bản cố tình hỏng.
Rollback **không** chống hạ cấp: máy chủ bị chiếm có thể đẩy một bản cũ nhưng đã ký hợp lệ.

## Bộ nhớ và mòn flash

- RAM: bộ đệm số đo 1440 × 8 B = **11,5 KB** (24 giờ). Nằm trong RAM nên **mất khi mất điện/khởi động lại** (thiết bị dùng chung điện với tủ:
  mất điện thì server thấy im lặng, đúng thiết kế). Mỗi kết nối TLS cần thêm ~40–70 KB heap tạm (gồm ~17 KB nạp bộ CA).
- Flash: ảnh ~1 MB, mỗi khe OTA 1,94 MB (`partitions.csv`). Còn ~48 KB chưa dùng.
- Mòn flash: `seq` không ghi mỗi request. Ghi "trần" `seq` (dự trữ 64 số) **1 lần/64 request + 1 lần mỗi lần khởi động**
  (~3–5 lần/ngày). Sau khi khởi động lại `seq` nhảy vọt qua trần (khoảng trống chấp nhận được, server chỉ cần tăng nghiêm ngặt).
  Ngưỡng chỉ ghi khi server đổi. Wi-Fi chỉ ghi khi chủ quán lưu cấu hình. NVS tự cân bằng mòn.
- Đồng hồ thiết bị không có RTC: sau mỗi lần khởi động phải đồng bộ lại; trong lúc chưa có giờ, số đo bị bỏ.

## Bảo mật (tóm tắt)

- Mọi request có ký HMAC-SHA256 đúng PROTOCOL.md; body được ký chính là các byte được gửi (test xác nhận).
- HTTPS bắt buộc, xác thực chuỗi chứng chỉ bằng `certs/roots.pem`. **Lưu ý**: core Arduino-ESP32 2.0.x biên dịch mbedtls không có `HAVE_TIME_DATE`
  nên **không kiểm hạn chứng chỉ** (vẫn kiểm chuỗi tin cậy, tên miền, chữ ký). Đổi lại TLS chạy được cả khi chưa có giờ.
- Khóa thiết bị chỉ ở phân vùng `ident`, mở chế độ chỉ đọc lúc chạy, không in ra log, xóa khỏi biến toàn cục sau khi nạp vào `Signer`.
- OTA: chỉ nhận bản ký bằng khóa bí mật của bạn (xem trên). Cổng cấu hình là Wi-Fi **mở** trong lúc cấu hình: người đứng gần có thể
  thay Wi-Fi của thiết bị khi cổng đang mở (chỉ làm thiết bị offline, không lấy được số đo/khóa). Cổng chỉ mở khi chưa cấu hình,
  mất Wi-Fi > 20 phút, hoặc khi giữ nút; luôn tự đóng.

## Thử ở nhà (cuối tuần 2 của kế hoạch)

Đặt đầu dò trong tủ lạnh nhà, để thiết bị ngoài tủ. Theo dõi log serial (`pio device monitor`) và dữ liệu trên server (`/v1/devices/:id/readings`).

| Thử nghiệm                                   | Cần thấy trên thiết bị                                                | Cần thấy trên server                                                                 |
|----------------------------------------------|-----------------------------------------------------------------------|--------------------------------------------------------------------------------------|
| Chạy bình thường 30 phút                     | Đèn sáng liên tục; log không lỗi                                       | Số đo mỗi phút, đến theo gói 5 phút; `last_seen` mới; `firmware` = `FW_VERSION`      |
| **Rút điện tủ** (thiết bị cắm chung ổ)       | Thiết bị tắt theo (đúng thiết kế); cắm lại: nhanh chóng sáng liên tục  | Im lặng > 15 phút → cảnh báo mất kết nối "có thể mất điện"; có điện lại → "đã ổn"     |
| **Tắt bộ phát Wi-Fi** 10–20 phút, bật lại   | Đèn nháy chậm; vẫn đo và giữ trong RAM; Wi-Fi về thì gửi bù hết (gói 20, cũ nhất trước), rồi sáng liên tục | Có khoảng trống rồi số đo được bù đúng mốc thời gian (không trùng, không mất); nếu tắt > 15 phút có cảnh báo mất kết nối rồi báo ổn lại |
| Tắt Wi-Fi > 20 phút                          | Xuất hiện Wi-Fi `Auhono-XXXX` (đèn nháy nhanh); Wi-Fi về vẫn tự nối lại sau khi cổng tự đóng (10 phút) hoặc lưu lại mạng | —                                                                                     |
| **Mở cửa tủ thật lâu** (>15 phút)            | Đèn sáng liên tục; nhiệt độ vượt ngưỡng → gửi ngay (≤ 1 lần/phút)      | Số đo vượt ngưỡng đến gần như tức thì; cảnh báo chỉ sau khi vượt liên tục đủ `breach_minutes`; đóng cửa → "đã ổn" |
| Rút đầu dò DS18B20                           | Log "bo so do loi"; sau 3 phút đèn "sáng tắt ngắn"; **không có số đo -127 trên server** | Số đo ngừng đến → coi như im lặng; cắm lại thì đèn về bình thường                      |
| Đổi mật khẩu Wi-Fi nhà                       | Nháy chậm; sau 20 phút mở cổng cấu hình; hoặc giữ nút 5 giây          | —                                                                                     |
| Đổi ngưỡng trên Mini App                     | Sau lần gửi kế tiếp, log nhận ngưỡng mới                              | `config` trong phản hồi đổi theo                                                     |
| Lệch giờ / xóa flash                         | Log `[time]`; tự chỉnh giờ, `seq` tự nhảy qua `last_seq`               | Không có 401/409 kéo dài; máy vẫn nhận số đo                                         |
| OTA thử (`1.0.1`)                            | Log `[ota] co ban moi ...` rồi khởi động lại; firmware sai chữ ký thì log `SAI chu ky: huy` và giữ bản cũ | `firmware` của thiết bị đổi sang bản mới                                             |

## Hạn chế đã biết

- Phần `src/` (glue phần cứng) khi viết **chưa được biên dịch với toolchain ESP32 thật** (môi trường phát triển không tải được PlatformIO registry) và chưa chạy trên chip; mới kiểm cú pháp với stub tự viết dựa trên header Arduino-ESP32 2.0.17. Hãy chạy `pio run -e esp32c3` và sửa lỗi (nếu có) trước khi nạp cho khách.
- Bộ đệm số đo nằm trong RAM: khởi động lại giữa lúc mất mạng thì mất số đo chưa gửi.
- WDT/rollback/đọc phân vùng `ident`/cổng cấu hình chưa thử trên phần cứng thật.
- WebServer của Arduino không giới hạn kích thước POST; chỉ kẻ ở trong tầm Wi-Fi lúc cổng mở mới gây được, và watchdog sẽ reset.
