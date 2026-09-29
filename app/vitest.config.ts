// Vitest riêng (không nạp zmp-vite-plugin). Các module cần test đều là hàm thuần chạy trong Node.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
