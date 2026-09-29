# Auhono Mini App (Zalo) dành cho chủ quán

Ứng dụng Zalo Mini App (React + TypeScript + Vite, `zmp-sdk`, `zmp-ui`) để chủ quán:

| Màn hình | Đường dẫn | Việc làm được |
|---|---|---|
| Thiết bị của tôi | `/` | Danh sách thiết bị, nhiệt độ mới nhất, trạng thái (Bình thường / Đang báo động / Mất kết nối), nút Làm mới |
| Kích hoạt | `/activate` | Quét QR trên hộp (hoặc nhập tay mã thiết bị + mã kích hoạt), chọn Tủ đông / Tủ mát, đặt tên |
| Chi tiết + biểu đồ 24 giờ | `/device/:id` | Biểu đồ SVG (dải ngưỡng, dải min–max, đứt đường khi mất kết nối > 15 phút, trục giờ Việt Nam), gỡ thiết bị (có bước xác nhận) |
| Đặt ngưỡng | `/device/:id/thresholds` | Chọn loại tủ có sẵn ngưỡng; mục "Nâng cao" chỉnh min/max và số phút báo (5–60) |
| Người nhận cảnh báo | `/device/:id/recipients` | Xem / thêm / xóa (tối đa 5), số điện thoại di động VN tự chuẩn hóa về `84xxxxxxxxx` |

API mà app gọi là nhóm "Chủ quán" trong `server/src/app.ts` (Bearer = Zalo access token).

## Cấu trúc

```
app/
├── app-config.json        cấu hình Mini App (tiêu đề, màu, thanh trên cùng)
├── zmp-cli.json           cấu hình zmp-cli
├── vite.config.mts        Vite + zmp-vite-plugin + plugin-react
├── vitest.config.ts       cấu hình test
├── index.html
├── .env.example           mẫu biến môi trường (chép thành .env)
└── src/
    ├── app.ts             điểm vào
    ├── api-client.ts      khách HTTP thuần (test được): Bearer, hạn 15 giây, thử lại GET 1 lần, ánh xạ lỗi
    ├── api.ts             gắn địa chỉ (VITE_API_BASE) + token của Zalo vào khách API
    ├── sdk.ts             mọi chỗ gọi zmp-sdk (getAccessToken, authorize, scanQRCode, openPermissionSetting)
    ├── config.ts, hooks.ts, env.d.ts
    ├── lib/               HÀM THUẦN + test: qr, phone, thresholds, chart, status, format, errors, schemas
    ├── components/        app (router + điều hướng), screen, temp-chart (SVG), status-badge, error-box
    ├── pages/             home, activate, device, thresholds, recipients
    └── css/app.css
```

Nguyên tắc: logic quan trọng (đọc QR, chuẩn hóa số điện thoại, kiểm tra ngưỡng, tính toạ độ biểu đồ,
ánh xạ lỗi) nằm trong `src/lib` và `src/api-client.ts`, không phụ thuộc React hay Zalo nên test bằng vitest trong Node.

## Cài đặt

Cần Node 22+.

```bash
cd app
npm install                       # .npmrc đã bật legacy-peer-deps (zmp-ui/zmp-vite-plugin khai báo peer cũ)
npm install -g zmp-cli            # công cụ dòng lệnh của Zalo: lệnh `zmp`
cp .env.example .env              # rồi sửa VITE_API_BASE
```

### Biến môi trường

| Biến | Bắt buộc | Ý nghĩa |
|---|---|---|
| `VITE_API_BASE` | có | Địa chỉ gốc API Auhono, dạng `https://auhono-server.<tên>.workers.dev` (không có `/` cuối, không có đường dẫn). Chỉ chấp nhận `https://` (hoặc `http://localhost` khi dev). Bỏ trống thì app dùng địa chỉ giả `https://api.auhono.invalid` và hiện cảnh báo trên màn hình chính, không gửi dữ liệu đi đâu. |
| `APP_ID`, `ZMP_TOKEN` | do zmp-cli | `zmp login` / `zmp init` ghi vào `.env`. **Là bí mật**: không commit (`.gitignore` đã chặn `.env`), không bao giờ đổi tên thành `VITE_*` (mọi biến `VITE_*` bị nhúng vào bundle công khai). |

Bundle không chứa bí mật nào: token của người dùng chỉ được lấy lúc chạy từ `getAccessToken()` và chỉ gắn vào header `Authorization` của từng request (không log, không lưu).

## Chạy thử, xem trước, triển khai

```bash
zmp login                  # đăng nhập tài khoản nhà phát triển (quét QR bằng Zalo) — lần đầu
zmp start                  # chạy local như web app, mở bằng trình duyệt để xem giao diện
zmp deploy                 # build (vite build -> www/) và đưa lên Zalo; chọn Development hoặc Testing
```

Các lệnh dùng trong quá trình phát triển (không cần Zalo):

```bash
npm run typecheck          # tsc --noEmit
npm test                   # vitest run
npm run build              # vite build -> www/ (giống bước build của zmp deploy)
```

