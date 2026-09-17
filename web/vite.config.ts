import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发服务器把 WebSocket API 代理到本地 Limkenion 服务，
// 这样 `npm run dev`（Vite）与 `npm run serve`（server）可以协同工作。
// 生产构建由 server/index.mjs 以静态方式提供。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://localhost:8788',
        ws: true,
      },
      // WS 握手要带一次性 token；开发模式下页面由 Vite 伺服，
      // 拿不到服务端注入的 meta，因此把 /ws-token 也代理过去。
      '/ws-token': {
        target: 'http://localhost:8788',
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
  },
})
