-- Auhono: lược đồ ban đầu. Thời gian luôn là unix epoch GIÂY (UTC).

-- Chủ quán (định danh bằng Zalo user id, lấy từ access token của Mini App).
CREATE TABLE accounts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  zalo_id    TEXT NOT NULL UNIQUE,
  name       TEXT,
  created_at INTEGER NOT NULL
);

-- Thiết bị. Khóa bí mật và mã kích hoạt KHÔNG lưu ở đây: được suy ra từ
-- MASTER_SECRET + id (xem src/crypto.ts), nên lộ DB không lộ khóa thiết bị.
CREATE TABLE devices (
  id             TEXT PRIMARY KEY,                       -- ví dụ AUH-000001
  account_id     INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  paused_until   INTEGER,                                -- tạm dừng cảnh báo (đóng cửa nghỉ Tết, rút điện có chủ ý)
  claimed_at     INTEGER,                                -- lúc gắn chủ (phát hiện thiết bị chưa từng kết nối)
  name           TEXT NOT NULL DEFAULT 'Tủ lạnh',
  kind           TEXT NOT NULL DEFAULT 'freezer' CHECK (kind IN ('freezer', 'chiller')),
  min_c          REAL NOT NULL DEFAULT -30,              -- ngưỡng dưới (°C)
  max_c          REAL NOT NULL DEFAULT -18,              -- ngưỡng trên (°C)
  breach_minutes INTEGER NOT NULL DEFAULT 15,            -- vượt ngưỡng liên tục bao lâu mới báo
  last_seq       INTEGER NOT NULL DEFAULT 0,             -- chống phát lại gói cũ
  last_seen      INTEGER,                                -- lần cuối nhận số đo hợp lệ
  firmware       TEXT,
  revoked        INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_devices_account ON devices(account_id);

-- Người nhận cảnh báo (số điện thoại dạng 84xxxxxxxxx, đúng định dạng ZNS).
CREATE TABLE recipients (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (device_id, phone)
);

-- Số đo chi tiết, giữ 7 ngày rồi gộp thành trung bình theo giờ.
CREATE TABLE readings (
  device_id TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  temp_c    REAL NOT NULL,
  PRIMARY KEY (device_id, ts)
) WITHOUT ROWID;

CREATE TABLE readings_hourly (
  device_id TEXT NOT NULL,
  hour_ts   INTEGER NOT NULL,   -- đầu giờ (chia hết cho 3600)
  avg_c     REAL NOT NULL,
  min_c     REAL NOT NULL,
  max_c     REAL NOT NULL,
  n         INTEGER NOT NULL,
  PRIMARY KEY (device_id, hour_ts)
) WITHOUT ROWID;

-- Trạng thái máy trạng thái cảnh báo của từng thiết bị (xem src/alerts.ts).
CREATE TABLE alert_state (
  device_id        TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  phase            TEXT NOT NULL DEFAULT 'ok' CHECK (phase IN ('ok', 'temp_alarm', 'offline')),
  breach_kind      TEXT CHECK (breach_kind IN ('high', 'low')),
  breach_since     INTEGER,   -- ts của số đo đầu tiên trong chuỗi vượt ngưỡng liên tục
  in_range_since   INTEGER,   -- đang báo động mà số đo đã về bình thường từ lúc nào
  last_ts          INTEGER,   -- ts số đo mới nhất đã đưa vào máy trạng thái (bỏ qua số đo cũ hơn)
  acked_until      INTEGER,   -- chủ quán bấm "đã biết": không nhắc lại tới mốc này
  armed            INTEGER NOT NULL DEFAULT 0,  -- đã thấy nhiệt độ trong ngưỡng => cho phép báo động
  version          INTEGER NOT NULL DEFAULT 0,  -- khóa lạc quan: mọi thay đổi trạng thái đều so-và-tăng version
  last_notified_at INTEGER,
  reminders_sent   INTEGER NOT NULL DEFAULT 0
);

-- Sự kiện cảnh báo + hàng đợi gửi (outbox): ghi cùng lúc với đổi trạng thái,
-- gửi tin thất bại thì cron thử lại, không mất cảnh báo.
CREATE TABLE alert_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  token     TEXT NOT NULL UNIQUE,   -- định danh ngẫu nhiên: gắn tin nhắn đúng sự kiện, không phụ thuộc last_insert_rowid()
  device_id TEXT NOT NULL,
  kind      TEXT NOT NULL,   -- temp_alarm | temp_reminder | offline | offline_reminder | recovered | reconnected
  ts        INTEGER NOT NULL,
  temp_c    REAL,
  detail    TEXT
);
CREATE INDEX idx_alert_events_device ON alert_events(device_id, ts);

CREATE TABLE notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL REFERENCES alert_events(id) ON DELETE CASCADE,
  phone      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'suppressed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_notifications_pending ON notifications(status) WHERE status IN ('pending', 'sending');
CREATE INDEX idx_notifications_event ON notifications(event_id);

-- Kho khóa-giá trị nhỏ (token Zalo OA, cần lưu vì refresh token xoay vòng).
CREATE TABLE kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Bản firmware cho OTA. Chip tự kiểm tra sha256 + chữ ký ECDSA P-256 (DER, hex) trước khi cài.
CREATE TABLE firmware_releases (
  version    TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  signature  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Đếm lần nhập sai mã kích hoạt theo tài khoản (chặn dò mã).
CREATE TABLE claim_failures (
  account_id INTEGER NOT NULL,
  ts         INTEGER NOT NULL
);
CREATE INDEX idx_claim_failures ON claim_failures(account_id, ts);