Lưu ý khi xem trước bằng trình duyệt (`zmp start`): ngoài Zalo, `getAccessToken()` trả chuỗi rỗng và `scanQRCode()` trả nội dung rỗng,
nên app sẽ hiện nút "Cho phép" / báo chưa quét được. Muốn gọi API thật phải chạy trong Zalo (bản Development/Testing của `zmp deploy`,
hoặc `zmp start -D` nếu bản zmp-cli của bạn hỗ trợ chế độ Device với Vite 5; tài liệu zmp-cli nói chế độ Device yêu cầu Vite 2.x, chưa kiểm chứng).

### Đăng ký Mini App

1. Vào <https://mini.zalo.me/developers>, tạo Mini App và liên kết với một Zalo App (lấy `APP_ID` cho `zmp login`/`.env`).
2. `zmp deploy` bản Development để thử trên điện thoại; bản Testing để gửi duyệt và phát hành.
3. Mini App chạy tại `https://h5.zdn.vn/zapps/<APP_ID>/...` (theo cấu hình của zmp-cli) nên origin gọi API là `https://h5.zdn.vn`;
   trong ứng dụng Zalo webview có thể là `zbrowser://h5.zdn.vn`. Cả hai đều phải nằm trong `ALLOWED_ORIGINS` của server.

### Cho server chấp nhận origin của Mini App (CORS)

Server chỉ trả CORS cho origin nằm trong `ALLOWED_ORIGINS` (so khớp chính xác từng chuỗi). Trong `server/wrangler.jsonc`:

```jsonc
"vars": {
  "ALLOWED_ORIGINS": "https://h5.zdn.vn,zbrowser://h5.zdn.vn"
}
```

- Mặc định đã có hai origin trên. Sửa xong phải `npm run deploy` lại ở `server/`.
- Chạy `zmp start` trong trình duyệt local để thử API: thêm tạm `http://localhost:3000` (hoặc cổng zmp in ra) vào biến ở môi trường dev
  (`server/.dev.vars` khi dùng `wrangler dev`), **không** đưa origin localhost vào bản production.
- Cần xác nhận origin thật mà Zalo gửi (mục QA bên dưới): nếu khác, thêm đúng chuỗi đó.

## Bảo mật (tóm tắt)

- QR là dữ liệu không tin cậy: `parseClaimQr` chỉ nhận đúng `auhono://claim?d=…&c=…` (đúng scheme, host, hai tham số, ký tự cho phép), từ chối mọi thứ khác;
  tuyệt đối không mở/điều hướng URL từ QR (SDK được gọi ở chế độ chỉ lấy chữ, `skipOpenLink`). Nội dung hiển thị qua React (tự thoát HTML).
- Chỉ gọi HTTPS; `credentials: 'omit'`; `cache: 'no-store'`; hạn 15 giây (AbortController); chỉ GET được thử lại 1 lần khi lỗi mạng (POST/PATCH/DELETE không bao giờ tự lặp).
- Mọi phản hồi từ server được kiểm tra dạng dữ liệu (`lib/schemas.ts`); sai dạng => báo lỗi thân thiện, không hiển thị `NaN`/`undefined`.
- Thông điệp lỗi không chứa token, số điện thoại hay mã kích hoạt. Không có `console.log` dữ liệu người dùng.
- Số điện thoại lưu/hiển thị theo dạng server đã chuẩn hóa; xóa người nhận và gỡ thiết bị đều có bước xác nhận.
- Phụ thuộc gián tiếp của `zmp-sdk`/`zmp-ui` có cảnh báo `npm audit` (`@sentry/browser` qua zmp-sdk; `react-router` qua zmp-ui, chưa có bản vá trong dải phiên bản zmp-ui yêu cầu); app không dùng các đường code bị ảnh hưởng (SSR của react-router, `<Link>` tới URL do người dùng cung cấp).

## Kiểm thử thủ công trong Zalo thật (checklist)

Phần tự động chỉ chạy trong Node/jsdom với SDK giả lập. Những điều sau **chưa** được kiểm chứng trong Zalo thật, cần thử tay
trên cả Android và iOS, ít nhất một máy Zalo bản mới và một máy bản cũ:

**Cài đặt & quyền**
- [ ] `zmp deploy` (Development) chạy, mở được Mini App từ Zalo; không màn hình trắng.
- [ ] Lần đầu mở: nếu Zalo hỏi quyền, bấm Cho phép thì danh sách tải được. Thử **Từ chối** rồi bấm "Cho phép" / "Mở cài đặt quyền": có đường quay lại không?
- [ ] Trên Zalo bản cũ (không có `authorize`): thông báo lỗi có dễ hiểu không, không treo?
- [ ] Ghi lại header `Origin` thật của request (log server hoặc DevTools qua `zmp start -D`) và đảm bảo nằm trong `ALLOWED_ORIGINS`. Lỗi CORS sẽ hiện như "Không kết nối được mạng".
- [ ] Token hết hạn/thu hồi: server trả 401, hiện nút "Cho phép", bấm xong thử lại được.

