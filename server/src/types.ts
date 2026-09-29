export interface Env {
  DB: D1Database;
  /** Bí mật gốc: suy ra khóa thiết bị + mã kích hoạt. `wrangler secret put MASTER_SECRET`. */
  MASTER_SECRET: string;
  ALLOWED_ORIGINS: string;
  ZNS_TEMPLATE_ALERT: string;
  ZNS_TEMPLATE_OFFLINE: string;
  ZNS_TEMPLATE_RECOVERED: string;
  /** Telegram (tùy chọn): bot token, bí mật webhook, tên bot (không có @), chat_id người vận hành. */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_USERNAME?: string;
  OPERATOR_TELEGRAM_CHAT_ID?: string;
  ZALO_APP_ID?: string;
  ZALO_APP_SECRET?: string;
  /** Chỉ dùng để khởi tạo lần đầu; sau đó token xoay vòng được giữ trong bảng kv. */
  ZALO_OA_REFRESH_TOKEN?: string;
}

export interface DeviceRow {
  id: string;
  account_id: number | null;
  claimed_at: number | null;
  paused_until: number | null;
  name: string;
  kind: 'freezer' | 'chiller';
  min_c: number;
  max_c: number;
  breach_minutes: number;
  last_seq: number;
  last_seen: number | null;
  last_reading_at: number | null;
  diag_json: string | null;
  diag_at: number | null;
  firmware: string | null;
  revoked: number;
  created_at: number;
}

/** Ngưỡng mặc định theo loại tủ (khách chọn "tủ đông"/"tủ mát", không tự nghĩ con số). */
export const KIND_PRESETS = {
  freezer: { min_c: -40, max_c: -18 },
  chiller: { min_c: 2, max_c: 8 },
} as const;
