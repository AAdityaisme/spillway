import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dashboard SPA build (02-architecture §2). Output is copied into the server
// image at dist/public and served under /app (M4/M7).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // M4-auth: the SPA is mounted under /app (the landing page owns /), so emitted asset URLs
  // must be prefixed too — with the default base of '/' every chunk 404s behind the mount.
  // Must stay in lockstep with the router's basepath in src/router.tsx.
  base: '/app/',
  server: {
    port: 5173,
    // Dev: proxy the control + data planes to the local server so the SPA hits real APIs.
    // /auth is the AuthKit hosted-login seam — without it, local sign-in hits Vite, not Fastify.
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/v1': { target: 'http://localhost:3000', changeOrigin: true },
      '/auth': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  // No console noise in production bundles (09-frontend §7.3).
  esbuild: { drop: ['console', 'debugger'] },
  build: {
    outDir: 'dist',
    // The whole dist/ is copied into the image and served publicly under /app, so `true` meant
    // anyone could GET /app/assets/index-<hash>.js.map and reconstruct the dashboard source —
    // including the full client-side auth flow. No token leaks that way (the token is runtime
    // only), but it hands an attacker a free map. 'hidden' keeps maps for local debugging while
    // dropping the //# sourceMappingURL comment; the Dockerfile deletes the files outright.
    sourcemap: process.env.NODE_ENV === 'production' ? false : true,
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
