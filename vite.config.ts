import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // 本地 dev：/api 转发到本地 Pages Functions（wrangler pages dev 默认 8788）
    proxy: {
      '/api': 'http://localhost:8788',
    },
  },
  build: {
    target: 'es2020',
  },
});
