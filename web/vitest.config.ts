import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// 前端组件测试（vitest + testing-library）。
// 与 vite.config.ts 分开：测试不需要 dev 代理，只需要 jsdom 环境。
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
  },
})
