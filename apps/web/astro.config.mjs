import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';
import vercel from '@astrojs/vercel/serverless';

export default defineConfig({
  site: 'https://desdeeltablon.com',
  output: 'hybrid',
  adapter: vercel(),
  integrations: [
    react(),
    tailwind(),
    sitemap({
      filter: (page) => !page.includes('/admin') && !page.includes('/mi-cuenta'),
    }),
  ],
  vite: {
    build: {
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
