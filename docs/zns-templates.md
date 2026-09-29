# Mẫu tin ZNS cần đăng ký

Đăng ký 3 mẫu trên Zalo (duyệt mất vài ngày). Tên tham số phải **khớp đúng** với `templateData()`
trong `server/src/zns.ts`; đổi tên phải sửa cả hai nơi. Sau khi được duyệt, đặt template id vào
`wrangler.jsonc` (`ZNS_TEMPLATE_*`).

Tham số dùng chung: `device_name` (tên tủ), `temperature` (vd. `-9.5°C`), `threshold` (vd. `tối đa -18°C`), `time` (vd. `14:05 29/09`).

| Biến cấu hình            | Khi nào gửi                                                                 | Gợi ý nội dung                                                                                         |
|--------------------------|-----------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------|
| `ZNS_TEMPLATE_ALERT`     | Nhiệt độ vượt ngưỡng liên tục 15 phút; nhắc lại (30 phút x4, sau đó 2 giờ)   | "{device_name} đang {temperature} lúc {time}, vượt ngưỡng ({threshold}). Hãy kiểm tra tủ."             |
| `ZNS_TEMPLATE_OFFLINE`   | Không nhận được số đo > 15 phút, hoặc thiết bị mới gắn > 60 phút chưa kết nối | "{device_name} không gửi được dữ liệu (tính đến {time}). Có thể mất điện, mất Wi-Fi hoặc đứt dây đầu dò. Hãy kiểm tra." |
| `ZNS_TEMPLATE_RECOVERED` | Nhiệt độ về bình thường / thiết bị kết nối lại                               | "{device_name} đã trở lại bình thường lúc {time} ({temperature})."                                     |

Lời lẽ mẫu OFFLINE cố ý trung tính vì máy chủ không phân biệt được các nguyên nhân: mất điện, mất Wi-Fi, ISP
hỏng, **dây đầu dò bị gioăng cửa cắt** (rất hay gặp; chip không có số đo hợp lệ thì không gửi gì), hay thiết bị mới
lắp chưa từng kết nối (Wi-Fi 5 GHz, sai mật khẩu).

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
