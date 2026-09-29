// HTTP API: (1) thiết bị ký HMAC, (2) chủ quán qua Zalo Mini App.
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import {
  canonicalString,
  deriveActivationCode,
  deriveDeviceKey,
  timingSafeEqualStr,
  verifyCanonical,
} from './crypto.ts';
import { ingest } from './ingest.ts';
import { dispatchPending, type Notifier } from './notify.ts';
import { AuthUnavailableError, zaloVerifier, type OwnerVerifier } from './owner-auth.ts';
import { getState, resetStateStmt } from './db.ts';
import { KIND_PRESETS, type DeviceRow, type Env } from './types.ts';

export interface Deps {
  now: () => number;
  verifyOwner: OwnerVerifier;
  /** Tạo Notifier cho request hiện tại (cần env để đọc cấu hình ZNS). */
  notifier: (env: Env) => Notifier;
}

type Vars = { device: DeviceRow; body: Uint8Array; accountId: number };
type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

/** Thiết bị đồng hồ lệch quá mức này (giây) so với server thì gói bị từ chối. */
export const MAX_CLOCK_SKEW = 300;
const MAX_BODY_BYTES = 4096;
const MAX_RECIPIENTS = 5;

/** Sai mã kích hoạt tối đa bao nhiêu lần / giờ / tài khoản (chặn dò mã). */
const MAX_CLAIM_FAILURES_PER_HOUR = 10;

const deviceIdRe = /^[A-Z0-9-]{3,32}$/;

/** Tên hiển thị: chuẩn hóa NFC (iOS/Android có thể gửi dạng tổ hợp), cắt khoảng trắng, 1–60 ký tự. */
const nameSchema = z.string().transform((v) => v.normalize('NFC').trim()).pipe(z.string().min(1).max(60));

