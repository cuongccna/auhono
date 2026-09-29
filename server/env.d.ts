import type { Env } from './src/types.ts';

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {}
  }
  type AppEnv = import('./src/types.ts').Env & {
    TEST_MIGRATIONS?: import('cloudflare:test').D1Migration[];
  };
}
export {};
