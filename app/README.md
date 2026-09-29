# Auhono Mini App (Zalo) dành cho chủ quán

Ứng dụng Zalo Mini App (React + TypeScript + Vite, `zmp-sdk`, `zmp-ui`) để chủ quán:

| Màn hình | Đường dẫn | Việc làm được |
|---|---|---|
| Thiết bị của tôi | `/` | Danh sách thiết bị, nhiệt độ mới nhất, trạng thái (Bình thường / Đang báo động / Mất kết nối / Chưa có dữ liệu), cảnh báo cấu hình (chưa có người nhận, gửi tin lỗi, chưa bật báo động). Tự làm mới mỗi 60 giây khi đang xem |
| Kích hoạt | `/activate` | Quét QR trên hộp (hoặc nhập tay mã thiết bị + mã kích hoạt, hoặc dán cả đường dẫn QR), chọn Tủ đông / Tủ mát, đặt tên |
| Chi tiết + biểu đồ 24 giờ | `/device/:id` | Biểu đồ SVG (dải ngưỡng, dải min–max, đứt đường + gạch chéo khi mất kết nối > 15 phút, hình thoi cho điểm ngoài ngưỡng, trục giờ Việt Nam), hướng dẫn cài đặt khi chưa có số đo, giải thích cách cảnh báo hoạt động, gỡ thiết bị (có bước xác nhận) |
| Đổi tên | `/device/:id/rename` | Đổi tên thiết bị (chuẩn hóa NFC, 1–60 ký tự) |
| Đặt ngưỡng | `/device/:id/thresholds` | Hiện nhiệt độ hiện tại của tủ; chọn loại tủ có sẵn ngưỡng; mục "Nâng cao" chỉnh min/max (gõ được `-18,5`, `−18`, số toàn chiều rộng) và số phút báo (5–60); cảnh báo khi nhiệt độ hiện tại đã nằm ngoài ngưỡng định đặt |
| Người nhận cảnh báo | `/device/:id/recipients` | Xem / thêm / xóa (tối đa 5), số điện thoại di động VN tự chuẩn hóa về `84xxxxxxxxx`, chặn trùng, cảnh báo khi xóa người cuối cùng |

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
    ├── api-client.ts      khách HTTP thuần (test được): Bearer lấy mới mỗi request, hạn 15 giây, thử lại GET 1 lần (mạng/502/503/504),
    │                      làm mới token khi 401, huỷ bằng AbortSignal, hiệu chỉnh đồng hồ theo server_time, ánh xạ lỗi
    ├── api.ts             gắn địa chỉ (VITE_API_BASE) + token của Zalo + bộ đồng hồ vào khách API
    ├── actions.ts         thao tác GHI chịu được "server đã làm xong nhưng mất phản hồi" (kích hoạt, thêm người nhận, gỡ thiết bị)
    ├── sdk.ts             mọi chỗ gọi zmp-sdk (getAccessToken, authorize, scanQRCode, quyền camera, theme, openPermissionSetting)
    ├── hooks.ts           useAsync (huỷ được, tự làm mới 60 s, giãn dần khi lỗi, tạm dừng khi ẩn), useNow, useOnline, useSingleFlight
    ├── nav.ts             quay lại an toàn, đưa focus vào ô lỗi
    ├── config.ts, env.d.ts
    ├── lib/               HÀM THUẦN + test: qr, phone, text, thresholds, chart, status, notices, clock, format, errors, schemas
    ├── components/        app (router, theme, ErrorBoundary), screen, temp-chart (SVG), status-badge, error-box, help, error-boundary
    ├── pages/             home, activate, device, rename, thresholds, recipients
    └── css/app.css        giao diện sáng + tối (biến màu), test độ tương phản trong css/contrast.test.ts
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
  tuyệt đối không mở/điều hướng URL từ QR. Chuỗi hiển thị qua React (tự thoát HTML), không có `dangerouslySetInnerHTML`/`innerHTML`.
