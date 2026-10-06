import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Satıcı yönetim paneli: lisans sunucusu (lisans-server/server) bu çıktıyı (PANEL_DIST_DIR) aynı kökenden sunar.
// Ortak arayüz bileşenleri (düğme, kart, tablo, yan panel…) web uygulamasından alınır; böylece tasarım tek kaynaktan gelir.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@ui': fileURLToPath(new URL('../../apps/web/src/components/ui', import.meta.url)) } },
  server: {
    port: 5174,
    proxy: { '/admin/api': { target: 'http://localhost:4000', changeOrigin: false } },
  },
  build: { sourcemap: false },
});
