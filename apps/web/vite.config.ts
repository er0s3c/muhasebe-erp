import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Geliştirme sunucusu bilinmeyen Host başlıklarını reddeder (DNS yeniden bağlama koruması). Hızlı tünel (cloudflared/
    // trycloudflare) ile telefondan ya da uzaktan denemek için o alan adlarına izin verilir; başka alan adı için
    // VITE_ALLOWED_HOSTS="ornek.com,.ornek.org" (virgülle; baştaki nokta alt alan adlarını kapsar).
    allowedHosts: ['.trycloudflare.com', ...(process.env.VITE_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean)],
    proxy: { '/api': { target: process.env.VITE_API_TARGET ?? 'http://localhost:3000', changeOrigin: false } },
  },
  // 'hidden': .map dosyaları üretilir ama pakete işaret eklenmez; imajda silinir (kaynak kodu sızmasın).
  build: { sourcemap: 'hidden',rolldownOptions:{output:{codeSplitting:{groups:[
    {name:'react-runtime',test:/node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/},
    {name:'query-runtime',test:/node_modules[\\/]@tanstack[\\/]/},
    {name:'validation-runtime',test:/node_modules[\\/]zod[\\/]/},
    {name:'three-engine',test:/node_modules[\\/]three[\\/]/,maxSize:350000},
    {name:'pdf-engine',test:/node_modules[\\/]pdfjs-dist[\\/]/},
  ]}}} },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
});
