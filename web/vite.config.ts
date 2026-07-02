import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SPA build lands in web/dist, which the Express server serves in production. In dev, `npm run dev`
// runs Vite on :5173 and proxies /api to the backend on :3000 so cookies share an origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
