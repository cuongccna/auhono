-- Số tin đã gửi theo tháng và theo thiết bị, kèm ước tính tiền (220đ/tin: sửa theo giá thực tế).
-- Chạy: npm run usage
SELECT strftime('%Y-%m', n.updated_at, 'unixepoch') AS thang,
       e.device_id,
       COUNT(*)       AS so_tin,
       COUNT(*) * 220 AS uoc_tinh_dong
FROM notifications n
JOIN alert_events e ON e.id = n.event_id
WHERE n.status = 'sent'
GROUP BY thang, e.device_id
ORDER BY thang DESC, so_tin DESC;
