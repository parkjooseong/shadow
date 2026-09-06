import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': process.env.SHADOW_API_TARGET || `http://127.0.0.1:${process.env.SHADOW_PORT || 8787}` } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    css: true,
    exclude: ['tests/e2e/**', 'server/**', 'node_modules/**'],
  },
});
