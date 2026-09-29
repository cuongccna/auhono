// Gửi tin ZNS (Zalo Notification Service) qua Zalo OA.
// LƯU Ý: chưa kiểm chứng với API Zalo thật (cần OA + template đã duyệt). Xem docs/zns-templates.md.
import type { NotificationMessage, Notifier } from './notify.ts';
import type { Env } from './types.ts';

const ZNS_URL = 'https://business.openapi.zalo.me/message/template';
const OAUTH_URL = 'https://oauth.zaloapp.com/v4/oa/access_token';
const TOKEN_KEY = 'zalo_oa_tokens';
/** Mã lỗi Zalo cho access token hết hạn/không hợp lệ. */
const TOKEN_ERRORS = new Set([-124, -216]);

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch giây
}

/** Chọn template theo loại sự kiện. Trả về '' nếu chưa cấu hình. */
export function templateFor(env: Env, kind: NotificationMessage['kind']): string {
  switch (kind) {
    case 'temp_alarm':
    case 'temp_reminder':
      return env.ZNS_TEMPLATE_ALERT;
    case 'offline':
    case 'offline_reminder':
      return env.ZNS_TEMPLATE_OFFLINE;
    case 'recovered':
    case 'reconnected':
      return env.ZNS_TEMPLATE_RECOVERED;
  }
}

/** Định dạng giờ Việt Nam: "14:05 29/09". Template ZNS chỉ nhận chuỗi. */
export function formatVnTime(ts: number): string {
  const d = new Date((ts + 7 * 3600) * 1000); // UTC+7, không có DST
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} ${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}`;
}

/** Dữ liệu điền vào template. Tên khóa phải khớp đúng mẫu đã đăng ký với Zalo. */
export function templateData(m: NotificationMessage): Record<string, string> {
  const threshold = m.detail === 'low' ? `tối thiểu ${m.minC}°C` : `tối đa ${m.maxC}°C`;
  return {
    device_name: m.deviceName,
    temperature: m.tempC === null ? '--' : `${m.tempC.toFixed(1)}°C`,
    threshold,
    time: formatVnTime(m.ts),
  };
}

export class ZnsNotifier implements Notifier {
  constructor(
    private env: Env,
    private now: () => number = () => Math.floor(Date.now() / 1000),
    private fetchFn: typeof fetch = fetch,
  ) {}

  async send(msg: NotificationMessage): Promise<void> {
    const template = templateFor(this.env, msg.kind);
    if (!template) throw new Error(`ZNS template chưa cấu hình cho ${msg.kind}`);

    let token = await this.getAccessToken(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.fetchFn(ZNS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', access_token: token },
        body: JSON.stringify({
          phone: msg.phone,
          template_id: template,
          template_data: templateData(msg),
          tracking_id: `${msg.kind}-${msg.ts}-${msg.phone}`.slice(0, 48),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: number; message?: string };
      if (res.ok && body.error === 0) return;
      if (attempt === 0 && body.error !== undefined && TOKEN_ERRORS.has(body.error)) {
        token = await this.getAccessToken(true); // token hết hạn: làm mới rồi thử lại 1 lần
        continue;
      }
      throw new Error(`ZNS lỗi ${body.error ?? res.status}: ${body.message ?? ''}`);
    }
  }

  private async loadTokens(): Promise<Tokens | null> {
    const row = await this.env.DB.prepare('SELECT value FROM kv WHERE key = ?').bind(TOKEN_KEY).first<{ value: string }>();
    return row ? (JSON.parse(row.value) as Tokens) : null;
  }

  private async getAccessToken(force: boolean): Promise<string> {
    const cached = await this.loadTokens();
    if (cached && !force && cached.expires_at - this.now() > 300) return cached.access_token;

    const refreshToken = cached?.refresh_token ?? this.env.ZALO_OA_REFRESH_TOKEN;
    if (!refreshToken || !this.env.ZALO_APP_ID || !this.env.ZALO_APP_SECRET) {
      throw new Error('Thiếu cấu hình Zalo OA (ZALO_APP_ID/ZALO_APP_SECRET/refresh token)');
    }
    const res = await this.fetchFn(OAUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', secret_key: this.env.ZALO_APP_SECRET },
      body: new URLSearchParams({
        app_id: this.env.ZALO_APP_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: string | number;
    };
    if (!body.access_token || !body.refresh_token) {
      // Refresh token dùng một lần: nếu tiến trình khác vừa làm mới thì dùng bản của nó.
      const latest = await this.loadTokens();
      if (latest && latest.refresh_token !== refreshToken) return latest.access_token;
      throw new Error('Làm mới token Zalo OA thất bại');
    }
    const tokens: Tokens = {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: this.now() + Number(body.expires_in ?? 3600),
    };
    await this.env.DB
      .prepare('INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3')
      .bind(TOKEN_KEY, JSON.stringify(tokens), this.now())
      .run();
    return tokens.access_token;
  }
}
