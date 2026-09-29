// Cấu hình Vite theo cấu trúc của zmp-cli (zmp start / zmp deploy gọi Vite của dự án).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import zaloMiniApp from 'zmp-vite-plugin';

export default () =>
  defineConfig({
    root: './',
    base: '',
    // zmp-vite-plugin: đọc app-config.json, ghi lại danh sách JS/CSS vào www/app-config.json khi build.
    plugins: [zaloMiniApp(), react()],
    build: {
      // Zalo webview cũ: plugin đặt sẵn es2015; không xuất sourcemap để bundle gọn và không lộ mã nguồn.
      sourcemap: false,
    },
  });
