// Gửi tin: đọc hàng đợi `notifications`, gọi Notifier, cập nhật trạng thái/thử lại.
// Notifier là giao diện nhỏ để đổi kênh (ZNS -> SMS/push) mà không đụng logic cảnh báo.
import type { AlertEventKind } from './alerts.ts';

export interface NotificationMessage {
  phone: string;
  kind: AlertEventKind;
  deviceName: string;
  tempC: number | null;
  /** 'high' | 'low' khi là cảnh báo nhiệt độ. */
  detail: string | null;
  ts: number;
  minC: number;
  maxC: number;
}

export interface Notifier {
  /** Ném lỗi nếu gửi thất bại (sẽ được thử lại). */
  send(msg: NotificationMessage): Promise<void>;
}

/** Dùng khi chưa cấu hình ZNS (dev/test): chỉ ghi log. */
export class LogNotifier implements Notifier {
  async send(msg: NotificationMessage): Promise<void> {
    console.log(`[notify] ${msg.kind} -> ${msg.phone.slice(0, 4)}***: ${msg.deviceName} ${msg.tempC ?? ''}`);
  }
}

/** Số lần gửi tối đa cho một tin; thất bại cách quãng dần (5, 10, 15... phút) nên chịu được ZNS lỗi vài giờ. */
export const MAX_ATTEMPTS = 8;
const BATCH_SIZE = 20;
/** Tin ở trạng thái 'sending' quá lâu (tiến trình chết giữa chừng) sẽ được đưa về hàng đợi. */
const STALE_SENDING_SECONDS = 300;
const RETRY_STEP_SECONDS = 300;

interface ClaimedRow {
  id: number;
  phone: string;
  attempts: number;
  kind: AlertEventKind;
  ts: number;
  temp_c: number | null;
  detail: string | null;
  device_name: string;
  min_c: number;
  max_c: number;
}

/**
 * Gửi các tin đang chờ, trả về số tin gửi thành công.
 *
 * Cron và request thiết bị có thể gọi hàm này cùng lúc, nên tin được "nhận việc" bằng một UPDATE
 * nguyên tử (pending -> sending): mỗi tin chỉ một bên gửi. Số lần thử tăng ngay lúc nhận, nên dù tiến
 * trình chết giữa chừng cũng không gửi lặp vô hạn. Chỉ dùng ít truy vấn D1 (gói miễn phí giới hạn 50/lượt).
 */
export async function dispatchPending(db: D1Database, notifier: Notifier, now: number): Promise<number> {
  await db
    .prepare("UPDATE notifications SET status = 'pending' WHERE status = 'sending' AND updated_at < ?")
    .bind(now - STALE_SENDING_SECONDS)
    .run();

  const claimed = await db
    .prepare(
      `UPDATE notifications SET status = 'sending', attempts = attempts + 1, updated_at = ?1
       WHERE id IN (
         SELECT id FROM notifications
         WHERE status = 'pending' AND attempts < ?2 AND updated_at <= ?1 - attempts * ?3
         ORDER BY id LIMIT ?4)
       RETURNING id`,
    )
    .bind(now, MAX_ATTEMPTS, RETRY_STEP_SECONDS, BATCH_SIZE)
    .all<{ id: number }>();
  if (claimed.results.length === 0) return 0;

  const ids = claimed.results.map((r) => r.id);
  const { results } = await db
    .prepare(
      `SELECT n.id, n.phone, n.attempts, e.kind, e.ts, e.temp_c, e.detail,
              d.name AS device_name, d.min_c, d.max_c
       FROM notifications n
       JOIN alert_events e ON e.id = n.event_id
       JOIN devices d ON d.id = e.device_id
       WHERE n.id IN (${ids.map(() => '?').join(',')})`,
    )
    .bind(...ids)
    .all<ClaimedRow>();

  const updates: D1PreparedStatement[] = [];
  let sent = 0;
  for (const n of results) {
    try {
      await notifier.send({
        phone: n.phone,
        kind: n.kind,
        deviceName: n.device_name,
        tempC: n.temp_c,
        detail: n.detail,
        ts: n.ts,
        minC: n.min_c,
        maxC: n.max_c,
      });
      updates.push(
        db.prepare("UPDATE notifications SET status = 'sent', last_error = NULL, updated_at = ? WHERE id = ?").bind(now, n.id),
      );
      sent++;
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      updates.push(
        db
          .prepare('UPDATE notifications SET status = ?, last_error = ?, updated_at = ? WHERE id = ?')
          .bind(n.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', message, now, n.id),
      );
    }
  }
  // Tin nhận việc nhưng không còn dữ liệu liên kết (thiết bị bị xóa): đóng lại, đừng để kẹt ở 'sending'.
  const found = new Set(results.map((r) => r.id));
  for (const id of ids) {
    if (!found.has(id)) updates.push(db.prepare("UPDATE notifications SET status = 'failed', last_error = 'orphan' WHERE id = ?").bind(id));
  }
  if (updates.length > 0) await db.batch(updates);
  return sent;
}
