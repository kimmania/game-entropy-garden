import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/game-entropy-garden/',
  plugins: [
    VitePWA({
      registerType: 'prompt',
      manifest: {
        name: 'Entropy Garden',
        short_name: 'Entropy Garden',
        description: 'Build logic circuits that survive decay.',
        theme_color: '#0d1b0d',
        background_color: '#0d1b0d',
        display: 'standalone',
        orientation: 'any',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globIgnores: ['**/levels/**'],
        runtimeCaching: [
          {
            urlPattern: /\/levels\/.*\.json$/,
            handler: 'CacheFirst',
            options: { cacheName: 'entropy-levels' },
          },
        ],
      },
    }),
  ],
});
