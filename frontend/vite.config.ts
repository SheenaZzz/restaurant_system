import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// 构建标记：真机调试时一眼看出设备有没有拿到新代码
const BUILD = new Date().toISOString().replace('T', ' ').slice(5, 19)

export default defineConfig({
  define: { __BUILD__: JSON.stringify(BUILD) },
  plugins: [
    react(),
    VitePWA({
      // 代码一推，下次打开自动更新 —— 迭代期每天可能上线多次，
      // 不能让员工手动清缓存。
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: '餐馆运营系统',
        short_name: '运营',
        description: '堂食 buffet / 点单 / 自取 运营记录系统',
        lang: 'zh-CN',
        // standalone：加到主屏幕后全屏运行，没有地址栏和标签页
        display: 'standalone',
        orientation: 'landscape',
        start_url: '/',
        scope: '/',
        background_color: '#0f172a',
        theme_color: '#0f172a',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // 单页应用：任何导航都回退到 index.html，
        // 离线时直接打开 App 也能进得去
        navigateFallback: '/index.html',
        // API 一律不缓存 —— 离线由 IndexedDB + outbox 负责，
        // 缓存 API 响应只会制造"看起来成功了其实没发出去"的假象
        navigateFallbackDenylist: [/^\/api\//],
      },
      devOptions: {
        // 开发期也注册 SW，否则离线行为要等到 build 才能测
        enabled: true,
        type: 'module',
      },
    }),
  ],
  server: {
    // 允许局域网访问，iPad 才能连开发服务器
    host: true,
    proxy: {
      // 前端只调 /api/*，同源。开发和生产的请求路径完全一致，
      // 避免"本地能跑，上线 CORS 挂了"
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})
