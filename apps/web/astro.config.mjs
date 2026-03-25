import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';
import node from '@astrojs/node';

export default defineConfig({
  site: 'https://desdeeltablon.com',
  output: 'hybrid',
  dapter: node({ mode: 'standalone' }),
  integrations: [
    react(),
    tailwind(),
    sitemap({
      filter: (page) => !page.includes('/admin') && !page.includes('/mi-cuenta'),
    }),
  ],
  // Vercel security headers via Astro (also configure in vercel.json)
  vite: {
    build: {
      // Split vendor chunks for better caching
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom'],
          },
        },
      },
    },
  },
});
