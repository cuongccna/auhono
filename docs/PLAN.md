# Kế hoạch Auhono — Cảm biến nhiệt độ tủ đông

Kế hoạch ~8 tuần, 5 giai đoạn, làm một mình.

**Điều chỉnh so với bản đầu:** giai đoạn đầu cấp nguồn bằng cục sạc USB thay vì pin.
Thiết bị dùng chung điện với tủ, nên mất điện thì thiết bị tắt theo và máy chủ thấy
thiết bị im lặng là biết quán mất điện. Đơn giản hơn và không phải thay pin.

## Giai đoạn 0 — Chuẩn bị (tuần 1)

- Đăng ký mẫu tin nhắn dịch vụ Zalo (ZNS) ngay, vì duyệt mẫu mất vài ngày. Cần 3 mẫu:
  1. Cảnh báo nhiệt độ vượt ngưỡng.
  2. Cảnh báo mất kết nối (có thể mất điện).
  3. Thông báo đã trở lại bình thường.
- Giai đoạn thử nghiệm dùng tài khoản chính thức "autopostvn" (gói Growth) để khỏi tốn
  thêm; logo trên mẫu phải là "autopostvn". Thương hiệu riêng tính sau khi biết có bán được.
- Đặt linh kiện cho ~8 bộ (5 cho quán, 3 thử/dự phòng). Mỗi bộ: ESP32-C3 loại nhỏ,
  DS18B20 chống nước dây ~1 m, 1 điện trở kéo lên, cục sạc 5V, hộp nhựa.
  Ước tính ~150k/bộ, tổng dưới 1,5 triệu.

## Giai đoạn 1 — Phần mềm trên chip (tuần 1–2)

1. **Cấu hình Wi-Fi không cần người hỗ trợ:** lần đầu cắm điện, thiết bị phát Wi-Fi riêng
   (captive portal); khách vào bằng điện thoại và nhập tên/mật khẩu Wi-Fi của quán.
2. **Đo và gửi:** đọc nhiệt độ mỗi phút, gửi mỗi 5 phút; vượt ngưỡng thì gửi ngay.
3. **Bảo mật:** mỗi thiết bị có mã riêng + khóa bí mật riêng (nạp lúc ráp). Mỗi lần gửi
   ký dữ liệu kèm thời điểm gửi để chống giả mạo và chống phát lại gói cũ. Luôn qua HTTPS.
4. **Cập nhật từ xa (OTA):** bắt buộc có từ đầu, vì đã giao máy thì không thu về từng cái được.
5. **Tự kết nối lại** khi Wi-Fi chập chờn; đèn báo trạng thái.

Cuối tuần 2 thử ở nhà với tủ lạnh của mình: rút điện tủ, tắt bộ phát Wi-Fi, mở cửa tủ
thật lâu, xem mọi thứ có chạy đúng không.

## Giai đoạn 2 — Máy chủ (tuần 2–3)

Chạy trên Cloudflare Workers + D1 (gần như miễn phí ở quy mô này). Ba phần:

- **Nhận số đo:** kiểm tra chữ ký của thiết bị, từ chối gói sai chữ ký hoặc quá cũ.
- **Tác vụ hẹn giờ (5 phút/lần):** tìm thiết bị im lặng quá 15 phút để báo mất kết nối.
- **Gửi cảnh báo:** gọi ZNS.

Logic cảnh báo quyết định khách giữ hay vứt sản phẩm, nên làm kỹ:

- **Chống báo nhầm:** mở tủ lấy hàng hoặc tủ xả đá làm nhiệt độ tăng tạm thời. Chỉ báo khi
  vượt ngưỡng liên tục ~10–15 phút.
- **Chống làm phiền:** báo một lần; sau 30 phút vẫn chưa ổn thì nhắc lại; khi về bình
  thường thì báo "đã ổn".
- **Tiết kiệm dung lượng:** giữ số đo chi tiết 7 ngày, sau đó chỉ giữ trung bình theo giờ.

## Giai đoạn 3 — Giao diện chủ quán (tuần 3–4)

Zalo Mini App gọn nhẹ, 4 màn hình:

- **Kích hoạt:** quét mã QR dán trên hộp để gắn thiết bị với tài khoản.
- **Đặt ngưỡng:** có sẵn "tủ đông" (−18 °C) và "tủ mát" (2–8 °C).
- **Biểu đồ** nhiệt độ 24 giờ qua.
- **Người nhận cảnh báo:** thêm vợ/chồng, quản lý quán...

## Giai đoạn 4 — Thử nghiệm với 5 quán (tuần 5–8)

Chọn quán đa dạng: tiệm hải sản, quán ăn, tạp hóa có tủ kem, nhà thuốc có tủ mát. Dùng
miễn phí một tháng. Theo dõi 3 con số: số lần báo nhầm, số lần thiết bị rớt mạng, chủ
quán có mở xem biểu đồ không. Cuối tháng hỏi thẳng có chịu trả tiền không.

Giá đề xuất để kiểm chứng (giả định, chưa chắc): 399–499k cho thiết bị + 1 năm dịch vụ;
gia hạn ~150–200k/năm.

## Giai đoạn 5 — Quyết định

Nếu 2–3/5 quán chịu trả tiền: làm lô 20–30 bộ, hộp in thương hiệu, tờ hướng dẫn quét mã.
Kênh bán hứa hẹn: thợ sửa tủ lạnh, cửa hàng bán tủ đông (hoa hồng mỗi bộ), nhà phân phối
kem/hải sản đông lạnh. Nếu không ai trả tiền: luồng nhận số đo → kiểm tra ngưỡng → gửi
Zalo chuyển sang bộ đo sức khỏe cho người già.

Lưu ý: thiết bị phát Wi-Fi bán tại Việt Nam có thể cần chứng nhận hợp quy. Thử nghiệm chưa
cần lo, nhưng trước khi bán đại trà cần tìm hiểu và ưu tiên bo mạch đã có chứng nhận.

## Rủi ro và điểm cần kiểm chứng sớm

- **ZNS có thể không duyệt mẫu cảnh báo** (ZNS thiên về tin giao dịch/chăm sóc khách hàng)
  và tính phí theo tin. Cần phương án dự phòng (Zalo OA tin tư vấn, SMS, push).
  Máy chủ tách lớp gửi tin (`notifier`) để đổi kênh dễ.
- **Đồng hồ trên chip:** ESP32-C3 không có RTC, phải đồng bộ NTP. Nếu NTP lỗi mà chữ ký
  phụ thuộc thời gian thì gói bị từ chối. Giải pháp: kèm bộ đếm tăng dần (`seq`), và máy
  chủ trả về giờ chuẩn trong phản hồi để thiết bị tự chỉnh.
- **OTA phải ký firmware**, chip chỉ nhận bản đã ký; nếu không, khóa bí mật mất giá trị.
- **Nạp khóa lúc ráp** cần script ghi lại mã thiết bị để làm 30 bộ không phải đổi cách.
- ESP32-C3 chỉ hỗ trợ Wi-Fi **2.4 GHz** — trang cấu hình cần lưu ý.
- Dây đầu dò luồn qua gioăng cửa có thể làm hở cửa: hộp đặt ngoài tủ, chỉ đầu dò trong tủ.
- Mất điện và mất Wi-Fi đều làm thiết bị im lặng; thông báo dùng câu "có thể mất điện".
