# Chi phí tin nhắn và cách kiểm soát

ZNS tính **~220đ/tin** (giá bạn cung cấp) và cần gói Growth **2,5 triệu/năm**. Đây là mô hình chi phí và các
cơ chế trong máy chủ để không bị "cháy" tiền tin nhắn. **Mọi số liệu dưới đây là ước tính từ giả định, cần đối chiếu
bằng dữ liệu thật ở giai đoạn thử nghiệm** (`npm run usage` trong `server/`).

## 1. Tin nhắn bình thường rất ít, cái đắt là tình huống xấu

Tin chỉ phát sinh khi có sự kiện (báo động, mất kết nối, đã ổn/kết nối lại, nhắc lại). Thiết bị hoạt động bình thường
thì **không tốn tin nào**. Với chính sách hiện tại (2 người nhận, nhắc lại chỉ gửi người nhận chính):

| Sự kiện                                   | Số tin | Tiền  |
|-------------------------------------------|-------:|------:|
| Mất điện ngắn (< 2 giờ): báo + kết nối lại | 4      | 880đ  |
| Mất điện dài > 12 giờ (báo + 3 nhắc + kết nối lại) | 7 | 1.540đ |
| Tủ hỏng 26 giờ, không ai bấm "đã biết" (báo + 5 nhắc + đã ổn) | 9 | 1.980đ |

Ước tính cả năm cho **một thiết bị**:

| Mức độ                          | Tin/năm | Tiền/năm |
|---------------------------------|--------:|---------:|
| Ít sự cố (1 tủ hỏng, 3 mất điện ngắn) | 21  | ~4.600đ  |
| Trung bình (3 tủ hỏng, 8 điện ngắn, 1 điện dài) | 66 | ~14.500đ |
| Nhiều (điện yếu: 6 tủ hỏng, 15 điện ngắn, 3 điện dài) | 135 | ~29.700đ |

→ Chi phí tin theo thiết bị là **vài nghìn đến ~30 nghìn đồng/năm**, rất nhỏ so với giá gia hạn 150–200 nghìn.
Để chạm "cả triệu/tháng" phải có **~4.500 tin/tháng**, tức chỉ xảy ra khi có bão báo động hoặc đội thiết bị lớn.

### Những tình huống có thể đốt tiền (đã chặn)

| Tình huống | Nếu không chặn | Cách chặn |
|------------|----------------|-----------|
| Tủ dao động quanh ngưỡng, báo/hồi liên tục (30 sự cố/tháng) | ~240.000đ/thiết bị/tháng | Trần **20 tin/thiết bị/24 giờ**; vượt trần thì tin bị `suppressed` |
| Quán nghỉ Tết rút điện thiết bị 7 ngày | 34 tin ≈ 7.500đ **mỗi lần**, lặp lại mỗi kỳ nghỉ | Nút **Tạm dừng** (1–60 ngày), không tốn tin nào |
| Sự cố kéo dài, chủ quán đã biết rồi mà vẫn bị nhắc | Nhắc đến hết lịch | Nút **Đã biết** dừng nhắc lại 1–24 giờ |
| Nhiều người nhận, mỗi lần nhắc gửi hết | Nhân số người nhận | Nhắc lại chỉ gửi **người nhận chính** |
| Nhắc lại dày (bản trước: 16 lần) | 36 tin/sự cố ≈ 7.900đ | Lịch thưa dần, tối đa 5 lần nhắc (còn 9 tin ≈ 2.000đ) |

## 2. Chi phí cố định mới là gánh nặng lúc đầu

| Khoản                                  | Ước tính/năm |
|----------------------------------------|-------------:|
| Gói Growth ZNS                          | 2.500.000đ   |
| Cloudflare Workers Paid (~5$/tháng)     | ~1.500.000đ  |
| **Tổng cố định**                        | **~4.000.000đ** |

Chia theo số thiết bị đang hoạt động:

| Số thiết bị | Cố định/thiết bị/năm |
|------------:|---------------------:|
| 5           | 800.000đ  |
| 20          | 200.000đ  |
| 50          | 80.000đ   |
| 100         | 40.000đ   |
| 300         | 13.000đ   |

Doanh thu năm đầu một thiết bị theo giá đề xuất (449.000đ) trừ phần cứng (~150.000đ) và tin nhắn (~15.000đ):
còn ~284.000đ để trang trải phần cố định. **Hòa vốn phần cố định cần khoảng 14–15 thiết bị bán được trong năm đầu**;
từ năm 2, gia hạn 150–200 nghìn gần như thuần lợi nhuận sau khi trừ tin nhắn.

