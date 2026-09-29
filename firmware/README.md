# Auhono firmware (ESP32-C3)

Firmware cho cảm biến nhiệt độ tủ đông: đo bằng DS18B20, gửi lên server (`../server`) qua HTTPS có ký HMAC,
tự cập nhật OTA có kiểm chữ ký. Hợp đồng giao thức: [`../docs/PROTOCOL.md`](../docs/PROTOCOL.md) (firmware khớp từng byte).

## Cấu trúc

| Đường dẫn                   | Nội dung                                                                                 |
|-----------------------------|------------------------------------------------------------------------------------------|
| `lib/auhono_core/`          | **Logic thuần C++17, không phụ thuộc phần cứng, có test chạy trên máy** (ASan/UBSan): ký request, seq, bộ đệm số đo + giờ đơn điệu, giải mã DS18B20, bộ lọc nhiễu, backoff/phân loại lỗi, chính sách OTA/bảo trì/Wi-Fi, bộ phân tích HTTP/DNS/form của cổng cấu hình, trang HTML, LED, nút bấm... |
| `src/`                      | Phần "dán" với phần cứng: Wi-Fi, HTTPS, NVS, DS18B20 (OneWire), OTA, cổng cấu hình, LED, `main.cpp` (điều phối) |
| `include/config.h`          | Chân GPIO, nhịp đo/gửi, mọi thời hạn (timeout), giới hạn cổng cấu hình                    |
| `test/test_core/`           | Test Unity (`pio test -e native`), gồm vector giao thức trong PROTOCOL.md, kịch bản thực tế, fuzz |
| `partitions.csv`            | Bảng phân vùng 4 MB: 2 khe OTA + phân vùng `ident` giữ danh tính                          |
| `certs/roots.pem`           | Bộ CA gốc TLS mà thiết bị tin cậy (tạo bằng `tools/make_roots.py`)                        |
| `keys/ota_public.pem`       | Khóa công khai kiểm chữ ký OTA (**tự tạo**, xem bên dưới; khóa bí mật ở `keys/private/`, gitignore) |
| `tools/`                    | `flash_identity.py`, `gen_ota_keys.sh`, `ota_sign.py`, `make_roots.py`, `pio_pre.py`      |

## Đấu dây

```
ESP32-C3 SuperMini               DS18B20 chống nước (3 dây)
  3V3  ───────────┬───────────── đỏ   (VDD)
                  │
                [4,7 kΩ]         (điện trở kéo lên, đặt giữa DATA và 3V3)
                  │
  GPIO4 ──────────┴───────────── vàng/trắng (DATA)
  GND  ────────────────────────── đen  (GND)

  LED trạng thái : LED on-board, GPIO8 (C3 SuperMini: sáng khi mức THẤP)
  Nút            : nút BOOT on-board, GPIO9 (mức thấp khi nhấn)
  Nguồn          : cục sạc USB 5V >= 1A (không pin, không deep sleep); nên có tụ 470 µF gần bo nếu dây nguồn dài
```

**Chân strapping của ESP32-C3 (GPIO2, GPIO8, GPIO9) và lựa chọn mặc định:**

| Chân   | Dùng làm            | An toàn? | Ghi chú                                                                                                   |
|--------|---------------------|----------|-----------------------------------------------------------------------------------------------------------|
| GPIO4  | DATA DS18B20        | Có       | Không phải chân strapping. (GPIO4-7 có thêm chức năng JTAG nhưng dùng làm GPIO bình thường được.)          |
| GPIO8  | LED on-board        | Có       | Strapping (mức lúc reset quyết định in log ROM/nạp). LED nối 3V3 qua điện trở nên mức lúc reset vẫn = 1 = đúng yêu cầu. **Đừng** nối thêm tải kéo xuống GND vào GPIO8. |
| GPIO9  | Nút BOOT            | Có (chỉ đọc) | Strapping: **giữ THẤP lúc cấp điện/reset = vào chế độ nạp firmware** (thiết bị "chết" cho tới khi nhả). Sau khi chạy dùng bình thường làm đầu vào. Vì vậy: đừng nhấn giữ nút lúc cắm điện; nút kẹt trong vỏ hộp lúc cắm điện = máy không khởi động (kiểm tra vỏ hộp). |
| GPIO2  | (không dùng)        | —        | Strapping (phải ở mức cao/nổi lúc reset): không dùng cho cảm biến/LED/nút.                                  |
| GPIO18/19 | USB gốc (Serial) | —       | Không dùng cho việc khác (log qua USB CDC).                                                                |

Bo khác chân/khác mức LED thì đổi bằng build flag trong `platformio.ini` (`-DONEWIRE_PIN`, `-DLED_PIN`, `-DLED_ACTIVE_LOW`, `-DBUTTON_PIN`).
Cáp đầu dò dài (> 3 m) hoặc chạy cạnh dây động cơ máy nén: dùng cáp xoắn/bọc, điện trở kéo 4,7 kΩ đặt **sát bo**, cân nhắc giảm còn 2,2-3,3 kΩ.
Dây đầu dò luồn qua gioăng cửa tủ: đặt hộp thiết bị ngoài tủ, chỉ đầu dò trong tủ.

## Build và test

```bash
pip install platformio
cd firmware

pio test -e native        # test logic trên máy tính (không cần chip, không cần Arduino)
tools/gen_ota_keys.sh     # LẦN ĐẦU: tạo cặp khóa ký OTA (xem mục OTA)
# sửa platformio.ini: AUHONO_SERVER_URL (https://..., không có / cuối), AUHONO_FW_VERSION (dạng 1.0.1)
pio run -e esp32c3        # biên dịch
pio run -e esp32c3 -t upload   # nạp qua USB
pio device monitor        # xem log (115200)
```

Kiểm tra logic lõi không cần PlatformIO (đúng lệnh đã dùng khi rà soát):

```bash
g++ -std=gnu++17 -Wall -Wextra -Wpedantic -Wshadow -Werror -fsanitize=address,undefined \
    -I lib/auhono_core/src -I <thư mục unity> lib/auhono_core/src/auhono/*.cpp test/test_core/*.cpp <unity>/unity.c && ./a.out
```

- `pio run` dừng ngay với thông báo dễ hiểu (`tools/pio_pre.py`) nếu thiếu/hỏng `keys/ota_public.pem` (phải là khóa **công khai ECDSA P-256**, không phải khóa bí mật/RSA/P-384),
  `certs/roots.pem`, hoặc `AUHONO_FW_VERSION` không phải dạng số (`1.0.1`, `1.2.0-rc1`) — OTA so sánh phiên bản theo số nên chuỗi lạ sẽ không bao giờ cài được.
- `-DALLOW_INSECURE_TLS` (mặc định TẮT, đang comment trong `platformio.ini`) chỉ để thử với server cục bộ tự ký;
  bật lên là **không xác thực chứng chỉ server**, build in cảnh báo. Không bao giờ dùng cho máy giao khách.
