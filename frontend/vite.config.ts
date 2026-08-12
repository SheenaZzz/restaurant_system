import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Build stamp: on a real device it shows at a glance whether it picked up the new code
const BUILD = new Date().toISOString().replace('T', ' ').slice(5, 19)

export default defineConfig({
  define: { __BUILD__: JSON.stringify(BUILD) },
  plugins: [
    react(),
    VitePWA({
      // A push updates it on the next open -- during iteration this may ship
      // several times a day, and staff cannot be asked to clear a cache.
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Restaurant Operations',
        short_name: 'Restaurant',
        description: 'Dine-in buffet, ordering and to-go operations log',
        lang: 'zh-CN',
        // standalone: full screen from the home screen, no address bar and no tabs
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
        // A single-page app: any navigation falls back to index.html, so opening
        // the app offline still gets in
        navigateFallback: '/index.html',
        // The API is never cached -- offline is IndexedDB plus the outbox, and
        // caching API responses only manufactures "it looked like it saved"
        navigateFallbackDenylist: [/^\/api\//],
      },
      devOptions: {
        // Register the SW in development too, or offline behaviour can only be tested after a build
        enabled: true,
        type: 'module',
      },
    }),
  ],
  server: {
    // Allow LAN access, so an iPad can reach the dev server
    host: true,
    proxy: {
      // The front end only calls /api/*, same origin. Development and production
      // use identical paths, so "it works locally and CORS breaks in production" cannot happen
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})
