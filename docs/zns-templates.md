# Mẫu tin ZNS cần đăng ký

Đăng ký 3 mẫu trên Zalo (duyệt mất vài ngày). Tên tham số phải **khớp đúng** với `templateData()`
trong `server/src/zns.ts`; đổi tên phải sửa cả hai nơi. Sau khi được duyệt, đặt template id vào
`wrangler.jsonc` (`ZNS_TEMPLATE_*`).

Tham số dùng chung: `device_name` (tên tủ), `temperature` (vd. `-9.5°C`), `threshold` (vd. `tối đa -18°C`), `time` (vd. `14:05 29/09`).

| Biến cấu hình            | Khi nào gửi                                   | Gợi ý nội dung                                                                 |
|--------------------------|-----------------------------------------------|--------------------------------------------------------------------------------|
| `ZNS_TEMPLATE_ALERT`     | Nhiệt độ vượt ngưỡng (và nhắc lại sau 30 phút) | "{device_name} đang {temperature} lúc {time}, vượt ngưỡng ({threshold}). Hãy kiểm tra tủ." |
| `ZNS_TEMPLATE_OFFLINE`   | Mất kết nối > 15 phút (và nhắc lại)            | "{device_name} mất kết nối từ {time} (có thể mất điện hoặc mất Wi-Fi). Hãy kiểm tra."      |
| `ZNS_TEMPLATE_RECOVERED` | Nhiệt độ về bình thường / kết nối lại          | "{device_name} đã trở lại bình thường lúc {time} ({temperature})."             |

## Lưu ý

- ZNS thiên về tin giao dịch / chăm sóc khách hàng: **mẫu cảnh báo có thể bị từ chối**. Hỏi Zalo trước
  hoặc đăng ký thử. Tin ZNS **tính phí theo tin**. Nếu không dùng được, cài `Notifier` khác (SMS, push,
  OA tin tư vấn) — chỉ cần triển khai `Notifier` trong `server/src/notify.ts`.
- Logo trên mẫu ở giai đoạn thử nghiệm là "autopostvn" (đã quyết định trong kế hoạch).
- `zns.ts` **chưa được kiểm chứng với API Zalo thật** (chỉ test với phản hồi giả lập). Lần đầu chạy thật hãy
  thử với 1 số điện thoại của mình, kiểm tra mã lỗi trả về, và xác nhận endpoint/tham số đúng tài liệu Zalo hiện hành.
- Refresh token của OA xoay vòng mỗi lần làm mới; token mới nhất được giữ trong bảng `kv`. Khởi tạo lần đầu bằng
  secret `ZALO_OA_REFRESH_TOKEN`. Nếu mất đồng bộ (dùng refresh token cũ), cấp lại token trên Zalo và xóa dòng
  `zalo_oa_tokens` trong bảng `kv`.