- `-DCORE_DEBUG_LEVEL` phải là 0 cho bản giao khách (log thư viện Arduino có thể in SSID/header HTTP).
- `AUHONO_SERVER_URL` phải bắt đầu bằng `https://` và không có `/` cuối, sai là không biên dịch được (`static_assert`).
- Thay đổi CA: sửa `WANTED` trong `tools/make_roots.py` rồi chạy lại (dùng kho CA của hệ thống hoặc `--source cacert.pem`).
  Mặc định gồm 13 CA gốc (Let's Encrypt X1/X2, Google Trust Services R1/R4, GlobalSign, DigiCert G1/G2, Sectigo/USERTrust, SSL.com, Amazon).
  Server dùng CA khác thì thêm vào, nếu không thiết bị sẽ không kết nối được (xem "Chuỗi chứng chỉ và OTA cứu hộ" bên dưới).

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
   (xóa cả chip, mất danh tính). Cần xóa Wi-Fi thì xem "Nút bấm và reset về xuất xưởng".
4. Dán nhãn/QR (`qr_payload`) lên hộp, cùng **mật khẩu Wi-Fi cấu hình + mã QR Wi-Fi** (`ap_password`, `wifi_qr_payload` do `provision.ts` in). `flash_identity.py` chấp nhận các cột `ap_ssid`, `ap_password`, `wifi_qr_payload` trong CSV và **từ chối nạp** nếu chúng lệch giá trị suy ra từ khóa (dòng CSV sai); kiểm bằng `python3 tools/test_flash_identity.py`. Mở log: `Auhono fw 1.0.0, thiet bi AUH-000001`. Thiếu danh tính thì đèn nháy 3 lần liên tục.
   Danh tính hỏng/toàn 0/toàn 0xFF được coi là thiếu (không bao giờ dùng khóa rác); phân vùng `ident` **không bao giờ bị firmware xóa**.

> Chưa bật mã hóa flash / secure boot. Ai có chip trong tay đọc được khóa qua cổng nạp. Với lô thử nghiệm thì chấp nhận;
> trước khi bán đại trà nên bật flash encryption + secure boot (khi đó cần xem lại `partitions.csv` và quy trình OTA).

## Cấu hình Wi-Fi (chủ quán, không cần người hỗ trợ)

1. Cắm điện lần đầu: thiết bị phát Wi-Fi tên `Auhono-XXXX` (4 ký tự cuối của mã thiết bị) **có mật khẩu WPA2**, đèn nháy nhanh.
   Mật khẩu (10 ký tự) và mã QR Wi-Fi in trên **tem dán hộp** cùng mã kích hoạt. Thiết bị tự suy ra mật khẩu từ khóa của nó
   (`HMAC-SHA256(device_key, "ap-password:v1")`, xem `docs/PROTOCOL.md`), nên không cần nạp thêm gì lúc ráp máy.
2. Điện thoại: quét mã QR Wi-Fi bằng camera (hoặc chọn `Auhono-XXXX` rồi gõ mật khẩu trên tem). Sau khi vào, trang cấu hình tự bật (nếu không, mở `http://192.168.4.1`).
   Nếu điện thoại báo "Wi-Fi không có Internet", chọn **giữ kết nối** (đó là bình thường, thiết bị chỉ phát trang cấu hình).
   **Mất tem?** Chủ quán xem lại mật khẩu trong app (màn hình cài đặt thiết bị, `GET /v1/devices/:id/setup`, chỉ chủ thiết bị thấy).
3. Chọn Wi-Fi của quán (danh sách quét, hoặc gõ tay nếu mạng ẩn) và nhập mật khẩu → "Lưu và kết nối".
   Trang ghi rõ **chỉ Wi-Fi 2.4 GHz**. Mã thiết bị hiển thị trên trang.
4. Thiết bị tắt Wi-Fi cấu hình và kết nối; đèn sáng liên tục là xong.

Khi nào cổng cấu hình mở lại **mà không cần cáp/nút** (chủ quán đổi mật khẩu/đổi modem, có thể không có mặt):
- mất Wi-Fi đã lưu liên tục **20 phút** (đủ lâu để router khởi động lại sau mất điện, 2-10 phút, mà không mở nhầm);
- hoặc **5 phút** nếu router vẫn phát nhưng liên tục từ chối kết nối (dấu hiệu đổi mật khẩu — router đang sống nên không phải mất điện);
- hoặc khi giữ nút BOOT **5 giây** (đèn chuyển sang nháy nhanh).

Trong lúc cổng mở, thiết bị **vẫn tiếp tục thử nối Wi-Fi đã lưu** (không bị "đóng băng"); chỉ tạm dừng thử nối khi có điện thoại đang dùng AP hoặc đang quét (vì nối/quét làm AP đổi kênh, rớt điện thoại).
Trang cấu hình hiện lý do chưa nối được: **"không tìm thấy Wi-Fi" (sai tên/modem tắt/chỉ 5 GHz)** hay **"bị từ chối: có thể sai mật khẩu"**, và đèn LED cũng phân biệt hai trường hợp này (bảng dưới).
Cổng tự đóng: sau **10 phút** không ai dùng (trần 30 phút), hoặc ~30 giây sau khi Wi-Fi nối lại nếu cổng tự mở và không ai đang cấu hình. Đóng xong thì thử tiếp Wi-Fi đã lưu, **không khởi động lại** nên giữ được số đo trong RAM.
Chưa có Wi-Fi nào được lưu thì cổng mở cho tới khi được cấu hình (thiết bị chưa làm gì khác được).

Giới hạn/chuẩn: SSID ≤ **32 byte UTF-8** (tính theo byte, không theo ký tự: tối đa 10 chữ có dấu 3 byte hoặc 8 emoji), mật khẩu WPA2 8–63 ký tự ASCII (để trống = mạng mở), mạng ẩn nhập tay.
Chọn mạng từ danh sách gửi SSID dạng hex nên SSID không phải UTF-8 cũng nối được đúng.

## Đèn LED

| Đèn                                           | Nghĩa                                                          | Việc cần làm                                        |
|-----------------------------------------------|----------------------------------------------------------------|-----------------------------------------------------|
| Nháy **rất nhanh** (10 lần/giây)              | Đang giữ nút ≥ 15 s: **nhả nút bây giờ sẽ xóa Wi-Fi đã lưu**   | Nhả nút để xóa; buông sớm hơn (trước 15 s) để hủy    |
| Nháy **nhanh** (5 lần/giây)                   | Đang ở chế độ cấu hình Wi-Fi (AP `Auhono-XXXX`)                 | Kết nối điện thoại vào Wi-Fi đó, nhập Wi-Fi của quán |
| Nháy **chậm** (1 s sáng / 1 s tắt)            | Đang kết nối Wi-Fi, hoặc chưa gửi thành công lần nào           | Chờ ~1–2 phút (router có thể đang khởi động lại)      |
| **1 nháy ngắn** mỗi 2 s                       | **Không thấy Wi-Fi đã lưu**: sai tên / modem tắt / mạng chỉ 5 GHz | Kiểm tra modem; bật băng tần 2.4 GHz                  |
| **1 nháy dài + 1 nháy ngắn**                  | Thấy Wi-Fi nhưng **bị từ chối** (sai/đổi mật khẩu)              | Chờ cổng cấu hình tự mở (5 phút) hoặc giữ nút 5 s    |
| **Sáng liên tục**                             | Trực tuyến, lần gửi gần nhất thành công                        | Bình thường                                         |
| **Nháy đôi** (hai nháy ngắn rồi nghỉ)         | Có Wi-Fi nhưng server từ chối / lỗi / lệch giờ / bị giới hạn tốc độ | Xem log; kiểm tra thiết bị có bị thu hồi, server sống |
| Sáng, **tắt ngắn** mỗi ~1,5 s ("nháy ngược")  | **Lỗi đầu dò**: 3 chu kỳ đo liên tiếp hỏng (đứt dây, tuột giắc, thiếu trở kéo, nhiễu nặng) | Kiểm tra dây DS18B20 và điện trở 4,7 kΩ. Sau 5 phút lỗi máy gửi **nhịp tim** mỗi 5 phút nên server báo riêng "lỗi cảm biến" (không còn lẫn với "mất kết nối"). |
| **3 nháy ngắn** rồi nghỉ                      | Chưa nạp danh tính (mã + khóa)                                 | Chạy `tools/flash_identity.py`                       |

Thứ tự ưu tiên: đang giữ nút xóa > thiếu danh tính > cấu hình > lỗi đầu dò > chưa có Wi-Fi (phân biệt lý do) / chưa gửi > server lỗi > bình thường.
Khi đầu dò hỏng và Wi-Fi cũng hỏng, đèn báo lỗi đầu dò trước (sửa được ngay tại chỗ); sửa xong sẽ hiện tiếp trạng thái Wi-Fi.

## Nút bấm và reset về xuất xưởng

- Giữ nút BOOT **5 giây**: mở cổng cấu hình Wi-Fi.
- Tiếp tục giữ tới **15 giây** (đèn nháy rất nhanh) rồi **NHẢ**: xóa Wi-Fi đã lưu (giữ danh tính, ngưỡng, seq), rồi mở cổng cấu hình. Xóa chỉ xảy ra **lúc nhả nút** sau khi giữ 15–60 s.
- Chống bấm nhầm/kẹt: nút đang bị nhấn ngay lúc bật nguồn thì bỏ qua cho tới khi nhả; nút kẹt (giữ > 60 s hoặc không bao giờ nhả) **không bao giờ xóa gì** (chỉ có thể mở cổng cấu hình, vô hại).
- Xóa hẳn dữ liệu người dùng bằng dòng lệnh (giữ danh tính, ngưỡng, seq): `python -m esptool --chip esp32c3 erase_region 0x9000 0x5000`
  (phân vùng `nvs`). Danh tính ở `ident` nên không mất.

## Hoạt động

- **Đo** mỗi 60 s: đọc thẳng scratchpad DS18B20 và kiểm tra chặt (CRC, byte cố định, 85 °C lúc cấp điện, dải -55…125). Số đo hỏng/rác bị **bỏ**, không bao giờ gửi. Thêm **bộ lọc gai nhiễu**: số đo nhảy > 5 °C so với số trước bị đo lại sau 2 s;
  khớp lần đo lại = thay đổi thật (mở cửa, máy nén hỏng: báo sau ~2 s), không khớp = nhiễu và bị loại (xem bảng tình huống). Số đo có dấu thời gian **đơn điệu** (giây từ lúc khởi động), đổi sang giờ unix lúc gửi.
- **Nhịp tim và chẩn đoán (`diag`)**: mọi gói kèm `diag` = `{"sensor":"ok|fault","fault_s":<giây từ số đo hợp lệ cuối>,"rst":"<lý do reset>","rssi":<dBm -120..0>,"heap":<byte trống>,"up":<giây chạy>}` (đúng thứ tự khóa đó; `rst` ∈ `poweron|ext|sw|panic|wdt|deepsleep|brownout|sdio|unknown`).
  Không có `diag` thì body giữ nguyên byte như giao thức cũ. Nếu **≥ 5 phút không có số đo hợp lệ** (đứt dây, cảm biến hỏng, bộ lọc nhiễu loại liên tục; tính từ lúc khởi động nếu chưa có số đo nào) và bộ đệm rỗng, máy gửi
  **nhịp tim** `{"fw":..,"readings":[],"diag":{"sensor":"fault","fault_s":...}}` mỗi 5 phút theo đúng lịch của gói định kỳ (trễ ngẫu nhiên đầu tiên, backoff khi lỗi). Còn số đo trong bộ đệm thì gói số đo bình thường đi trước. Gói rỗng chỉ gửi đúng một request, 400/413 không chia đôi hay bỏ gì.
  Nếu server từ chối gói số đo có `diag`, máy gửi lại **cùng gói không kèm diag** (lỗi do diag không được làm mất số đo). Nhịp tim tính là "đã liên lạc server". Đầu dò đọc lại được thì trở về gói số đo bình thường (diag `sensor:"ok"`).
- **Gửi** gói định kỳ mỗi 5 phút, ≤ 20 số đo/gói, cũ nhất trước, tối đa 6 gói/20 s mỗi lần (còn tồn thì 2 s sau gửi tiếp: vòng lặp chính không bị chặn cả phút). Số đo vượt ngưỡng `config.min_c/max_c` (server trả về, cache trong NVS;
  mặc định -40/-18 °C tới khi có phản hồi đầu) thì gửi **ngay**, tối đa 1 lần/60 s. Lần gửi đầu sau khởi động trễ ngẫu nhiên 0–20 s theo từng máy (nhiều máy khởi động cùng lúc sau mất điện không đập server cùng lúc).
- Số đo được xóa khỏi RAM **chỉ sau khi server trả 200**. Server từ chối cả gói (400/413): **chia đôi gói** để tìm số đo "độc", chỉ bỏ số đo bị từ chối khi gửi riêng lẻ (tối đa 2 số đo/lần), còn lại giữ và thử chậm — một lần 400 thoáng qua không xóa được 24 giờ dữ liệu.
  Lỗi mạng/5xx: backoff **30 s → 1 → 2 → 5 phút** ±20% ngẫu nhiên. Lỗi dai dẳng (401 thu hồi/sai khóa, 429/Cloudflare 1015, 403, 404, 3xx): backoff **5 → 10 → 20 → 30 → 60 phút**. Số đo cũ hơn ~24 giờ bị bỏ (server cũng bỏ); không bao giờ gửi số đo ở tương lai.
- **Đồng hồ**: NTP (`pool.ntp.org`, `time.google.com`, `time.cloudflare.com`). **Vẫn đo và giữ số đo khi chưa có giờ** (tối đa 24 giờ gần nhất), gửi bù ngay khi có giờ (đổi từ giờ đơn điệu sang giờ unix theo đồng hồ lúc gửi). NTP im lặng 20 s (router chặn UDP/123)
  thì hỏi `GET /v1/time` qua HTTPS đã xác thực (backoff); `401 clock_skew` thì chỉnh giờ theo `server_time` rồi **dựng lại body** với giờ mới rồi ký lại; `409 replay` thì `seq = max(seq, last_seq) + 1`.
  Giờ chỉ được chấp nhận trong [2025-01-01, 2100).
- **Watchdog** 120 s (task WDT, panic → reset) bao trùm mọi thao tác chặn; thời hạn từng bước: kết nối TCP 8 s, bắt tay TLS 12 s, chờ tiêu đề 10 s, đọc body 8 s (DNS của lwIP tối đa ~15 s). Chuỗi cứu hộ khi Wi-Fi báo nối mà lâu không liên lạc được server:
  30 phút → ngắt/nối lại Wi-Fi; 2 giờ → khởi động lại driver Wi-Fi; 12 giờ → khởi động lại (có ghi lý do). Khởi động lại theo kế hoạch: xem "Khởi động lại có kế hoạch".
- **Wi-Fi**: tự nối lại với backoff 10 s → 60 s (±20%), không ghi flash mỗi lần nối (`WiFi.persistent(false)`), lớp tự-nối-lại của Arduino tắt để nhịp thử do firmware điều khiển.

## Khởi động lại có kế hoạch

Bộ đệm số đo nằm trong RAM nên khởi động lại = mất số đo chưa gửi. Vì vậy:
- **Định kỳ 7 ngày** chỉ khi *rảnh*: không tồn số đo (≤ 2), lần gửi gần nhất thành công, không đang vượt ngưỡng/cấu hình/OTA; **14 ngày** thì bất kể tồn đọng (trừ đang có báo động). Lý do: chống phân mảnh heap do TLS lặp lại/rò rỉ tích lũy, tránh số học `millis()` 32 bit quá gần mốc tràn 24,8/49,7 ngày.
- **Heap thấp**: mỗi 30 s kiểm; không đủ mở TLS (≥ 56 KB trống và khối liền ≥ 20 KB) liên tục 10 phút, hoặc nguy kịch (< 40 KB / khối < 18 KB) 3 lần liên tiếp → khởi động lại. Mỗi request kiểm heap **trước** khi mở TLS và thất bại sớm nếu không đủ.
- Mọi lần khởi động lại **chủ động** ghi lý do vào NVS (`dinh ky`, `heap thap`, `lau khong lien lac`, `cai OTA`, `rollback`) và log ở lần khởi động sau cùng với lý do reset của chip (`cap dien`, `BROWNOUT`, `watchdog`, `PANIC`...).
- Nếu lần khởi động trước là **BROWNOUT** (cục sạc yếu), lần chạy này tự giảm công suất phát Wi-Fi xuống 8,5 dBm (dòng đỉnh thấp hơn) và log gợi ý đổi sạc/thêm tụ. Có thể giảm thường trực bằng `-DAUHONO_WIFI_TX_POWER=WIFI_POWER_11dBm`.

## OTA: quy trình phát hành

Thiết bị hỏi `GET /v1/ota/check?current=<FW_VERSION>` sau lần liên lạc thành công đầu và mỗi ~6 giờ (bản mới chờ xác nhận thì hỏi ngay sau ~30 s, xem Rollback).

**Định dạng chữ ký (ECDSA thay vì Ed25519 vì mbedtls trên chip không có Ed25519):**
ECDSA **P-256 (secp256r1) / SHA-256**, ký lên **toàn bộ nội dung file `.bin`** (tương đương ký digest SHA-256 của nó);
chữ ký mã hóa **DER** (ASN.1 `SEQUENCE{r,s}`, 70–72 byte) rồi viết **hex thường** (140–144 ký tự) vào trường `signature`.
`sha256` trong manifest là hex thường (64 ký tự) của SHA-256 của file `.bin`.

Quy trình chip, theo thứ tự (mọi bước sai đều **hủy, giữ bản đang chạy**):
1. **Phiên bản phải MỚI HƠN** bản đang chạy (so sánh theo số: `1.0.10 > 1.0.9`; `1.0.0-rc1 < 1.0.0`). Server đề nghị bản cũ hơn/bằng thì bỏ qua — chống hạ cấp và phát lại ảnh cũ. Muốn "lùi" một bản xấu thì phát hành bản có số **cao hơn**.
2. Máy **gửi nốt số đo đang chờ trước khi kiểm tra OTA** (qua kênh thường, đã xác thực), rồi **hoãn** nếu vẫn còn số đo chưa gửi, đang có số đo vượt ngưỡng, lần gửi gần nhất lỗi, mới khởi động < 2 phút, cổng cấu hình đang mở, hoặc heap thấp: gửi/cảnh báo trước, cài sau (hỏi lại sau 5 phút). Trong lúc tải, máy vẫn đo và nháy đèn; **có số đo vượt ngưỡng thì HỦY tải** để ưu tiên cảnh báo; tải tối đa 4 phút.
3. Tải qua HTTPS (xác thực chứng chỉ). Theo chuyển hướng 301/302 **cùng giao thức https** (tối đa 4 lần; R2/GitHub Releases hay chuyển hướng; không bao giờ hạ xuống http). Bắt buộc có `Content-Length`, ảnh phải vừa khe OTA (1,94 MB).
4. Đọc **36 byte đầu** kiểm trước khi ghi flash: magic `0xE9`, số segment, `chip_id` = ESP32-C3, dung lượng flash ≤ của chip đang chạy, có `esp_app_desc`. Ảnh sai chip/HTML 404 bị loại mà không tốn một lần xóa flash.
5. Ghi thẳng vào khe OTA kia bằng `Update`, tính SHA-256 và dò nhãn phiên bản song song. Đối chiếu **sha256** VÀ **chữ ký** (khóa nhúng lúc build, kiểm đúng đường cong P-256) VÀ **nhãn phiên bản `AUHONO-FWVER:x.y.z;` nhúng trong ảnh** (được ký cùng ảnh): phải bằng `version` trong manifest và mới hơn bản đang chạy.
   Nhãn trong ảnh là thứ chặn kẻ chiếm server/kho lưu trữ dán số phiên bản mới lên ảnh cũ đã ký (giao thức hiện chỉ ký nội dung ảnh, không ký số phiên bản).
6. Ghi **sổ cài** (NVS, có CRC) rồi mới `Update.end()` (đặt khe khởi động; `esp_ota_set_boot_partition` xác thực lại toàn bộ ảnh) và khởi động lại. Không ghi được sổ thì không cài.
   Sổ cài chống **vòng lặp OTA**: một phiên bản đã cài 3 lần mà không lần nào được xác nhận thì ngừng đề nghị lại (không tải lại mỗi lần khởi động, không mài mòn khe flash) cho tới khi server đưa ra bản khác.

Phát hành bản mới:

```bash
# 1. (một lần) tạo khóa; SAO LƯU keys/private/ota_private.pem ngoại tuyến, mất nó là hết đường OTA cho máy đã giao
tools/gen_ota_keys.sh && git add keys/ota_public.pem   # chỉ commit khóa CÔNG KHAI

# 2. tăng AUHONO_FW_VERSION trong platformio.ini (dạng số: 1.0.1) rồi build
pio run -e esp32c3            # -> .pio/build/esp32c3/firmware.bin

# 3. ký (cần: pip install cryptography); in sha256, chữ ký và câu lệnh SQL. Script từ chối ký nếu nhãn phiên bản
#    trong ảnh khác --version, sai chip, hoặc thiếu esp_app_desc (bắt lỗi quên đổi phiên bản/ký nhầm file)
python3 tools/ota_sign.py .pio/build/esp32c3/firmware.bin \
    --key keys/private/ota_private.pem --pub keys/ota_public.pem \
    --version 1.0.1 --url https://<kho-luu-tru>/auhono/firmware-1.0.1.bin

# 4. tải firmware.bin lên đúng URL https đó (R2/S3/GitHub Releases...), rồi chạy câu INSERT in ra:
npx wrangler d1 execute auhono --remote --command "INSERT INTO firmware_releases (...) VALUES (...);"
```

Server trả bản có `created_at` mới nhất; máy có `FW_VERSION` cũ hơn sẽ cập nhật. Thử trên **một máy** trước khi để cả lô nhận.
Tự kiểm chữ ký độc lập bằng openssl: `openssl dgst -sha256 -verify keys/ota_public.pem -signature sig.der firmware.bin`
(`sig.der` là chữ ký hex giải ra nhị phân).

### Rollback (đã đối chiếu với nguồn Arduino-ESP32 2.0.17 và bootloader dựng sẵn)

- sdkconfig của core 2.0.17 có `CONFIG_APP_ROLLBACK_ENABLE=y` và `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y`; bảng dòng của `bootloader_dio_80m.elf` dựng sẵn (dùng khi PlatformIO dựng bootloader) **có** mã `PENDING_VERIFY → ABORTED → chọn khe cũ`
  (đã kiểm bằng `readelf --debug-dump=decodedline` đối chiếu `bootloader_utility.c` của ESP-IDF v4.4.7). Nghĩa là **rollback phần cứng của bootloader có bật**.
- Mặc định core tự "xác nhận" bản mới lúc khởi động (rollback vô nghĩa); firmware ghi đè `verifyRollbackLater()` (đúng liên kết C của hàm weak trong `esp32-hal-misc.c`) để dời xác nhận tới **lần liên lạc server thành công đầu tiên**
  (gửi số đo, hoặc chính yêu cầu kiểm tra OTA có ký — nên cảm biến hỏng không làm rollback oan).
- Lưu ý hành vi của bootloader: bản mới ở trạng thái chờ xác nhận mà bị **reset bất kỳ lý do gì** (kể cả cúp điện chớp) trước khi xác nhận → lần khởi động kế bootloader coi là hỏng và quay về bản cũ. Bản cũ sẽ được đề nghị lại (tối đa 3 lần nhờ sổ cài).
- Lớp **rollback mềm** (phòng khi bootloader không làm được, hoặc treo mà không reset): sổ cài đếm số lần khởi động của bản mới khi chưa xác nhận; quá 3 → `esp_ota_set_boot_partition(khe cũ)` rồi khởi động lại. Ngoài ra bản mới mà Wi-Fi đã nối 15 phút vẫn không liên lạc được server
  (hoặc 60 phút kể từ khi khởi động bất kể Wi-Fi) thì tự `esp_ota_mark_app_invalid_rollback_and_reboot()`; cúp điện router ngay sau OTA không làm rollback oan (chỉ đếm thời gian Wi-Fi đã nối).

### Chuỗi chứng chỉ và OTA cứu hộ

- Bộ CA gốc phủ chuỗi thực tế của Cloudflare (Universal SSL/`workers.dev`: Google Trust Services WE1/WR1 → GTS Root R4/R1 (cross-sign GlobalSign), Let's Encrypt E5/E6/R10/R11 → ISRG Root X2/X1, SSL.com 2022, Sectigo → USERTrust), Amazon (S3/R2 API), DigiCert (GitHub Releases).
  *Không kiểm được trực tiếp trên Internet thật từ môi trường phát triển* (proxy dựng lại TLS) — xem "chưa xác minh".
- Firmware 2.0.x của Arduino **không kiểm hạn chứng chỉ** (`CONFIG_MBEDTLS_HAVE_TIME_DATE` tắt, đã kiểm trong sdkconfig): CA gốc hết hạn không làm hỏng kết nối và TLS chạy được cả khi chưa có giờ. Đổi lại, chứng chỉ hết hạn/đã bị thu hồi vẫn được chấp nhận (chuỗi tin cậy, tên miền và chữ ký vẫn được kiểm).
- Rủi ro thật nhiều năm sau là **CA gốc bị thay bằng gốc không có trong bộ nhúng**. Khi đó mọi TLS xác thực đều hỏng, kể cả kiểm tra OTA — cách duy nhất để đưa bộ CA mới xuống máy.
  Lối thoát: sau **12 lần liên tiếp** thất bại vì *xác thực chứng chỉ* (~50 phút ở nhịp backoff 30 s → 5 phút), riêng bước **kiểm tra + tải OTA** chạy với `setInsecure()`. An toàn vì ảnh firmware được xác thực bằng chữ ký ECDSA độc lập với TLS, chỉ nhận phiên bản mới hơn, có nhãn phiên bản được ký;
  trong chế độ này thiết bị **không gửi số đo** và **không cho phép phản hồi chỉnh đồng hồ**. Bản OTA đó nhúng `certs/roots.pem` mới. (Chế độ này chỉ mở khi lỗi đúng là "certificate verify failed", không mở vì mất mạng thường.)
  Nên rà `roots.pem` mỗi năm/khi đổi nhà cung cấp chứng chỉ; các gốc trong bộ hết hạn 2028 (GlobalSign Root CA), 2031 (DigiCert G1), 2035–2046 (còn lại).

## Bộ nhớ và mòn flash

- RAM: bộ đệm số đo 1440 × 8 B = **11,5 KB** (24 giờ). Nằm trong RAM nên **mất khi mất điện/khởi động lại** (thiết bị dùng chung điện với tủ:
  mất điện thì server thấy im lặng, đúng thiết kế). Mỗi kết nối TLS cần thêm ~40–70 KB heap tạm (2 vùng liền ~16,6 KB cho bộ đệm mbedtls + ~20 KB nạp 13 CA).
- Flash: ảnh ~1 MB, mỗi khe OTA 1,94 MB (`partitions.csv`). Còn ~48 KB chưa dùng.
- Mòn flash (NVS: mục 32 B, trang 4 KB ~126 mục, phân vùng `nvs` 5 trang, ~100 000 chu kỳ xóa/sector). `seq` không ghi mỗi request: ghi "trần" (dự trữ 64 số) **1 lần/64 request + 1 lần trong request đầu sau mỗi lần khởi động**.
  Khởi động lại mà chưa gửi request nào (vòng brownout) thì **không ghi flash lần nào** (test `test_reboot_storm_without_uploads_writes_nothing`). 5 năm × 288 request/ngày × 3 lần khởi động/ngày = 525 600 request, 5 475 lần khởi động ≈ 11 000 lần ghi ≈ 87 lần xóa trang (~22 lần/sector; đo bằng mô phỏng); ngay cả 1000 khởi động/ngày cũng chỉ ~4 000 lần xóa/sector, còn xa 100 000.
  `seq` không bao giờ tới trần an toàn của JS (2^52). Ngưỡng ghi khi server đổi; Wi-Fi ghi khi chủ quán lưu (1 mục nguyên tử có CRC); sổ OTA ghi ≤ 5 lần/lần cập nhật; lý do khởi động lại ghi mỗi lần khởi động chủ động. NVS tự cân bằng mòn.
- Đồng hồ thiết bị không có RTC: sau mỗi lần khởi động phải đồng bộ lại; trong lúc chưa có giờ số đo vẫn được đo/giữ với giờ đơn điệu.
- Heap: hot path không dùng `String` của Arduino trừ URL ~70 B mỗi request (giải phóng ngay); body/JSON/URL dùng `std::string` giữ chỗ trước, buffer `char[]` cố định. Phân mảnh dài hạn được chặn bằng kiểm heap trước mỗi phiên TLS + khởi động lại có lý do (mục trên).

## Bảo mật (tóm tắt)

- Mọi request có ký HMAC-SHA256 đúng PROTOCOL.md; body được ký chính là các byte được gửi (test xác nhận), và **body được dựng lại sau mỗi lần chỉnh giờ** rồi mới ký lại.
- HTTPS bắt buộc, xác thực chuỗi chứng chỉ bằng `certs/roots.pem`; API **không theo chuyển hướng** (không bao giờ gửi chữ ký sang máy chủ khác); OTA chỉ theo chuyển hướng https.
- Khóa thiết bị chỉ ở phân vùng `ident`, mở chế độ chỉ đọc lúc chạy, không in ra log (log chỉ có mã thiết bị, mã lỗi, số đo, RSSI), xóa khỏi biến toàn cục sau khi nạp vào `Signer`. So sánh sha256/token bằng hàm thời gian không đổi.
  Không có lệnh nào qua serial đọc được NVS/khóa/mật khẩu Wi-Fi. Trang cấu hình không bao giờ hiện khóa hay điền lại mật khẩu.
- OTA: chỉ nhận bản ký bằng khóa bí mật của bạn, mới hơn bản đang chạy, nhãn phiên bản trong ảnh được ký (xem trên).
- **Cổng cấu hình là Wi-Fi WPA2-PSK** (CCMP), mật khẩu 10 ký tự suy ra từ khóa thiết bị (bảng chữ cái không có I/L/O/U). Người đứng gần **không vào được** nếu không có tem/QR nên không đổi được Wi-Fi của thiết bị.
  Bản phát hành **không bao giờ phát Wi-Fi mở**: thiếu danh tính/khóa (không suy ra được mật khẩu) thì **không mở AP**, đèn "3 nháy ngắn" và log `[portal] LOI ... KHONG mo Wi-Fi cau hinh`; sau `softAP()` firmware đọc lại cấu hình thật của driver (`esp_wifi_get_config`) và tắt AP nếu không phải WPA2-PSK.
  Mật khẩu chỉ nằm trong RAM, **không bao giờ in ra Serial/log và không có trên trang cấu hình** (trang chỉ hiện mã thiết bị). Đường AP mở chỉ tồn tại sau cờ phát triển `-DALLOW_OPEN_AP` (mặc định TẮT, `#warning` + cảnh báo của `pio_pre.py`).
  Lưu ý về `WiFi.softAP()` của Arduino-ESP32 2.0.17 (đã đọc `WiFiAP.cpp`): passphrase NULL/rỗng **âm thầm tạo AP mở**, passphrase dài 1–7 ký tự trả `false`, có mật khẩu thì authmode = WPA2-PSK và chỉ CCMP (tắt TKIP), kênh 1–13, tối đa 4 điện thoại; ta tự kiểm trước và sau (ở trên). Kênh: mặc định 1 và tự theo kênh STA khi đã nối router; không ẩn SSID (điện thoại cần thấy tên khi quét).
  Phát hiện captive portal sau khi vào AP WPA2 không đổi (phụ thuộc DHCP/DNS/HTTP, không phụ thuộc mã hóa Wi-Fi). Thời điểm mở AP không đổi (20 phút, hoặc 5 phút nếu router từ chối mật khẩu, hoặc giữ nút 5 s/15 s+nhả). Đã làm cứng thêm: bộ phân tích HTTP/DNS tự viết có giới hạn cứng (không cấp phát theo số client gửi; `WebServer`/`DNSServer` của Arduino không giới hạn và `DNSServer` tràn bộ đệm với gói dị dạng),
  chỉ lắng nghe trên IP của AP (không lộ ra LAN của quán), mỗi kết nối ≤ 6 s và tối đa 3 đồng thời, không JavaScript, mọi chuỗi động đều escape (SSID trong danh sách gửi dạng hex), CSP nghiêm ngặt, token phiên chống trang web khác tự gửi form.
  Cổng chỉ mở khi chưa cấu hình, mất Wi-Fi đã lưu, hoặc khi giữ nút; luôn tự đóng.

## Tình huống thực tế & cách máy xử lý

| # | Tình huống | Máy xử lý thế nào | Kiểm chứng |
|---|------------|-------------------|------------|
| 1 | **Cúp điện rồi có điện lại**, router mất 2–10 phút mới phát Wi-Fi/DHCP/DNS | Đo ngay lúc khởi động (không chờ giờ). Số đo mang **giờ đơn điệu**, đổi sang unix lúc gửi ⇒ số đo *trước NTP* (quan trọng nhất) **được gửi bù đúng giờ**. Wi-Fi thử lại 10→60 s (±20%), không mở cổng cấu hình trước 20 phút (5 phút nếu router từ chối mật khẩu). STA **không bị dừng** khi cổng mở. Lần gửi đầu trễ ngẫu nhiên 0–20 s. | test `readings_before_time_are_backdated`, `portal_does_not_pop_up_while_router_boots` |
| 2 | Brownout/reset lặp do cục sạc rẻ | Log lý do reset chip (`BROWNOUT`, `PANIC`, `watchdog`...); sau brownout giảm công suất Wi-Fi; **không ghi flash lúc khởi động**; khởi động không kịp gửi request = 0 lần ghi NVS. Tính toán mòn 5 năm ở mục "Bộ nhớ". | test `reboot_storm...`, `five_years...` |
| 3 | Mất điện đúng lúc ghi NVS / OTA / lưu Wi-Fi | Wi-Fi = **một bản ghi nguyên tử có CRC** (không còn SSID mới + mật khẩu cũ; đọc lên hỏng = "chưa cấu hình"); sổ OTA có CRC; seq là mục nguyên tử, sai lệch tự sửa bằng 409; OTA hai khe: chưa `Update.end()` thì khe đang chạy nguyên vẹn, bản ghi dở bị bỏ; phân vùng `nvs` hỏng thì tạo lại (không đụng `ident`). | test `creds_any_corruption...`, `ota_record_codec...` |
| 4 | `millis()` tràn 49,7 ngày; số học uint32; heap | Mọi mốc dùng `auhono::reached()` (trừ có dấu; mốc < 24,8 ngày); giờ số đo dùng `esp_timer` 64-bit (không tràn); khởi động lại định kỳ 7/14 ngày; kiểm heap (tổng + khối liền) trước mỗi TLS; heap thấp liên tục ⇒ khởi động lại **có lý do**. | test `deadline_helper...`, `button...rollover`, `upload_policy...wraparound`, `reboot_policy`, `heap_guards` |
| 5 | Đổi mật khẩu/đổi router, chủ quán vắng mặt | Cổng cấu hình tự mở sau 5 phút (router từ chối) / 20 phút (khác); STA vẫn thử trong lúc mở; tự đóng sau 10 phút không dùng hoặc khi Wi-Fi về; nút 5 s mở tay; trang + đèn báo "không thấy mạng" vs "sai mật khẩu". | `wifi_policy`, `led_wifi_failure_patterns...` |
| 6 | **Captive portal**: Android/iOS/Windows, DNS, POST, slowloris, XSS, SSID lạ | DNS bắt mọi tên (tự viết, có fuzz); mọi Host lạ/đường dẫn thăm dò (`generate_204`, `hotspot-detect.html`, `connecttest.txt`, `ncsi.txt`, `redirect`...) ⇒ **302 về `http://192.168.4.1/`** (không bao giờ giả 204/"Success"). POST ≤ 1024 B, dòng ≤ 200, header ≤ 1 KB/24, mỗi kết nối ≤ 6 s, ≤ 3 đồng thời, chỉ lắng nghe IP của AP. SSID escape mọi nơi, giới hạn theo **byte** (không theo ký tự), Unicode/emoji/dấu nháy/không-UTF-8 chạy đúng, mạng ẩn nhập tay, mạng mở (mật khẩu rỗng), WPA2 8–63. **AP cấu hình là WPA2-PSK** (mật khẩu suy ra từ khóa, in trên tem/QR): rủi ro "AP mở" đã đóng; mất tem thì chủ quán xem lại mật khẩu trong app (`/v1/devices/:id/setup`); thiếu danh tính ⇒ không mở AP. Phát hiện 5 GHz-only/WPA3-only: `NO_AP_FOUND` ⇒ "không thấy mạng + chỉ 2.4 GHz"; sai mật khẩu (`AUTH_FAIL`/`4WAY_HANDSHAKE_TIMEOUT`) ⇒ thông báo riêng. Trang có CSP, token chống gửi chéo. Wi-Fi công cộng có trang đăng nhập (200 HTML) ⇒ không phải `{"ok":true}` nên không bao giờ coi là thành công. | `t_portal_http.cpp`, `t_wifi.cpp` |
| 7 | DNS lỗi, mất DHCP, Wi-Fi có mà ISP chết, TLS treo, 5xx/429/HTML/redirect/gzip/chunked/cụt | Mọi lỗi = offline + backoff (5xx/mạng 30 s→5 phút; 401/429/403/404/3xx 5→60 phút). Mọi thao tác chặn có thời hạn, tổng < WDT 120 s; `Accept-Encoding: identity`, HTTP/1.0 (không chunked); body ≤ 2 KB, có thời hạn; JSON cụt/HTML/nhị phân không bao giờ là `Ok`. API không theo chuyển hướng. Mất IP ⇒ Wi-Fi coi là mất và nối lại; nối được mà 30 phút không liên lạc server ⇒ nối lại Wi-Fi, 2 giờ ⇒ khởi động lại driver, 12 giờ ⇒ khởi động lại. | `failure_classification`, `401_forever...`, `429_reply...` |
| 8 | 30 máy khởi động cùng lúc sau mất điện khu vực | Hạt giống riêng từng máy = băm(mã thiết bị, MAC) trộn với `esp_random()`; lần gửi đầu trễ 0–20 s; backoff ±20% độ mịn 0,1% (401 mức). | test `thundering_herd...` (30 máy, RNG phần cứng giống hệt) |
| 9 | NTP bị chặn, giờ nhảy | `GET /v1/time` qua TLS xác thực (backoff), `clock_skew` chỉnh + **dựng lại body**; số đo lưu giờ đơn điệu nên NTP nhảy không làm sai/đảo dấu thời gian; giờ chỉ nhận trong [2025, 2100); không bao giờ gửi số đo > 24 giờ (bỏ trước, biên 6 phút, đếm lại) hay ở tương lai (kẹp `unixNow`). Kênh OTA cứu hộ (không xác thực chứng chỉ) **không được** chỉnh giờ. | `clock_step...`, `wrong_year...`, `long_outage...`, `no_bulk_send...`, `untrusted_channel...` |
| 10 | DS18B20: đứt dây, rút/cắm lại, thiếu trở kéo, CRC, 85 °C, gai nhiễu, nhiều cảm biến | Đọc scratchpad trực tiếp: CRC + byte cố định (scratchpad toàn 0 — CRC hợp lệ, "0,0 °C" giả — bị loại) + 85 °C + dải; đọc lại 3 lần khi nhiễu; mất đầu dò ⇒ tự tìm lại (rút/cắm nóng). **Bộ lọc gai**: nhảy > 5 °C ⇒ đo lại sau 2 s; khớp số đo lại (thay đổi thật) ⇒ ghi ngay (báo sau ~2 s), gai đơn lẻ (0,0/+40) ⇒ loại, số đo đầu tiên sau khởi động cũng cần hai lần khớp. Nhiều cảm biến: dùng ROM nhỏ nhất, cảnh báo log. Lỗi đầu dò 3 chu kỳ ⇒ **LED "nháy ngược" + log**; sau **5 phút** không có số đo hợp lệ (đứt dây/rút đầu dò/nhiễu loại liên tục) ⇒ **nhịp tim** mỗi 5 phút (`readings: []` + `diag.sensor:"fault"`, `fault_s`) ⇒ server báo **"lỗi cảm biến"** riêng với "mất kết nối". Nhịp tim tính là đã liên lạc server (không kích hoạt nối lại Wi-Fi/rollback vì đầu dò hỏng, và cho phép OTA sửa máy). | `t_sensor.cpp`, `t_ap_diag.cpp` |
| 11 | Làm tròn/biên float→centi-độ | Nửa làm tròn ra xa 0 (đối xứng), −0,0 → 0, bão hòa int16, NaN → 0 (chỉ dùng sau khi qua kiểm hợp lệ), −55,0 và 125,0 đúng; khớp giải mã scratchpad với mọi giá trị 1/16 °C. | `celsius_to_centi_boundaries` |
| 12 | OTA: đứt/404/chuyển hướng/sai hash/sai chữ ký/cụt/quá lớn/sai flash; đang báo động; vòng lặp; hạ cấp; thiếu khóa lúc build | Xem mục "OTA": kiểm 36 byte đầu trước khi ghi flash; theo chuyển hướng https; sha256 + chữ ký + nhãn phiên bản trong ảnh; hoãn khi còn số đo/vượt ngưỡng (và hủy tải khi vừa vượt ngưỡng); sổ cài 3 lần; rollback phần cứng đã kiểm có bật + rollback mềm; `pio_pre.py` chặn thiếu/sai khóa; `ota_sign.py` chặn ký nhầm. | `t_ota.cpp` |
| 13 | Bảo mật: log, cổng, reset, so sánh khóa, chứng chỉ | Không in khóa/mật khẩu/token; trang không hiện khóa; reset xuất xưởng chỉ xóa Wi-Fi (danh tính giữ); không có đường đọc NVS qua serial; so sánh hằng thời gian; không khóa thử nghiệm trong `src/`; bộ CA 13 gốc + OTA cứu hộ cho ngày CA đổi. | xem "Bảo mật" |
| 14 | 401 mãi mãi, 409 lặp, 400/413 độc, 429 | 401/429/403/404/3xx ⇒ 5→60 phút (≈26 lần/ngày) + LED nháy đôi; 409 ≤ 3 lần/request rồi backoff; 400/413 ⇒ chia đôi gói, chỉ bỏ số đo độc riêng lẻ (≤ 2/lần), server từ chối tất cả ⇒ **giữ dữ liệu** và thử chậm (không xóa 24 giờ, không vòng lặp dồn dập). | `t_client.cpp`, `401_forever...` |
| 15 | Watchdog, driver Wi-Fi treo, khởi động lại định kỳ | WDT 120 s; mọi vòng chờ nuôi WDT; hạ driver Wi-Fi khi 2 giờ không liên lạc; khởi động lại định kỳ **7 ngày khi rảnh / 14 ngày bắt buộc**: đủ thưa để hầu như không mất số đo, đủ dày để chặn phân mảnh/rò rỉ tích lũy. | `reboot_policy`, `recovery_escalation` |
| 16 | UX: LED, chân strapping, nút | Bảng LED (9 mẫu, test kiểm không hai mẫu nào trùng); chân mặc định an toàn (xem "Đấu dây"); xóa Wi-Fi cần giữ 15 s **và nhả**, nút kẹt/đè lúc bật nguồn bị bỏ qua. | `led_...`, `button_...` |
| 17 | Khác: tràn số, tràn bộ đệm, vòng lặp vô hạn, rò rỉ | Fuzz ASan/UBSan cho JSON/phản hồi/manifest/HTTP/DNS/form/bộ đệm vòng (so với mô hình)/body; mọi vòng lặp có thời hạn; `Portal` giải phóng hết khi đóng; sự kiện Wi-Fi chỉ ghi 1 byte + bộ đếm (không khóa) từ tác vụ khác. | `t_fuzz.cpp`, `t_portal_http.cpp` |

## Thử ở nhà (cuối tuần 2 của kế hoạch)

Đặt đầu dò trong tủ lạnh nhà, để thiết bị ngoài tủ. Theo dõi log serial (`pio device monitor`) và dữ liệu trên server (`/v1/devices/:id/readings`).

| Thử nghiệm                                   | Cần thấy trên thiết bị                                                | Cần thấy trên server                                                                 |
|----------------------------------------------|-----------------------------------------------------------------------|--------------------------------------------------------------------------------------|
| Chạy bình thường 30 phút                     | Đèn sáng liên tục; log không lỗi                                       | Số đo mỗi phút, đến theo gói 5 phút; `last_seen` mới; `firmware` = `FW_VERSION`      |
| **Rút điện tủ** (thiết bị cắm chung ổ)       | Thiết bị tắt theo (đúng thiết kế); cắm lại: **đo ngay**, log `[time] da co gio, con N so do` rồi gửi bù | Im lặng > 15 phút → cảnh báo mất kết nối "có thể mất điện"; có điện lại → "đã ổn"; **số đo đầu tiên sau khi có điện xuất hiện đúng mốc** |
| **Rút điện cả modem + thiết bị cùng lúc**, cắm lại | Đèn nháy chậm hoặc "1 nháy ngắn" (modem chưa lên) tới 10 phút rồi sáng liên tục; **không** mở Wi-Fi `Auhono-XXXX` | Số đo trong lúc chờ modem được bù đúng mốc thời gian |
| **Tắt bộ phát Wi-Fi** 10–20 phút, bật lại   | Đèn "1 nháy ngắn"; vẫn đo và giữ trong RAM; Wi-Fi về thì gửi bù hết (gói 20, cũ nhất trước), rồi sáng liên tục | Có khoảng trống rồi số đo được bù đúng mốc thời gian (không trùng, không mất); nếu tắt > 15 phút có cảnh báo mất kết nối rồi báo ổn lại |
| Tắt Wi-Fi > 20 phút                          | Xuất hiện Wi-Fi `Auhono-XXXX` (đèn nháy nhanh); Wi-Fi về thì thiết bị tự nối lại và cổng tự đóng sau ~30 s | —                                                                                     |
| Đổi mật khẩu Wi-Fi nhà                       | Đèn "nháy dài + nháy ngắn"; sau 5 phút mở cổng cấu hình (trang ghi "có thể sai mật khẩu"); hoặc giữ nút 5 giây | —                                                                                     |
| Đổi modem sang 5 GHz-only                    | Đèn "1 nháy ngắn"; trang ghi "chỉ 2.4 GHz" (sau 20 phút hoặc giữ nút 5 s) | —                                                                                     |
| **Mở cửa tủ thật lâu** (>15 phút)            | Đèn sáng liên tục; nhiệt độ vượt ngưỡng → gửi ngay (≤ 1 lần/phút)      | Số đo vượt ngưỡng đến gần như tức thì; cảnh báo chỉ sau khi vượt liên tục đủ `breach_minutes`; đóng cửa → "đã ổn" |
| Rút đầu dò DS18B20                           | Log `[sensor] LOI: khong thay cam bien`; sau 3 phút đèn "sáng tắt ngắn"; **không có số đo -127/0,0/85 trên server** | Số đo ngừng đến → coi như im lặng; cắm lại thì tự nhận lại, đèn về bình thường          |
| Chạm/rung giắc đầu dò | Log `bo so do nhieu` hoặc số đo đo lại; không có gai trên biểu đồ | Không có điểm 0,0/+40 lẻ loi |
| Đổi ngưỡng trên Mini App                     | Sau lần gửi kế tiếp, log nhận ngưỡng mới                              | `config` trong phản hồi đổi theo                                                     |
| Lệch giờ / xóa flash                         | Log `[time]`; tự chỉnh giờ, `seq` tự nhảy qua `last_seq`               | Không có 401/409 kéo dài; máy vẫn nhận số đo, đúng mốc thời gian                       |
| OTA thử (`1.0.1`)                            | Log `[ota] co ban moi ...` rồi khởi động lại; firmware sai chữ ký thì log `SAI chu ky: huy` và giữ bản cũ; ép server đề nghị bản cũ hơn thì log `tu choi ha cap` | `firmware` của thiết bị đổi sang bản mới                                             |
| OTA bản cố tình hỏng (không liên lạc được server) | Sau ≤ 15 phút Wi-Fi nối (hoặc 60 phút) tự quay về bản cũ; máy vẫn hoạt động; log `[ota] ... quay ve ban cu` | `firmware` trở lại bản cũ; không cài lại quá 3 lần |

## Chưa xác minh trên phần cứng

Phần lõi `lib/auhono_core` có test chạy trên máy (ASan/UBSan). Phần `src/` **chưa được biên dịch bằng toolchain ESP32 thật** (PlatformIO registry bị chặn trong môi trường phát triển) và **chưa chạy trên chip**. Đã làm: kiểm cú pháp/kiểu (`g++ -fsyntax-only -Wall -Wextra -Wshadow`)
`src/*.cpp` với **header thật của Arduino-ESP32 2.0.17** (WiFi, WiFiClient/Server/Udp, WiFiClientSecure, HTTPClient, Update, Preferences, Print/Stream/String/IPAddress tải từ GitHub) + header thật ESP-IDF v4.4.7 (`esp_ota_ops`, `esp_system`, `esp_task_wdt`, `esp_timer`, `nvs`, `esp_wifi_types`) và header OneWire thật;
phần hạ tầng bên dưới (mbedtls, lwIP, freertos, `esp_partition`, `nvs_flash`, `esp_sntp`) dùng stub tự viết theo chữ ký đã biết. Hãy chạy `pio run -e esp32c3` và sửa lỗi (nếu có) trước khi nạp cho khách. Cần thử trên chip thật:

- **Toàn bộ biên dịch/liên kết**: embed `certs/roots.pem`/`keys/ota_public.pem` (`_binary_certs_roots_pem_start`), `verifyRollbackLater` liên kết C, nhãn `kFwVersionTag` không bị linker loại (kiểm bằng `strings firmware.bin | grep AUHONO-FWVER`), dung lượng ảnh, stack loop 16 KB.
- **Wi-Fi**: bỏ `setAutoReconnect` + nhịp thử tự điều khiển; chuyển STA → AP_STA có giữ kết nối STA không; sự kiện `STA_DISCONNECTED` và mã lý do thật (đặc biệt sai mật khẩu WPA2 ra `4WAY_HANDSHAKE_TIMEOUT`/`AUTH_FAIL`?), WPA3-only, mạng ẩn; DHCP của AP có phát DNS = 192.168.4.1 mặc định không (mọi ví dụ captive portal Arduino dựa vào điều này).
- **Cổng cấu hình**: popup "Đăng nhập Wi-Fi" trên Android (nhiều hãng), iPhone, Windows 10/11; `WiFiServer`/`WiFiUDP` chỉ bind IP AP; việc điện thoại có tự rời AP "không có Internet" không; quét Wi-Fi khi STA đang thử nối; token/cookie form.
- **HTTPS tới Cloudflare Workers/`workers.dev`**: HTTP/1.0 (`useHTTP10`) có được Cloudflare chấp nhận và trả `Content-Length` không; chuỗi chứng chỉ thực tế có nằm trong `roots.pem` (đặc biệt `workers.dev` và tên miền riêng); phát hiện lỗi chứng chỉ qua `lastError() == MBEDTLS_ERR_X509_CERT_VERIFY_FAILED` (-0x2700).
- **Rollback phần cứng**: rằng PlatformIO thực sự dựng bootloader từ `bootloader_dio_80m.elf` đã kiểm (không dùng bản khác) — sau một lần OTA thật, `esp_ota_get_state_partition()` phải trả `PENDING_VERIFY` (log `[ota] ban moi da duoc xac nhan` sau lần liên lạc đầu là dấu hiệu đúng).
- **OTA**: tải thật qua R2/GitHub (chuyển hướng), `Update`/`esp_ota_set_boot_partition` với ảnh của bạn, rollback phần cứng và mềm bằng một bản cố tình hỏng, OTA cứu hộ (mô phỏng bằng CA sai), `readAtLeast`/`tick` khi mạng chậm.
- **DS18B20**: `OneWire` 2.3.8 trên ESP32-C3 với Wi-Fi bật (bit-banging tắt ngắt), rút/cắm nóng, cáp dài nhiễu; độ tin cậy của ngưỡng lọc 5 °C/2 s với đầu dò thật trong tủ (ngưỡng đặt bảo thủ; đo lại tốn 2 s nên đặt thấp cũng không hại).
- **Heap thực tế**: các ngưỡng heap (≥ 56 KB trống + khối liền ≥ 20 KB để mở TLS; < 40 KB / < 18 KB là nguy kịch) là ước tính từ cấu hình mbedtls (`MBEDTLS_SSL_MAX_CONTENT_LEN=16384`, hai bộ đệm); cần đo heap thật lúc chạy (log `[heap]` mỗi 30 phút) và chỉnh trong `maintenance.h` nếu cần.
- **Watchdog/thời hạn**: DNS lwIP treo ~15 s + kết nối + TLS trong một request tệ nhất; `esp_task_wdt_deinit()`/`init(120)` trong IDF 4.4 của core; brownout thật và việc giảm công suất phát có thoát được vòng reset không.
- **AP WPA2**: `WiFi.softAP()` với mật khẩu 10 ký tự thật sự cho AP WPA2-PSK trên chip (kiểm `esp_wifi_get_config` sau khi mở); iPhone/Android vào được AP có mật khẩu rồi mới bật popup captive portal; DHCP/DNS của AP hoạt động như khi mở; `esp_wifi.h`/`wifi_config_t` biên dịch được (stub tự viết theo IDF 4.4).
- **Nhịp tim/diag**: `WiFi.RSSI()` và `ESP.getFreeHeap()` trong `makeDiag()`, luồng gửi nhịp tim trong `main.cpp` (chỉ mô phỏng bằng test lõi, logic dán ở `src/` chưa chạy).
- **Nút GPIO9 và LED GPIO8** trên bo C3 SuperMini thật (mức LED, nút kẹt).

## Hạn chế đã biết

- Bộ đệm số đo nằm trong RAM: khởi động lại (watchdog/brownout/cúp điện) giữa lúc mất mạng thì mất số đo chưa gửi. Có thể thêm một phân vùng nhật ký nhỏ (~48 KB còn trống) nếu cần; chưa làm vì mòn flash và độ phức tạp.
- Đầu dò hỏng ≥ 5 phút ⇒ máy gửi **nhịp tim** (`readings: []` + `diag`) nên server báo "lỗi cảm biến" riêng với "mất kết nối". Trong 5 phút đầu của sự cố, và với server cũ chưa hiểu nhịp tim, vẫn chỉ thấy im lặng. Đèn LED và log luôn nói rõ "lỗi đầu dò".
- Mật khẩu Wi-Fi WPA2 dạng 64 ký tự hex (khóa thô) và WEP/WPA1 không hỗ trợ; Wi-Fi doanh nghiệp (802.1X) không hỗ trợ.
- Chưa bật flash encryption/secure boot (khóa thiết bị/mật khẩu Wi-Fi nằm rõ trong flash).

## Đề nghị với chủ giao thức/server (chưa làm trong firmware vì không được đổi giao thức)

1. **Tài liệu hóa 429 và Retry-After** cho endpoint thiết bị (Cloudflare 1015 và giới hạn tốc độ riêng). Firmware hiện coi 429/403/404/3xx là "dai dẳng" (backoff 5→60 phút) và chưa đọc `Retry-After`.
2. ~~Gói nhịp tim/chẩn đoán~~: đã có trong `docs/PROTOCOL.md` và firmware (mục "Hoạt động").
3. **Ký cả số phiên bản OTA**: hiện chữ ký chỉ phủ nội dung `.bin`; firmware chặn hạ cấp bằng nhãn `AUHONO-FWVER:` nhúng trong ảnh (được ký). Nếu muốn giao thức ký thẳng `version` (ví dụ ký `sha256 || "\n" || version`) thì cần đổi `ota_sign.py` + firmware + PROTOCOL.md cùng lúc.
4. ~~Mật khẩu AP cấu hình~~: đã có (WPA2, suy ra từ khóa).
5. `GET /v1/ota/check` nên trả `update:true` **chỉ khi** `version` khác `current` *và có ý nghĩa mới hơn* (hiện `!=`): firmware đã tự từ chối bản cũ, nhưng server nên khỏi đề nghị (đỡ tốn một lượt hỏi + log gây nhiễu).
6. Ghi vào PROTOCOL.md rằng server cần tolerate: gói có `accepted < gửi` (số đo ngoài cửa sổ giờ), và `seq` nhảy ngay cả +64 mỗi lần khởi động (đã đúng theo `last_seq < seq`).