/** Đọc body có giới hạn kích thước theo luồng: body khổng lồ bị ngắt sớm, không nạp hết vào bộ nhớ. */
async function readBodyCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export function createApp(deps: Deps) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  // CORS chỉ cho origin của Zalo Mini App (cấu hình ALLOWED_ORIGINS).
  app.use('*', (c, next) => {
    const allowed = c.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
    return cors({
      origin: (origin) => (allowed.includes(origin) ? origin : null),
      allowHeaders: ['Authorization', 'Content-Type'],
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    })(c, next);
  });
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'no-store');
  });

  app.get('/healthz', (c) => c.json({ ok: true }));
  // Chip dùng khi NTP lỗi để tự chỉnh giờ (không cần xác thực, không lộ gì).
  app.get('/v1/time', (c) => c.json({ server_time: deps.now() }));

  // ───────── Thiết bị (HMAC) ─────────

  async function deviceAuth(c: Ctx, next: () => Promise<void>) {
    const deviceId = c.req.header('X-Device-Id') ?? '';
    const ts = Number(c.req.header('X-Timestamp'));
    const seq = Number(c.req.header('X-Seq'));
    const sig = c.req.header('X-Signature') ?? '';
    const unauthorized = () => c.json({ error: 'unauthorized' }, 401);

    if (!deviceIdRe.test(deviceId) || !Number.isSafeInteger(ts) || !Number.isSafeInteger(seq) || seq < 0) {
      return unauthorized();
    }
    const declared = Number(c.req.header('Content-Length') ?? 0);
    if (declared > MAX_BODY_BYTES) return c.json({ error: 'too_large' }, 413);
    const body = await readBodyCapped(c.req.raw, MAX_BODY_BYTES);
    if (body === null) return c.json({ error: 'too_large' }, 413);

    // Luôn tính khóa + kiểm chữ ký TRƯỚC khi tra DB: thiết bị không tồn tại và chữ ký sai
    // cho cùng một phản hồi, không dò được mã thiết bị.
    const key = await deriveDeviceKey(c.env.MASTER_SECRET, deviceId);
    const canonical = await canonicalString({ method: c.req.method, path: c.req.path, deviceId, timestamp: ts, seq, body });
    if (!(await verifyCanonical(key, canonical, sig))) return unauthorized();

    const device = await c.env.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(deviceId).first<DeviceRow>();
    if (!device || device.revoked) return unauthorized();

    const now = deps.now();
    if (Math.abs(now - ts) > MAX_CLOCK_SKEW) {
      // Đã xác thực => trả giờ server để chip tự chỉnh đồng hồ.
      return c.json({ error: 'clock_skew', server_time: now }, 401);
    }
    // Chống phát lại: seq phải tăng nghiêm ngặt; UPDATE có điều kiện là nguyên tử.
    const upd = await c.env.DB
      .prepare('UPDATE devices SET last_seq = ?1 WHERE id = ?2 AND last_seq < ?1')
      .bind(seq, deviceId)
      .run();
    if (upd.meta.changes !== 1) return c.json({ error: 'replay', last_seq: device.last_seq }, 409);

    c.set('device', device);
    c.set('body', body);
    await next();
  }

  const readingsSchema = z.object({
    fw: z.string().max(32).optional(),
    readings: z
      .array(z.object({ t: z.number().int(), c: z.number().min(-60).max(125) }))
      .min(1)
      .max(20),
  });

  app.post('/v1/readings', deviceAuth, async (c) => {
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(c.get('body')));
    } catch {
      return c.json({ error: 'bad_request' }, 400);
    }
    const parsed = readingsSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);

    const device = c.get('device');
    const now = deps.now();
    const result = await ingest(
      c.env.DB,
      device,
      parsed.data.readings.map((r) => ({ ts: r.t, c: r.c })),
      now,
      parsed.data.fw,
    );
    // Có cảnh báo mới thì gửi ngay, không đợi cron 5 phút.
    if (result.events.length > 0) {
      c.executionCtx.waitUntil(dispatchPending(c.env.DB, deps.notifier(c.env), now).then(() => undefined));
    }
    // Trả ngưỡng để chip biết khi nào cần gửi ngay, và giờ server để hiệu chỉnh đồng hồ.
    return c.json({
      ok: true,
      accepted: result.accepted,
      server_time: now,
      config: { min_c: device.min_c, max_c: device.max_c },
    });
  });

  // OTA: chip hỏi có bản mới không. Đường dẫn (không gồm query) nằm trong chữ ký.
  app.get('/v1/ota/check', deviceAuth, async (c) => {
    const current = c.req.query('current') ?? '';
    const rel = await c.env.DB
      .prepare('SELECT version, url, sha256, signature FROM firmware_releases ORDER BY created_at DESC LIMIT 1')
      .first<{ version: string; url: string; sha256: string; signature: string }>();
    if (!rel || rel.version === current) return c.json({ update: false });
    return c.json({ update: true, ...rel });
  });

  // ───────── Chủ quán (Zalo access token) ─────────

  async function ownerAuth(c: Ctx, next: () => Promise<void>) {
    const m = /^Bearer (.{10,2048})$/.exec(c.req.header('Authorization') ?? '');
    let user: Awaited<ReturnType<OwnerVerifier>> = null;
    try {
      user = m ? await deps.verifyOwner(m[1]!) : null;
    } catch (err) {
      if (err instanceof AuthUnavailableError) return c.json({ error: 'auth_unavailable' }, 503);
      throw err;
    }
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    // Đọc trước, chỉ ghi khi tài khoản mới hoặc đổi tên (tiết kiệm lượt ghi D1: mỗi request app đều đi qua đây).
    const db = c.env.DB;
    const existing = await db.prepare('SELECT id, name FROM accounts WHERE zalo_id = ?').bind(user.id).first<{ id: number; name: string | null }>();
    if (existing && (user.name === null || existing.name === user.name)) {
      c.set('accountId', existing.id);
    } else {
      const row = await db
        .prepare(
          `INSERT INTO accounts (zalo_id, name, created_at) VALUES (?1, ?2, ?3)
           ON CONFLICT(zalo_id) DO UPDATE SET name = COALESCE(?2, name)
           RETURNING id`,
        )
        .bind(user.id, user.name, deps.now())
        .first<{ id: number }>();
      c.set('accountId', row!.id);
    }
    await next();
  }

  /** Lấy thiết bị của chủ quán hiện tại; không phải của họ => 404 (không lộ sự tồn tại). */
  async function ownedDevice(c: Ctx): Promise<DeviceRow | null> {
    return c.env.DB
      .prepare('SELECT * FROM devices WHERE id = ? AND account_id = ? AND revoked = 0')
      .bind(c.req.param('id') ?? '', c.get('accountId'))
      .first<DeviceRow>();
  }

  const claimSchema = z.object({
    device_id: z.string().regex(deviceIdRe),
    code: z.string().min(4).max(32),
    name: nameSchema.optional(),
    kind: z.enum(['freezer', 'chiller']).optional(),
  });

  // Kích hoạt: quét QR trên hộp (device_id + code) để gắn thiết bị vào tài khoản.
  app.post('/v1/devices/claim', ownerAuth, async (c) => {
    const parsed = claimSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const { device_id, code, name, kind = 'freezer' } = parsed.data;
    const accountId = c.get('accountId');
    const now = deps.now();

    // Chặn dò mã: quá nhiều lần sai trong 1 giờ thì từ chối mọi lần thử của tài khoản này.
    const fails = await c.env.DB
      .prepare('SELECT COUNT(*) AS n FROM claim_failures WHERE account_id = ? AND ts > ?')
      .bind(accountId, now - 3600)
      .first<{ n: number }>();
    if ((fails?.n ?? 0) >= MAX_CLAIM_FAILURES_PER_HOUR) {
      // Còn bao lâu tới khi lần sai cũ nhất trong cửa sổ 1 giờ hết hạn (để app hiện giờ cụ thể).
      const oldest = await c.env.DB
        .prepare('SELECT MIN(ts) AS ts FROM claim_failures WHERE account_id = ? AND ts > ?')
        .bind(accountId, now - 3600)
        .first<{ ts: number | null }>();
      const retryAfter = Math.max(1, (oldest?.ts ?? now) + 3600 - now);
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: 'too_many_attempts', retry_after: retryAfter }, 429);
    }

    const expected = await deriveActivationCode(c.env.MASTER_SECRET, device_id);
    const codeOk = await timingSafeEqualStr(code.toUpperCase().replace(/[^0-9A-Z]/g, ''), expected);
    const device = await c.env.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(device_id).first<DeviceRow>();
    // Sai mã / không tồn tại / đã thu hồi / đã có chủ khác: cùng một phản hồi.
    const mine = device?.account_id === accountId;
    if (!codeOk || !device || device.revoked || (device.account_id !== null && !mine)) {
      await c.env.DB.prepare('INSERT INTO claim_failures (account_id, ts) VALUES (?, ?)').bind(accountId, now).run();
      return c.json({ error: 'invalid_code' }, 404);
    }
    // Gọi lại khi đã là chủ (mất phản hồi lần trước, bấm đúp) thì coi như thành công, không đặt lại gì.
    if (!mine) {
      const preset = KIND_PRESETS[kind];
      await c.env.DB.batch([
        c.env.DB
          .prepare('UPDATE devices SET account_id = ?, claimed_at = ?, name = ?, kind = ?, min_c = ?, max_c = ? WHERE id = ? AND account_id IS NULL')
          .bind(accountId, now, name ?? device.name, kind, preset.min_c, preset.max_c, device_id),
        // Trạng thái mới: chưa "armed" cho tới khi tủ đạt ngưỡng (lắp vào tủ đang ấm không báo oan).
        resetStateStmt(c.env.DB, device_id),
      ]);
    }
    // already_owned: gọi lại khi đã là chủ (mất phản hồi/bấm đúp): name/kind trong request bị bỏ qua.
    return c.json({ ok: true, device_id, already_owned: mine });
  });

  type ListRow = DeviceRow & {
    phase: string | null;
    armed: number | null;
    acked_until: number | null;
    breach_since: number | null;
    last_notified_at: number | null;
    latest_ts: number | null;
    latest_c: number | null;
    recipient_count: number;
    notify_failures_24h: number;
  };

  const publicDevice = (d: ListRow) => ({
    id: d.id,
    name: d.name,
    kind: d.kind,
    min_c: d.min_c,
    max_c: d.max_c,
    breach_minutes: d.breach_minutes,
    last_seen: d.last_seen,
    claimed_at: d.claimed_at,
    firmware: d.firmware,
    phase: d.phase ?? 'ok',
    // false = chưa cảnh báo nhiệt độ vì tủ chưa đạt ngưỡng lần nào (mới lắp / mới đổi ngưỡng).
    armed: d.armed === 1,
    // Đang tạm dừng cảnh báo tới mốc này (null = không). Chủ quán "đã biết" một sự cố: không nhắc lại tới mốc này.
    paused_until: d.paused_until,
    acked_until: d.acked_until,
    // Báo động nhiệt độ bắt đầu từ lúc nào (số đo đầu tiên của chuỗi vượt ngưỡng) và lần gửi tin gần nhất.
    alarm_since: d.phase === 'temp_alarm' ? d.breach_since : null,
    last_notified_at: d.last_notified_at,
    // 0 = sẽ không có tin nhắn nào được gửi: app phải cảnh báo chủ quán.
    recipient_count: d.recipient_count,
    // > 0 = có tin không gửi được trong 24 giờ qua (sai số, chưa theo dõi OA...).
    notify_failures_24h: d.notify_failures_24h,
    latest: d.latest_ts === null ? null : { ts: d.latest_ts, temp_c: d.latest_c! },
  });

  /** Danh sách thiết bị của chủ quán (hoặc một thiết bị nếu có deviceId) kèm trạng thái. */
  async function listDevices(c: Ctx, deviceId: string | null) {
    const now = deps.now();
    const { results } = await c.env.DB
      .prepare(
        `SELECT d.*, s.phase AS phase, s.armed AS armed, s.acked_until AS acked_until,
           s.breach_since AS breach_since, s.last_notified_at AS last_notified_at,
           (SELECT ts FROM readings r WHERE r.device_id = d.id ORDER BY ts DESC LIMIT 1) AS latest_ts,
           (SELECT temp_c FROM readings r WHERE r.device_id = d.id ORDER BY ts DESC LIMIT 1) AS latest_c,
           (SELECT COUNT(*) FROM recipients rc WHERE rc.device_id = d.id) AS recipient_count,
           (SELECT COUNT(*) FROM alert_events ev JOIN notifications n ON n.event_id = ev.id
             WHERE ev.device_id = d.id AND n.status = 'failed' AND n.updated_at >= ?2) AS notify_failures_24h
         FROM devices d LEFT JOIN alert_state s ON s.device_id = d.id
         WHERE d.account_id = ?1 AND d.revoked = 0 AND (?3 IS NULL OR d.id = ?3) ORDER BY d.created_at`,
      )
      .bind(c.get('accountId'), now - 24 * 3600, deviceId)
      .all<ListRow>();
    return { now, devices: results.map(publicDevice) };
  }

  app.get('/v1/devices', ownerAuth, async (c) => {
    const { now, devices } = await listDevices(c, null);
    // Giờ server để app tính "mất kết nối"/"x phút trước" không phụ thuộc đồng hồ điện thoại.
    return c.json({ server_time: now, devices });
  });

  // Một thiết bị (trang chi tiết không phải tải cả danh sách).
  app.get('/v1/devices/:id', ownerAuth, async (c) => {
    const id = c.req.param('id') ?? '';
    if (!deviceIdRe.test(id)) return c.json({ error: 'not_found' }, 404);
    const { now, devices } = await listDevices(c, id);
    if (devices.length === 0) return c.json({ error: 'not_found' }, 404);
    return c.json({ server_time: now, device: devices[0] });
  });

  const patchSchema = z
    .object({
      name: nameSchema,
      kind: z.enum(['freezer', 'chiller']),
      min_c: z.number().min(-60).max(30),
      max_c: z.number().min(-60).max(30),
      breach_minutes: z.number().int().min(5).max(60),
    })
    .partial();

  app.patch('/v1/devices/:id', ownerAuth, async (c) => {
    const device = await ownedDevice(c);
    if (!device) return c.json({ error: 'not_found' }, 404);
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const p = parsed.data;

    // Đổi loại tủ mà không nêu ngưỡng => áp ngưỡng có sẵn của loại đó.
    const preset = p.kind ? KIND_PRESETS[p.kind] : null;
    const min_c = p.min_c ?? preset?.min_c ?? device.min_c;
    const max_c = p.max_c ?? preset?.max_c ?? device.max_c;
    if (min_c >= max_c) return c.json({ error: 'bad_range' }, 400);

    const stmts = [
      c.env.DB
        .prepare('UPDATE devices SET name = ?, kind = ?, min_c = ?, max_c = ?, breach_minutes = ? WHERE id = ?')
        .bind(p.name ?? device.name, p.kind ?? device.kind, min_c, max_c, p.breach_minutes ?? device.breach_minutes, device.id),
    ];
    // Đổi ngưỡng: nhiệt độ hiện tại có thể đang "ngoài" khoảng mới. Đặt lại trạng thái (hủy báo động
    // cũ không gửi "đã ổn", chờ tủ đạt ngưỡng mới) để không báo động dồn dập oan.
    if (min_c !== device.min_c || max_c !== device.max_c) stmts.push(resetStateStmt(c.env.DB, device.id));
    await c.env.DB.batch(stmts);
    return c.json({ ok: true });
  });

  // Gỡ thiết bị khỏi tài khoản (để chuyển cho khách khác). Xóa người nhận; giữ lịch sử số đo.
  app.delete('/v1/devices/:id', ownerAuth, async (c) => {
    const device = await ownedDevice(c);
    if (!device) return c.json({ error: 'not_found' }, 404);
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM recipients WHERE device_id = ?').bind(device.id),
      c.env.DB.prepare('UPDATE devices SET account_id = NULL, claimed_at = NULL, paused_until = NULL WHERE id = ?').bind(device.id),
      resetStateStmt(c.env.DB, device.id),
    ]);
    return c.json({ ok: true });
  });

  // "Đã biết": dừng nhắc lại một sự cố đang diễn ra trong N giờ (mặc định 4). Nhắc tiếp nếu hết hạn mà chưa xong.
  app.post('/v1/devices/:id/ack', ownerAuth, async (c) => {
    const device = await ownedDevice(c);
    if (!device) return c.json({ error: 'not_found' }, 404);
    const parsed = z.object({ hours: z.number().int().min(1).max(24).default(4) }).safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);

    const { state } = await getState(c.env.DB, device.id);
    if (state.phase === 'ok') return c.json({ error: 'no_active_alert' }, 409);
    const until = deps.now() + parsed.data.hours * 3600;
    // Ghi thẳng và tăng version: xử lý đang chạy song song sẽ phải đọc lại, không đè mất dấu "đã biết".
    await c.env.DB
      .prepare('UPDATE alert_state SET acked_until = ?, version = version + 1 WHERE device_id = ?')
      .bind(until, device.id)
      .run();
    return c.json({ ok: true, acked_until: until });
  });

  // Tạm dừng cảnh báo (nghỉ Tết, chuyển tủ, rút điện có chủ ý): không tốn tin nhắn, tự bật lại khi hết hạn.
  app.post('/v1/devices/:id/pause', ownerAuth, async (c) => {
    const device = await ownedDevice(c);
    if (!device) return c.json({ error: 'not_found' }, 404);
    const parsed = z.object({ days: z.number().int().min(1).max(60) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const until = deps.now() + parsed.data.days * 86400;
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE devices SET paused_until = ? WHERE id = ?').bind(until, device.id),
      resetStateStmt(c.env.DB, device.id), // hủy báo động/mất kết nối đang có; bật lại thì đánh giá từ đầu
    ]);
    return c.json({ ok: true, paused_until: until });
  });

  app.delete('/v1/devices/:id/pause', ownerAuth, async (c) => {
    const device = await ownedDevice(c);
    if (!device) return c.json({ error: 'not_found' }, 404);
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE devices SET paused_until = NULL WHERE id = ?').bind(device.id),
      resetStateStmt(c.env.DB, device.id),
    ]);
    return c.json({ ok: true });
  });

  // Biểu đồ: gộp theo 5 phút (tối đa ~2000 điểm cho 7 ngày).
  app.get('/v1/devices/:id/readings', ownerAuth, async (c) => {
    const device = await ownedDevice(c);
    if (!device) return c.json({ error: 'not_found' }, 404);
    const hours = Math.min(168, Math.max(1, Math.floor(Number(c.req.query('hours') ?? 24)) || 24));
    const since = deps.now() - hours * 3600;
    const { results } = await c.env.DB
      .prepare(
        `SELECT (ts / 300) * 300 AS t, ROUND(AVG(temp_c), 2) AS avg, MIN(temp_c) AS min, MAX(temp_c) AS max
         FROM readings WHERE device_id = ? AND ts >= ? GROUP BY t ORDER BY t`,
      )
      .bind(device.id, since)
      .all();
    return c.json({ server_time: deps.now(), min_c: device.min_c, max_c: device.max_c, points: results });
  });

  // Lịch sử dài hơn 7 ngày: trung bình theo giờ.
  app.get('/v1/devices/:id/history', ownerAuth, async (c) => {
    const device = await ownedDevice(c);
    if (!device) return c.json({ error: 'not_found' }, 404);
    const days = Math.min(365, Math.max(1, Math.floor(Number(c.req.query('days') ?? 30)) || 30));
    const { results } = await c.env.DB
      .prepare('SELECT hour_ts AS t, avg_c AS avg, min_c AS min, max_c AS max FROM readings_hourly WHERE device_id = ? AND hour_ts >= ? ORDER BY hour_ts')
      .bind(device.id, deps.now() - days * 86400)
      .all();
    return c.json({ points: results });
  });

  // ───────── Người nhận cảnh báo ─────────

  /** Chuẩn hóa số di động VN về dạng 84xxxxxxxxx (định dạng ZNS). null nếu không hợp lệ. */
  function normalizePhone(raw: string): string | null {
    const digits = raw.replace(/[\s.\-()]/g, '').replace(/^\+/, '');
    const n = digits.startsWith('84') ? digits : digits.startsWith('0') ? '84' + digits.slice(1) : digits;
    return /^84[35789]\d{8}$/.test(n) ? n : null;
  }

  app.get('/v1/devices/:id/recipients', ownerAuth, async (c) => {
    const device = await ownedDevice(c);
    if (!device) return c.json({ error: 'not_found' }, 404);
    const { results } = await c.env.DB
      .prepare('SELECT id, name, phone FROM recipients WHERE device_id = ? ORDER BY id')
      .bind(device.id)
      .all();
    return c.json({ recipients: results });
  });

  app.post('/v1/devices/:id/recipients', ownerAuth, async (c) => {
    const device = await ownedDevice(c);
    if (!device) return c.json({ error: 'not_found' }, 404);
    const parsed = z
      .object({ name: nameSchema, phone: z.string().max(20) })
      .safeParse(await c.req.json().catch(() => null));
    const phone = parsed.success ? normalizePhone(parsed.data.phone) : null;
    if (!parsed.success || !phone) return c.json({ error: 'bad_request' }, 400);

    const count = await c.env.DB
      .prepare('SELECT COUNT(*) AS n FROM recipients WHERE device_id = ?')
      .bind(device.id)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_RECIPIENTS) return c.json({ error: 'too_many_recipients' }, 409);

    const row = await c.env.DB
      .prepare(
        `INSERT INTO recipients (device_id, name, phone, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(device_id, phone) DO UPDATE SET name = excluded.name RETURNING id`,
      )
      .bind(device.id, parsed.data.name, phone, deps.now())
      .first<{ id: number }>();
    return c.json({ id: row!.id, name: parsed.data.name, phone }, 201);
  });

  app.delete('/v1/devices/:id/recipients/:rid', ownerAuth, async (c) => {
    const device = await ownedDevice(c);
    if (!device) return c.json({ error: 'not_found' }, 404);
    await c.env.DB
      .prepare('DELETE FROM recipients WHERE id = ? AND device_id = ?')
      .bind(Number(c.req.param('rid')), device.id)
      .run();
    return c.json({ ok: true });
  });

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    console.error('unhandled', err instanceof Error ? err.message : err); // không log body/khóa
    return c.json({ error: 'internal' }, 500);
  });

  return app;
}

export const defaultDeps = (): Deps => ({
  now: () => Math.floor(Date.now() / 1000),
  verifyOwner: zaloVerifier(),
  // Đặt ở index.ts để tránh vòng phụ thuộc: ZNS nếu đã cấu hình, ngược lại chỉ log.
  notifier: () => {
    throw new Error('notifier chưa được cấu hình');
  },
});
