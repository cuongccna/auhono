import { createApp, defaultDeps } from './app.ts';
import { checkDevices, rollupOldReadings } from './cron.ts';
import { dispatchPending, LogNotifier, type Notifier } from './notify.ts';
import type { Env } from './types.ts';
import { ZnsNotifier } from './zns.ts';

/** ZNS khi đã cấu hình OA + template; ngược lại chỉ ghi log (dev). */
function makeNotifier(env: Env): Notifier {
  const configured = env.ZALO_APP_ID && env.ZNS_TEMPLATE_ALERT && env.ZNS_TEMPLATE_OFFLINE && env.ZNS_TEMPLATE_RECOVERED;
  return configured ? new ZnsNotifier(env) : new LogNotifier();
}

const app = createApp({ ...defaultDeps(), notifier: makeNotifier });

export default {
  fetch: app.fetch,

  // Cron mỗi 5 phút.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    ctx.waitUntil(
      (async () => {
        await checkDevices(env.DB, now);
        await dispatchPending(env.DB, makeNotifier(env), now);
        // Gộp dữ liệu cũ mỗi giờ một lần (5 phút đầu của giờ).
        if (now % 3600 < 300) await rollupOldReadings(env.DB, now);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