- Token Zalo: lấy MỚI từ `getAccessToken()` cho từng request (không cache, không lưu, không log), chỉ nằm trong header `Authorization`, không bao giờ trong URL/state/storage.
  `src/security.test.ts` quét mã nguồn để giữ các quy tắc này (không `console.*`, không `localStorage`, chỉ `api-client.ts` gọi `fetch`, chỉ 1 biến `VITE_`, mọi `navigate(...)` chỉ nhúng giá trị đã `encodeURIComponent`).
- Chỉ gọi HTTPS; `credentials: 'omit'`; `cache: 'no-store'`; hạn 15 giây (AbortController); phản hồi > 2 MB bị bỏ.
  Chỉ GET được tự thử lại 1 lần (lỗi mạng, 502/503/504); POST/PATCH/DELETE không bao giờ tự lặp (riêng 401 thì thử lại 1 lần với token mới nếu token đổi, vì 401 nghĩa là server chưa xử lý gì).
- Mọi phản hồi từ server được kiểm tra dạng dữ liệu (`lib/schemas.ts`): dòng hỏng bị bỏ qua thay vì làm trắng cả màn hình; trường lạ/thừa bị bỏ qua; trường mới vắng mặt (server cũ) được chịu đựng; danh sách quá lớn bị cắt.
- Thông điệp lỗi không chứa token, số điện thoại hay mã kích hoạt. Thông báo "mã sai / thiết bị đã có chủ" cố ý chung chung (server cũng trả chung một lỗi `invalid_code`).
- Số điện thoại lưu/hiển thị theo dạng server đã chuẩn hóa; xóa người nhận và gỡ thiết bị đều có bước xác nhận.
- Phụ thuộc gián tiếp: `npm audit --omit=dev` (đã chạy) báo 5 mức "moderate": `@sentry/browser` (kéo bởi `zmp-sdk`, prototype pollution gadget — bản vá cần hạ `zmp-sdk` về 2.9.4, không khả thi) và `react-router` (kéo bởi `zmp-ui`; open redirect qua `\` trong `<Link>`/`useNavigate`, SSR hydration; chưa có bản vá).
  App không dùng đường code bị ảnh hưởng (không SSR; không điều hướng tới chuỗi do người dùng/QR/server cung cấp: mã thiết bị luôn qua `encodeURIComponent`). Theo dõi bản cập nhật `zmp-sdk`/`zmp-ui`.
  Không thêm CSP `<meta>` vì chưa kiểm chứng trong Zalo (có thể chặn SDK).

## Tình huống thực tế (scenario → hành vi)

Mọi dòng "Test" là test tự động trong Node/jsdom (SDK và `fetch` giả lập); xem mục "Chưa xác minh trong Zalo thật" ngay dưới bảng.

| Tình huống | Hành vi của app | Test |
|---|---|---|
| Token Zalo hết hạn sau nhiều giờ nền | Token lấy mới cho từng request. 401: lấy token mới, nếu khác thì thử lại đúng 1 lần; vẫn 401 => hộp lỗi + nút "Cho phép" | `api-client.test.ts` |
| Bấm "Cho phép" nhưng người dùng từ chối; sau đó bật lại trong Cài đặt | Hướng dẫn + nút "Mở cài đặt quyền"; quay lại app thì tự thử lại; chữ đang gõ trong form còn nguyên | `scenarios.test.tsx` |
| Token rỗng (xem thử trên trình duyệt) | Không gọi mạng; báo cần "Cho phép" | `scenarios.test.tsx` |
| Server 503 `auth_unavailable` (Zalo bận) | "Zalo đang bận, thử lại sau ít phút" + nút Thử lại; giữ số liệu cũ; KHÔNG hiện nút "Cho phép"; tự thử lại giãn dần | `errors.test.ts`, `hooks.test.tsx`, `scenarios.test.tsx` |
| Server trả HTML (Cloudflare 502/504, portal Wi-Fi), JSON hỏng, rỗng, 500, 429 | 502/503/504: GET tự thử lại 1 lần; còn lại thông điệp thân thiện (`bad_response` nhắc Wi-Fi có thể đòi đăng nhập); không bao giờ hiện `undefined`/`NaN` | `api-client.test.ts`, `scenarios.test.tsx` |
| Phản hồi thừa/thiếu trường, 1 thiết bị hỏng, danh sách rất lớn | Trường thừa bỏ qua; dòng hỏng bị bỏ; loại tủ lạ hiện "Tủ"; cắt 500 thiết bị / 3000 điểm | `schemas.test.ts` |
| Đồng hồ điện thoại lệch (nhanh/chậm hàng giờ) | "Mất kết nối", "x phút trước", cửa sổ biểu đồ dùng `server_time` − độ lệch (bù nửa độ trễ mạng); server cũ thì dùng giờ điện thoại | `clock.test.ts`, `scenarios.test.tsx` |
| Mạng chậm/đứt khi đang xem | Hạn 15 s; hộp lỗi + "Thử lại"; GIỮ số liệu cũ kèm "Đang hiện số liệu lúc HH:MM (x phút trước)"; trạng thái tính theo lúc tải cuối (điện thoại mất mạng KHÔNG làm thiết bị bị coi là mất kết nối); banner khi `navigator.onLine=false` | `hooks.test.tsx`, `scenarios.test.tsx` |
| Chuyển nhanh giữa các thiết bị, phản hồi về không đúng thứ tự, rời màn hình | Đổi thiết bị xóa ngay dữ liệu cũ, huỷ request cũ (AbortController); phản hồi muộn không ghi đè; không cập nhật state sau khi rời | `hooks.test.tsx` |
| Bấm liên tục Làm mới / Kích hoạt / Lưu / Thêm / Xóa / Gỡ | `reload` bỏ qua khi đang tải; các nút ghi có cờ chống bấm đúp (chặn ngay cả hai lần chạm cùng một khung hình) | `hooks.test.tsx`, `scenarios.test.tsx` |
| Server đã làm xong nhưng mất phản hồi | Kích hoạt: lỗi mạng/quá hạn/5xx => đọc danh sách, đã có thiết bị thì coi là thành công (bấm lại cũng ok vì server trả 200 cho chính chủ). Thêm người thứ 5: 409 nhưng số đã có => thành công. Gỡ thiết bị lần 2 (404) => thành công | `actions.test.ts`, `scenarios.test.tsx` |
| Tự làm mới khi xem sự cố | 60 s khi đang xem (màn hình chính + chi tiết); tạm dừng khi ẩn; quay lại/có mạng thì tải ngay; lỗi thì giãn 2×, trần 5 phút; dừng khi cần cấp quyền hoặc thiết bị đã bị gỡ; không rò bộ đếm giờ | `hooks.test.tsx`, `scenarios.test.tsx` |
| Camera bị từ chối / đóng camera / quét QR lạ / QR chữ thường, có xuống dòng | Phân biệt "từ chối" (nút Cho phép camera + Mở cài đặt) với "đóng camera" (thông báo nhẹ); QR lạ bị từ chối, không mở gì; QR đọc không phân biệt hoa/thường, bỏ khoảng trắng/xuống dòng ở hai đầu | `qr.test.ts`, `scenarios.test.tsx` |
| In nhầm/gõ nhầm O/0, I/L/1 | O→0, I/L→1 trước khi gửi. Đã kiểm chứng với `deriveActivationCode` THẬT của server (300 mã): bảng chữ của server không có I, L, O, U nên phép ánh xạ không tạo va chạm; server so `toUpperCase().replace(/[^0-9A-Z]/g,'')` KHÔNG ánh xạ nên app phải (và đang) gửi mã đã chuẩn hóa. Chữ U bị từ chối trên máy | `qr.test.ts` |
| Thiết bị thuộc người khác / sai mã | Cùng một câu chung ("mã không đúng, hoặc thiết bị này đang thuộc tài khoản khác"), không lộ thông tin, kèm hướng dẫn thiết bị bán lại (chủ cũ "Gỡ thiết bị") | `scenarios.test.tsx` |
| Nhập sai mã nhiều lần (429 `too_many_attempts`) | Thông báo riêng + nút tạm khóa 30 giây để khỏi bấm dồn | `scenarios.test.tsx` |
| Hai người trong nhà cùng muốn xem một thiết bị | **Giới hạn hiện tại: mỗi thiết bị chỉ thuộc MỘT tài khoản Zalo** (server). Người nhà nhận cảnh báo bằng cách được thêm vào "Người nhận cảnh báo"; muốn xem biểu đồ phải dùng chung tài khoản. Chưa làm chia sẻ | — |
| Đổi tên: dấu tiếng Việt NFC/NFD, emoji, khoảng trắng, rỗng, dài | NFC trước khi đếm và gửi; bỏ ký tự vô hình/xuống dòng, gộp khoảng trắng; 1–60 ký tự đếm theo đơn vị UTF-16 như server (emoji = 2); tên rất dài tự xuống dòng; hiển thị dạng chữ (không chạy HTML) | `text.test.ts`, `scenarios.test.tsx` |
| Tủ đông gia đình chạy -12°C mà chọn "Tủ đông" (-18°C) | Hiện nhiệt độ hiện tại cạnh form; cảnh báo "Nhiệt độ hiện tại -12,0°C đang vượt ngưỡng mới; báo động sẽ chỉ bật sau khi tủ đạt ngưỡng…" (cập nhật ngay khi gõ); giải thích "Cao nhất/Thấp nhất"; có câu xem trước "Sẽ báo khi…" | `thresholds.test.ts`, `scenarios.test.tsx` |
| Gõ "-18,5", "−18", "－１８", "18." | Đều đọc đúng; "1,2,3", "1e3", chữ => báo lỗi đúng ô, focus vào ô lỗi | `thresholds.test.ts` |
| Đổi ngưỡng làm server đặt lại "armed" | Không gửi PATCH nếu không đổi gì; sau khi lưu đọc lại danh sách và báo "Đang chờ tủ đạt ngưỡng mới, chưa cảnh báo" nếu `armed=false` | `scenarios.test.tsx` |
| `armed=false`, `recipient_count=0`, `notify_failures_24h>0` | "Đang chờ tủ đạt nhiệt độ, chưa cảnh báo."; "Chưa có người nhận cảnh báo — sẽ không có tin nhắn nào được gửi." + nút tới màn hình người nhận (cả ở danh sách); "Không gửi được tin cho một số người nhận, hãy kiểm tra số điện thoại/Zalo." (cả ở màn hình người nhận). Server cũ (vắng trường) => không hiện gì | `notices.test.ts`, `scenarios.test.tsx` |
| Biểu đồ: 0/1 điểm, giá trị đồng nhất, NaN/Infinity, giá trị xa dải, khoảng mất kết nối dài, 2016 điểm | Không chia cho 0, mọi toạ độ hữu hạn (test duyệt từng số), trục luôn mở rộng để thấy dữ liệu, KHÔNG nội suy qua khoảng trống, điểm cuối chỉ bị coi là mất kết nối sau 15 phút + 1 khung 5 phút | `chart.test.ts` |
| Múi giờ, dấu thập phân | Luôn UTC+7 (số học, test với 4 múi giờ khác); dấu phẩy "−21,3°C" | `chart.test.ts`, `format.test.ts` |
| Màn hình 320 px, chữ to, mù màu, chế độ tối, chạm | Khung vẽ theo bề rộng thật (chữ SVG không co nhỏ), nhãn giờ thưa lại khi hẹp; vùng mất kết nối = gạch chéo, ngoài ngưỡng = hình thoi, ngưỡng = nét đứt, huy hiệu có ký hiệu ✓ ! ✕ … kèm chữ; tóm tắt bằng chữ cho trình đọc màn hình; mọi cặp màu đạt WCAG AA 4.5:1 ở cả sáng và tối; nút/ô nhập cao ≥ 48 px; cho phép phóng to (đã bỏ `maximum-scale=1`) | `chart.test.ts`, `css/contrast.test.ts`, `scenarios.test.tsx` (chưa nhìn trên máy thật) |
| Thiết bị chưa có số đo | "Chưa có dữ liệu — cắm điện và kết nối Wi-Fi cho thiết bị" + các bước: nối Wi-Fi `Auhono-XXXX`, `192.168.4.1`, chỉ Wi-Fi 2.4 GHz, đèn sáng liên tục là xong, giữ nút 5 giây để mở lại cổng cấu hình (theo `firmware/README.md`) | `scenarios.test.tsx` |
| Mất kết nối / đang báo động | Mất kết nối: giờ nhận số đo cuối + "chưa chắc là tủ hỏng: mất điện, Wi-Fi, đứt dây đầu dò". Báo động: nóng/lạnh hơn ngưỡng nào, nhiệt độ hiện tại, "từ khoảng HH:MM" (suy từ biểu đồ) | `scenarios.test.tsx`, `chart.test.ts` |
| Cảnh báo đến chậm | Trợ giúp "Cảnh báo hoạt động thế nào?" (ngưỡng liên tục N phút, mất kết nối sau 15 phút, nhắc lại, tủ mới chưa bật, người nhận cần có Zalo/chặn OA) ở màn hình chính và chi tiết | `scenarios.test.tsx` |
| Số điện thoại | `0912345678`, `+84 (0) 912…`, `0084…`, số toàn chiều rộng => `84912345678`; số bàn / 11 số cũ / thiếu / thừa số => câu giải thích riêng; trùng bị chặn; tối đa 5; xóa người cuối => cảnh báo trước và sau; nhắc người nhận cần có Zalo | `phone.test.ts`, `scenarios.test.tsx` |
| Lỗi lập trình bất ngờ | `ErrorBoundary`: "Ứng dụng gặp sự cố" + nút mở lại thay vì màn hình trắng | `scenarios.test.tsx` |
| Tên/chuỗi độc hại từ server | Chỉ hiển thị dạng chữ | `scenarios.test.tsx`, `security.test.ts` |

## Chưa xác minh trong Zalo thật

Toàn bộ kiểm thử ở trên chạy trong Node/jsdom với `zmp-sdk` và `fetch` giả lập. **Chưa** kiểm chứng (cần thử tay trên Android + iOS, Zalo bản mới và cũ):

- Hành vi thật của `getAccessToken` sau nhiều giờ ở nền, hộp thoại `authorize`, và việc `authorize({})` không tham số có nghĩa gì (app chỉ quyết định theo việc có token hay không).
- `scanQRCode` báo lỗi gì khi đóng camera/từ chối quyền; `checkZaloCameraPermission`/`requestCameraPermission` có phân biệt được đúng như code giả định.
- `getSystemInfo().zaloTheme === 'dark'` và `prefers-color-scheme` trong webview Zalo có phản ánh chế độ tối không; giao diện tối có đọc được không (Header/Modal của `zmp-ui`).
- `document.visibilitychange`, sự kiện `online`/`offline`, `ResizeObserver` trong webview Zalo (nếu thiếu: tự làm mới chỉ chạy theo hẹn giờ, biểu đồ dùng bề rộng đo lúc đầu/`resize`).
- `useLocation().key === 'default'` có đúng nghĩa "mở thẳng, không có lịch sử" với router của `zmp-ui`; nút Back của Zalo/Header khi mở thẳng một màn hình con.
- Bố cục thực tế ở 320 px, chữ hệ thống to (font scale 130–200%), ngoài nắng, bàn phím che ô nhập; nhãn trục biểu đồ có chồng nhau khi chữ to (đã tính toán khoảng cách nhãn ≥ 44 px nhưng chưa nhìn).
- Độ chính xác hiệu chỉnh đồng hồ trên 3G thật (dùng điểm giữa lúc gửi và lúc nhận; sai số tối đa bằng nửa độ trễ khứ hồi).
- Màu chủ đạo thật `--zaui-light-color-primary` của Zalo (test độ tương phản dùng màu dự phòng `#006af5`).
- Origin thật của Mini App phía CORS, `Retry-After`/`Cache-Control` của Cloudflare, tin ZNS thật tới người nhận.
- Bundle: 117,9 kB gzip cho JS (`vite build`, đo lúc viết); tải thật trên Zalo có thể khác do CDN của Zalo.

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
- [ ] Nút "Làm mới" cập nhật số liệu; mạng yếu/tắt mạng cho thông báo dễ hiểu, nút "Thử lại" và vẫn thấy số liệu cũ kèm giờ cập nhật.
- [ ] Để màn hình chi tiết mở khi làm nóng tủ: biểu đồ tự cập nhật sau ≤ 60 giây; khoá máy 5 phút rồi mở lại: cập nhật ngay.
- [ ] Chỉnh giờ điện thoại lệch 1 giờ (tắt "giờ tự động"): trạng thái/giờ hiển thị vẫn đúng.
- [ ] Tắt mạng điện thoại 20 phút rồi bật lại: thiết bị KHÔNG bị hiện "Mất kết nối" oan.
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
- [ ] Chế độ tối của Zalo: giao diện chuyển sang tối, chữ/huy hiệu/biểu đồ đọc được, Header và hộp thoại của `zmp-ui` không bị trắng-trên-trắng.
- [ ] Cỡ chữ hệ thống lớn nhất: không tràn ngang, nhãn trên biểu đồ không chồng, nút không bị cắt.

## Kích thước bản build

`npm run build` (Vite 5, target es2015): JS **117,9 kB gzip** (377 kB thô), CSS 16,3 kB gzip (đo lúc viết, sau khi thêm tự làm mới, đổi tên, chế độ tối...). Phần lớn là react-dom, react-router, `zmp-ui` (và `zod` do `zmp-sdk` kéo vào)
cùng toàn bộ `zaui.css` (import nguyên tệp; có thể thu nhỏ sau bằng cách chỉ nạp phần CSS của các component đang dùng). Ngân sách đặt ra: JS gzip dưới ~130 kB.

## Hạn chế và việc còn lại

- **Mỗi thiết bị chỉ thuộc một tài khoản Zalo** (theo server). Người nhà chỉ nhận được tin cảnh báo (được thêm làm "người nhận"), không xem được biểu đồ bằng tài khoản riêng. Chưa làm chia sẻ.
- Không có nút "chuyển thiết bị cho người khác" mà không cần chủ cũ: nếu chủ cũ không còn liên lạc được, phải nhờ nơi bán gỡ phía server.
- Trang chi tiết phải tải cả danh sách thiết bị rồi lọc (server chưa có `GET /v1/devices/:id`); "vượt ngưỡng từ khi nào" được SUY từ biểu đồ 24 giờ (server chưa trả thời điểm bắt đầu báo động).
- Chưa xem lịch sử > 7 ngày (`/v1/devices/:id/history`).
- Chế độ tối đã làm nhưng chưa kiểm chứng trong Zalo (xem mục trên).
- Không có Web Push/thông báo đẩy: cảnh báo đến qua tin Zalo (ZNS) từ server; app chỉ là nơi xem và cấu hình.
- `zmp-cli.json` và cấu trúc thư mục được viết tay theo khuôn zmp-cli (không chạy được `zmp init` vì môi trường phát triển không tải được template); nếu `zmp start`/`zmp deploy` phàn nàn, tạo dự án mẫu bằng `zmp init` (Vite 5 + TypeScript) rồi chép `src/`, `app-config.json`, `index.html` sang.
