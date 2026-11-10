import { defineConfig } from 'vite';

/**
 * FormSathi build config.
 *
 * Everything lives in `public/` for non-TS assets (manifest, service worker,
 * sample forms) and `src/` for the app. There is no framework: the app is
 * vanilla TypeScript + a tiny DOM helper, which keeps the boot payload small
 * enough for a 2G village connection.
 */
export default defineConfig({
  base: './',
  publicDir: 'public',
  // The sandboxed preview proxy rewrites the Host header, so both servers must
  // accept it. In a normal deploy (Firebase Hosting) this is irrelevant.
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          firebase: ['firebase/app', 'firebase/auth', 'firebase/firestore', 'firebase/storage', 'firebase/ai'],
          pdf: ['pdfjs-dist/legacy/build/pdf.mjs'],
        },
      },
    },
  },
});
