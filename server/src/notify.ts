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

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 25;

interface PendingRow {
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

/** Gửi các tin đang chờ. Trả về số tin gửi thành công. */
export async function dispatchPending(db: D1Database, notifier: Notifier, now: number): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT n.id, n.phone, n.attempts, e.kind, e.ts, e.temp_c, e.detail,
              d.name AS device_name, d.min_c, d.max_c
       FROM notifications n
       JOIN alert_events e ON e.id = n.event_id
       JOIN devices d ON d.id = e.device_id
       WHERE n.status = 'pending' AND n.attempts < ?
       ORDER BY n.id LIMIT ?`,
    )
    .bind(MAX_ATTEMPTS, BATCH_SIZE)
    .all<PendingRow>();

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
      await db
        .prepare("UPDATE notifications SET status = 'sent', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ?")
        .bind(now, n.id)
        .run();
      sent++;
    } catch (err) {
      const attempts = n.attempts + 1;
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      await db
        .prepare('UPDATE notifications SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?')
        .bind(attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', attempts, message, now, n.id)
        .run();
    }
  }
  return sent;
}
