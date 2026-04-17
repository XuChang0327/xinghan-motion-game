import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true, // 必需：允许外部访问
    allowedHosts: true, // 必需：跳过 Host Header 检查
    port: 8000,
  },
});
