// Kênh Telegram: miễn phí, không cần duyệt mẫu tin. Dùng làm bản sao/dự phòng của ZNS và để báo người vận hành.
//
// Liên kết một người nhận: app gọi POST /v1/devices/:id/recipients/:rid/telegram-link → nhận liên kết
// https://t.me/<bot>?start=<token>. Người nhận mở liên kết, bấm Start → Telegram gọi webhook của ta với
// "/start <token>" → ta lưu chat_id vào người nhận đó. Token dùng một lần, hết hạn sau 24 giờ.
import { timingSafeEqualStr } from './crypto.ts';
import { PermanentNotifyError, type NotificationMessage, type Notifier } from './notify.ts';
import type { Env } from './types.ts';
import { formatVnTime } from './zns.ts';

const API = 'https://api.telegram.org';
export const LINK_TTL_SECONDS = 24 * 3600;

/** Nội dung tin (văn bản thường, không parse_mode: tên tủ do người dùng đặt nên không được diễn giải). */
export function telegramText(m: NotificationMessage): string {
  const temp = m.tempC === null ? '' : ` (${m.tempC.toFixed(1).replace('.', ',')}°C)`;
  const time = formatVnTime(m.ts);
  const threshold = m.detail === 'low' ? `tối thiểu ${m.minC}°C` : `tối đa ${m.maxC}°C`;
  switch (m.kind) {
    case 'temp_alarm':
      return `🔴 ${m.deviceName}: nhiệt độ vượt ngưỡng${temp} lúc ${time} (${threshold}). Hãy kiểm tra tủ.`;
    case 'temp_reminder':
      return `🔴 Nhắc lại: ${m.deviceName} vẫn ngoài ngưỡng${temp} (${threshold}). Hãy kiểm tra tủ.`;
    case 'offline':
      return `⚠️ ${m.deviceName} không gửi được dữ liệu (tính đến ${time}). Có thể mất điện, mất Wi-Fi hoặc đứt dây đầu dò. Hãy kiểm tra.`;
    case 'offline_reminder':
      return `⚠️ Nhắc lại: ${m.deviceName} vẫn không gửi được dữ liệu. Có thể mất điện, mất Wi-Fi hoặc đứt dây đầu dò.`;
    case 'recovered':
      return `✅ ${m.deviceName} đã trở lại bình thường lúc ${time}${temp}.`;
    case 'reconnected':
      return `✅ ${m.deviceName} đã kết nối lại lúc ${time}${temp}.`;
  }
}

interface TgResponse {
  ok?: boolean;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

/** Gửi một tin; ném PermanentNotifyError khi người dùng đã chặn bot/chat không còn. */
export async function sendTelegram(
  token: string,
  chatId: string | number,
  text: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  let res: Response;
  try {
    res = await fetchFn(`${API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error('Telegram không truy cập được'); // tạm thời: thử lại
  }
  const body = (await res.json().catch(() => ({}))) as TgResponse;
  if (res.ok && body.ok) return;
  // 403: người dùng chặn bot / bị kick. 400: chat không tồn tại. Thử lại vô ích.
  if (body.error_code === 403 || body.error_code === 400) {
    throw new PermanentNotifyError(`Telegram ${body.error_code}: ${body.description ?? ''}`.trim());
  }
  throw new Error(`Telegram lỗi ${body.error_code ?? res.status}${body.parameters?.retry_after ? ` (thử lại sau ${body.parameters.retry_after}s)` : ''}`);
}

export class TelegramNotifier implements Notifier {
  constructor(
    private token: string,
    private fetchFn: typeof fetch = fetch,
  ) {}
  send(msg: NotificationMessage): Promise<void> {
    return sendTelegram(this.token, msg.target, telegramText(msg), this.fetchFn);
  }
}

/** Báo người vận hành (bạn) khi hệ thống có vấn đề. Không bao giờ ném lỗi. */
export async function notifyOperator(env: Env, text: string, fetchFn: typeof fetch = fetch): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.OPERATOR_TELEGRAM_CHAT_ID) return;
  try {
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.OPERATOR_TELEGRAM_CHAT_ID, `[Auhono] ${text}`.slice(0, 1000), fetchFn);
  } catch (err) {
    console.error('notifyOperator failed:', err instanceof Error ? err.message : err);
  }
}

// ───────── Webhook ─────────

interface TgUpdate {
  message?: { text?: string; chat?: { id?: number; type?: string } };
}

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Xử lý một update từ Telegram. `reply` được tiêm vào để test. Không ném lỗi. */
export async function handleTelegramUpdate(
  db: D1Database,
  update: TgUpdate,
  now: number,
  reply: (chatId: number, text: string) => Promise<void>,
): Promise<void> {
  const chat = update.message?.chat;
  const text = (update.message?.text ?? '').trim();
  // Chỉ nhận chat riêng: không liên kết cảnh báo vào nhóm/kênh do ai đó thêm bot vào.
  if (!chat || chat.type !== 'private' || typeof chat.id !== 'number') return;

  const start = /^\/start(?:@\w+)?\s+(\S+)$/.exec(text);
  if (start) {
    const token = start[1]!;
    if (!TOKEN_RE.test(token)) return void (await reply(chat.id, 'Liên kết không hợp lệ. Hãy tạo liên kết mới trong ứng dụng Auhono.'));
    const link = await db
      .prepare(
        `SELECT l.recipient_id, d.name AS device_name FROM telegram_links l
         JOIN recipients r ON r.id = l.recipient_id JOIN devices d ON d.id = r.device_id
         WHERE l.token = ? AND l.expires_at > ?`,
      )
      .bind(token, now)
      .first<{ recipient_id: number; device_name: string }>();
    if (!link) return void (await reply(chat.id, 'Liên kết đã hết hạn hoặc đã dùng. Hãy tạo liên kết mới trong ứng dụng Auhono.'));
    await db.batch([
      // Vừa liên kết thì nhận cả hai kênh (Zalo + Telegram); có thể đổi trong ứng dụng.
      db
        .prepare("UPDATE recipients SET telegram_chat_id = ?, mode = CASE WHEN mode = 'zns' THEN 'both' ELSE mode END WHERE id = ?")
        .bind(chat.id, link.recipient_id),
      db.prepare('DELETE FROM telegram_links WHERE recipient_id = ?').bind(link.recipient_id),
    ]);
    return void (await reply(chat.id, `✅ Đã kết nối. Bạn sẽ nhận cảnh báo của "${link.device_name}" qua Telegram. Gửi /stop để ngừng nhận.`));
  }

  if (/^\/stop(?:@\w+)?$/.test(text)) {
    await db
      .prepare("UPDATE recipients SET telegram_chat_id = NULL, mode = 'zns' WHERE telegram_chat_id = ?")
      .bind(chat.id)
      .run();
    return void (await reply(chat.id, 'Đã ngừng nhận cảnh báo qua Telegram. Bạn vẫn nhận tin Zalo nếu đã đăng ký.'));
  }

  await reply(chat.id, 'Xin chào! Để nhận cảnh báo tủ đông, hãy mở liên kết "Nhận thêm qua Telegram" trong ứng dụng Auhono.');
}

/** Kiểm tra header bí mật của webhook (so sánh thời gian không đổi). */
export async function verifyWebhookSecret(env: Env, header: string | undefined): Promise<boolean> {
  if (!env.TELEGRAM_WEBHOOK_SECRET || !header) return false;
  return timingSafeEqualStr(header, env.TELEGRAM_WEBHOOK_SECRET);
}
