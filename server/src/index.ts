import { createApp, defaultDeps } from './app.ts';
import { checkDevices, purgeOld, rollupOldReadings } from './cron.ts';
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

  // Cron mỗi 5 phút. Các bước độc lập: lỗi ở bước này không được chặn bước sau.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const safe = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        console.error(`cron ${name} failed:`, err instanceof Error ? err.message : err);
      }
    };
    ctx.waitUntil(
      (async () => {
        await safe('checkDevices', () => checkDevices(env.DB, now));
        await safe('dispatch', () => dispatchPending(env.DB, makeNotifier(env), now));
        // Dọn dẹp mỗi giờ một lần (5 phút đầu của giờ).
        if (now % 3600 < 300) {
          await safe('rollup', () => rollupOldReadings(env.DB, now));
          await safe('purge', () => purgeOld(env.DB, now));
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
