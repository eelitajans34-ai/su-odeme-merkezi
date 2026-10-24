import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Geliştirmede API aynı kökten (/api) sunulur; böylece SameSite=Strict oturum çerezi çalışır.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3000' } },
  build: { sourcemap: false },
});
