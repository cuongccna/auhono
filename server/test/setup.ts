import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll } from 'vitest';

// Áp migrations thật vào D1 giả lập một lần cho mỗi file test.
beforeAll(async () => {
  await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: never[] }).TEST_MIGRATIONS);
});
