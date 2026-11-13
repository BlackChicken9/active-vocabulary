import { defineConfig } from 'vite';

// 本地联调：前端同源调用 /functions/v1/app，由 vite 代理到本机 Function（见 README「AI 网关」）。
export default defineConfig({
  server: {
    host: '127.0.0.1',
    proxy: { '/functions/v1/app': 'http://127.0.0.1:8000' },
  },
});
