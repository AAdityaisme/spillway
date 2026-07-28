import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dashboard SPA build (02-architecture §2). Output is copied into the server
// image at dist/public and served under /app (M4/M7).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Dev: proxy the control + data planes to the local server so the SPA hits real APIs.
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/v1': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  // No console noise in production bundles (09-frontend §7.3).
  esbuild: { drop: ['console', 'debugger'] },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Stable vendor chunks for caching; recharts loads lazily via the SpendChart split.
        manualChunks: {
          react: ['react', 'react-dom'],
          tanstack: ['@tanstack/react-query', '@tanstack/react-router'],
        },
      },
    },
  },
});
