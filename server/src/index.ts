import { createApp, defaultDeps } from './app.ts';
import { checkDevices, purgeOld, rollupOldReadings } from './cron.ts';
import { dispatchPending, LogNotifier, RouterNotifier, type Notifier } from './notify.ts';
import type { Env } from './types.ts';
import { notifyOperator, TelegramNotifier } from './telegram.ts';
import { ZnsNotifier } from './zns.ts';

/** Mỗi kênh dùng dịch vụ thật khi đã cấu hình, ngược lại chỉ ghi log (dev). */
function makeNotifier(env: Env): Notifier {
  const znsOk = env.ZALO_APP_ID && env.ZNS_TEMPLATE_ALERT && env.ZNS_TEMPLATE_OFFLINE && env.ZNS_TEMPLATE_RECOVERED;
  return new RouterNotifier({
    zns: znsOk ? new ZnsNotifier(env) : new LogNotifier(),
    telegram: env.TELEGRAM_BOT_TOKEN ? new TelegramNotifier(env.TELEGRAM_BOT_TOKEN) : new LogNotifier(),
  });
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
        await notifyOperator(env, `cron ${name} lỗi: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    ctx.waitUntil(
      (async () => {
        await safe('checkDevices', () => checkDevices(env.DB, now));
        await safe('dispatch', () =>
          dispatchPending(env.DB, makeNotifier(env), now, async (failed) => {
            // Có tin thất bại hẳn: báo người vận hành để xử lý (sai số, ZNS lỗi, người dùng chặn bot...).
            const byCh = failed.reduce<Record<string, number>>((a, f) => ((a[f.channel] = (a[f.channel] ?? 0) + 1), a), {});
            await notifyOperator(env, `${failed.length} tin thất bại (${JSON.stringify(byCh)}). Lỗi mẫu: ${failed[0]!.error}`);
          }),
        );
        // Dọn dẹp mỗi giờ một lần (5 phút đầu của giờ).
        if (now % 3600 < 300) {
          await safe('rollup', () => rollupOldReadings(env.DB, now));
          await safe('purge', () => purgeOld(env.DB, now));
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
