import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: false } },
  },
  // 'hidden': .map dosyaları üretilir ama pakete işaret eklenmez; imajda silinir (kaynak kodu sızmasın).
  build: { sourcemap: 'hidden' },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
});
