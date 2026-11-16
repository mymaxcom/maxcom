import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import { builtinThemesPlugin } from './build/builtin-themes-plugin.ts';
import { swPlugin } from './build/sw-plugin.ts';

export default defineConfig({
  plugins: [preact(), builtinThemesPlugin(fileURLToPath(new URL('./src/themes', import.meta.url))), swPlugin()],
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