**Kích hoạt**
- [ ] Nút "Quét mã QR" mở camera của Zalo; quét QR thật từ `provision.ts` điền đúng mã; **không** tự mở link nào.
- [ ] Quét QR lạ (mã web, mã thanh toán) => thông báo "không phải mã Auhono", không có tác dụng phụ.
- [ ] Đóng camera giữa chừng => thông báo nhẹ, không lỗi.
- [ ] Nhập tay: gõ hoa/thường, có/không gạch, có khoảng trắng, nhầm O/0, I/1 đều kích hoạt được; bàn phím tự viết hoa không gây khó chịu.
- [ ] Kích hoạt thành công chuyển sang màn "Người nhận cảnh báo". Mã sai / thiết bị đã có chủ khác => câu báo lỗi `invalid_code`.
- [ ] Kích hoạt lại thiết bị đã là của mình vẫn ổn (server cho phép).

**Biểu đồ & trạng thái**
- [ ] Biểu đồ hiển thị đúng trên màn hình nhỏ (360 px) và máy lớn; chữ trục đọc được, không tràn mép; không cuộn ngang.
- [ ] Giờ trên trục là giờ Việt Nam kể cả khi điện thoại đặt múi giờ khác.
- [ ] Rút nguồn thiết bị > 15 phút: đường bị đứt, có vùng "mất kết nối", huy hiệu "Mất kết nối" (kiểm tra cả khi đồng hồ điện thoại chạy đúng).
- [ ] Làm nóng tủ để có báo động: huy hiệu "Đang báo động", đường vượt dải ngưỡng.
- [ ] Thiết bị mới kích hoạt chưa có số đo: "Chưa có dữ liệu", biểu đồ không lỗi.
- [ ] Nút "Làm mới" cập nhật số liệu; mạng yếu/tắt mạng cho thông báo dễ hiểu và nút "Thử lại".
- [ ] VoiceOver/TalkBack đọc được tóm tắt biểu đồ.

**Ngưỡng & người nhận**
- [ ] Chọn Tủ đông / Tủ mát rồi Lưu: ngưỡng mới hiện ở chi tiết thiết bị và server áp dụng.
- [ ] "Nâng cao": nhập -18,5 (dấu phẩy), số sai, min ≥ max, phút ngoài 5–60 => báo lỗi đúng ô, không gửi lên server.
- [ ] Thêm số `0912345678`, `+84 912 345 678`, `84912345678` đều thành `0912 345 678`; số bàn (`0212…`) bị từ chối.
- [ ] Thêm người thứ 6 bị chặn với câu báo rõ; xóa một người rồi thêm lại được.
- [ ] Thật sự nhận được tin ZNS khi tạo báo động (phụ thuộc cấu hình ZNS phía server).
- [ ] "Gỡ thiết bị": có hộp xác nhận; sau khi gỡ, thiết bị biến mất và kích hoạt lại được (kể cả bằng tài khoản khác).

**Giao diện**
- [ ] Nút/ô nhập đủ lớn (>= 48 px), chữ đọc được ngoài trời; bàn phím không che ô đang nhập.
- [ ] Thanh điều hướng dưới đáy không che nội dung; nút Back của Zalo và nút quay lại của app cùng hoạt động.
- [ ] Safe-area (tai thỏ / thanh home) đúng: Header không bị che (`actionBarHidden: true` trong `app-config.json` dùng Header của zmp-ui).
- [ ] Chế độ tối của Zalo: app hiện chỉ có giao diện sáng (chưa hỗ trợ theme tối).

## Kích thước bản build

`npm run build` (Vite 5, target es2015): xem số đo trong báo cáo bàn giao. Phần lớn là react-dom, react-router, `zmp-ui` (và `zod` do `zmp-sdk` kéo vào)
cùng toàn bộ `zaui.css` (import nguyên tệp; có thể thu nhỏ sau bằng cách chỉ nạp phần CSS của các component đang dùng).

## Hạn chế và việc còn lại

- Trạng thái "mất kết nối" và trục giờ dựa vào đồng hồ điện thoại (API chủ quán chưa trả `server_time`). Đồng hồ máy lệch nhiều sẽ làm lệch cửa sổ biểu đồ/"x phút trước".
- Chưa có màn đổi tên thiết bị (server hỗ trợ `PATCH { name }`), chưa xem lịch sử > 7 ngày (`/v1/devices/:id/history`).
- Chưa hỗ trợ chế độ tối; cần rà soát lại khi Zalo có chế độ tối cho Mini App.
- `zmp-cli.json` và cấu trúc thư mục được viết tay theo khuôn zmp-cli (không chạy được `zmp init` vì môi trường phát triển không tải được template); nếu `zmp start`/`zmp deploy` phàn nàn, tạo dự án mẫu bằng `zmp init` (Vite 5 + TypeScript) rồi chép `src/`, `app-config.json`, `index.html` sang.
