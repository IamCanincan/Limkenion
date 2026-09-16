import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server proxies the WebSocket API to the local Limkenion server,
// so `npm run dev` (Vite) + `npm run serve` (server) work together.
// Production builds are served statically by server/index.mjs.
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
