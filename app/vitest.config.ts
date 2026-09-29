// Vitest riêng (không nạp zmp-vite-plugin). Các module cần test đều là hàm thuần chạy trong Node.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // Cho phép import '*.css?raw' để test đọc mã màu thật (mặc định vitest trả chuỗi rỗng cho CSS).
    css: { include: [/app\.css/] },
  },
});
