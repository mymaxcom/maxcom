import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import { swPlugin } from './build/sw-plugin.ts';

export default defineConfig({
  plugins: [preact(), swPlugin()],
  build: {
    target: 'chrome91',
    cssTarget: 'chrome91',
  },
  server: {
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  test: {
    environment: 'jsdom',
  },
});