- **Giai đoạn thử nghiệm (5 quán):** dùng luôn gói Growth đã có của "autopostvn" thì chi phí biên gần như chỉ là
  tin nhắn (dưới ~100 nghìn đồng cả đợt nếu không có bão báo động) và Cloudflare có thể ở gói miễn phí
  (xem `server/README.md`, mục Giới hạn gói). Chỉ trả thêm khi thật sự bán đại trà.
- Chưa nên đặt giá cuối cùng trước khi có số liệu tin thực tế của 5 quán.

## 3. Kênh thay thế / bổ sung để giảm hoặc bỏ tiền tin

**Chưa xác minh với chính sách Zalo hiện hành — cần kiểm tra trước khi tin vào bất cứ mục nào dưới đây.**

| Kênh | Chi phí | Ghi chú |
|------|---------|---------|
| Tin tư vấn của Zalo OA gửi cho người dùng đã tương tác với OA | Có thể miễn phí trong khung thời gian sau lần tương tác gần nhất (cần xác nhận) | Cần liên kết người dùng OA với số điện thoại/người nhận; cửa sổ ngắn nên khó đảm bảo cho cảnh báo lúc nửa đêm |
| Telegram bot | 0đ, không giới hạn thực tế | Chủ quán ít dùng; hợp cho **bạn (người vận hành)** nhận cảnh báo hệ thống và cho khách kỹ thuật |
| Web push / push của app riêng | 0đ | Zalo Mini App không cung cấp push tùy ý; app riêng thì phải làm và duy trì |
| SMS brandname | Thường đắt hơn ZNS | Không nên dùng chỉ để tiết kiệm |

**Đã làm: Telegram** (xem `server/README.md`, mục Telegram): kênh miễn phí, độc lập với ZNS, làm dự phòng/bản sao cho
người nhận muốn dùng và để báo lỗi hệ thống cho người vận hành. Telegram không bị trần chi phí ZNS. Người nhận có thể chọn
"chỉ Telegram" để không tốn đồng nào, hoặc "cả hai" để có dự phòng.

Cách đơn giản hơn Telegram (chưa làm, nếu cần):
- **ntfy.sh** (push miễn phí, không cần tài khoản): server chỉ gửi một HTTP POST tới `https://ntfy.sh/<chủ-đề-bí-mật>`; người nhận
  cài app ntfy và đăng ký chủ đề đó. Không có bot, không webhook, không liên kết chat_id. Ưu tiên "khẩn cấp" có thể xuyên chế độ
  không làm phiền trên Android. Đổi lại: ít người biết app, dịch vụ công cộng không có cam kết chất lượng (có thể tự dựng máy chủ ntfy).
  Rất hợp làm kênh báo lỗi cho **người vận hành**.
- **Còi báo động ngay trên thiết bị** (buzzer ~5 nghìn đồng, chạy khi nhiệt độ vượt ngưỡng, có nút tắt tiếng): không cần mạng, không
  tốn tin, hữu ích lúc có người ở quán. Không thay được cảnh báo từ xa lúc quán đóng cửa.

## 4. Cách tính tiền cho khách (gợi ý để bạn cân nhắc)

- Mức trung bình ước tính ~66 tin/năm (~14.500đ), mức nhiều ~135 tin/năm (~29.700đ): gia hạn 150–200 nghìn/năm dư sức bao phần tin nhắn.
- Nếu muốn an toàn: ghi rõ "bao gồm cảnh báo hợp lý"; trần 20 tin/ngày/thiết bị đã là chốt chặn kỹ thuật.
- Cân nhắc gói thêm người nhận (người nhận thứ 3–5) tính phí nhỏ vì mỗi người nhận nhân số tin báo mới.

## 5. Theo dõi thực tế

```bash
cd server && npm run usage
```
In số tin đã gửi theo tháng và theo thiết bị kèm ước tính tiền (sửa 220đ trong `scripts/usage.sql` khi giá đổi).
Tin `failed`/`suppressed` không được tính vào tiền (không gửi). Kiểm tra bất thường: thiết bị nào vọt lên trên
~50 tin/tháng thường là tủ dao động ngưỡng hoặc mất điện liên tục, cần chỉnh ngưỡng hoặc `breach_minutes`.
