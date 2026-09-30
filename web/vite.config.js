import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// dev 时把 /api 反代到 site-monitor 网关（默认 3005）
// 端口 5182：5173/5174/5176/5178/5179/5181 已被其他子应用占用，5180 是控制台网关
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5182,
    strictPort: false,
    proxy: {
      '/api': {
        target: process.env.SITE_MONITOR_API || 'http://localhost:3005',
        changeOrigin: true
      }
    }
  }
})
