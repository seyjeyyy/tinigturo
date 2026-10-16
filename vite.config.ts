/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Content Security Policy for production builds. Story text is rendered as text, but
 * the CSP is a second line of defence: no inline scripts, no third-party scripts, and
 * network access only to this origin and the configured Supabase project.
 */
function contentSecurityPolicy(mode: string): Plugin {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  let supabase = '';
  try {
    const url = new URL(env.VITE_SUPABASE_URL ?? '');
    supabase = `${url.origin} ${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}`;
  } catch {
    supabase = '';
  }
  const policy = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    `media-src 'self' blob: ${supabase}`.trim(),
    `connect-src 'self' blob: ${supabase}`.trim(),
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  return {
    name: 'tinigturo-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' }],
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    contentSecurityPolicy(mode),
    react(),
    tailwindcss(),
    VitePWA({
      // "prompt" lets the app decide when to activate a new service worker, so an
      // update never interrupts an active recording (see src/pwa/updateGate.ts).
      registerType: 'prompt',
      injectRegister: false,
      manifest: false, // we ship public/manifest.webmanifest ourselves
      workbox: {
        // Precache only the application shell. Story content lives in IndexedDB and
        // speech models in a dedicated Cache Storage bucket managed by the app.
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,woff2}'],
        // Large optional code is not precached for every learner: the speech engine
        // (downloaded on request) and PDF.js (loaded only when a teacher imports a PDF).
        globIgnores: ['**/vosk-*.js', '**/pdfjs-*.js', '**/pdf.worker*'],
        navigateFallback: 'index.html',
        // Never answer these with the app page: the Android download, and Digital Asset
        // Links (which Android fetches to verify the app belongs to this site).
        navigateFallbackDenylist: [/^\/auth\/v1/, /^\/rest\/v1/, /^\/storage\/v1/, /^\/download\//, /^\/\.well-known\//],
        cleanupOutdatedCaches: true,
        importScripts: ['sw-extra.js'],
        clientsClaim: false,
        skipWaiting: false,
        runtimeCaching: [
          {
            // The optional on-device speech engine bundle is large; cache it only after
            // the learner chooses to download it from the Offline downloads screen.
            urlPattern: ({ url }) => /\/assets\/vosk-[\w-]+\.js$/.test(url.pathname),
            handler: 'CacheFirst',
            options: { cacheName: 'tinigturo-speech-engine', expiration: { maxEntries: 4 } },
          },
          // Supabase API calls are never cached by the service worker. Authenticated
          // responses must not be replayed to another identity.
        ],
      },
    }),
  ],
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 6500,
    rollupOptions: {
      output: {
        // A stable name, so the service worker can leave PDF.js out of the precache.
        manualChunks: (id) => (id.includes('/node_modules/pdfjs-dist/') ? 'pdfjs' : undefined),
      },
    },
  },
  worker: { format: 'es' },
  // The optional 5.8 MB speech engine is loaded on demand; pre-bundling it would
  // only slow down the dev server's first start.
  optimizeDeps: { exclude: ['vosk-browser'] },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['src/test/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'db',
          environment: 'node',
          include: ['supabase/tests/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
}));
