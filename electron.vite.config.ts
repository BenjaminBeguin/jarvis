import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    build: {
      rollupOptions: {
        // Multiple entries: the main process bundle + standalone
        // workers we fork() for crash-isolated ML inference. The
        // workers HAVE to run out-of-process because ONNX Runtime
        // can segfault on some setups (Apple Silicon + q8 model)
        // and would otherwise take the whole app down — a process
        // boundary is the only thing native crashes respect.
        //
        // The host-side `fork()` call constructs the worker path
        // at runtime as a string, so the bundler can't auto-detect
        // it as a dependency. We list each worker as its own entry
        // here; the output filename matches what the host expects.
        input: {
          index: resolve(__dirname, 'electron/main/index.ts'),
          'transcribe-worker': resolve(
            __dirname,
            'electron/main/modules/voice/transcribe-worker.ts',
          ),
          'embed-worker': resolve(
            __dirname,
            'electron/main/embeddings/embed-worker.ts',
          ),
        },
        output: {
          format: 'es',
          entryFileNames: '[name].js',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'electron/preload/index.ts'),
        output: {
          // Preload must stay CJS — Electron loads it via require() in the
          // renderer's isolated context, and ESM preload requires sandbox=false
          // plus an .mjs filename to work cross-version. CJS is the boring,
          // bulletproof choice.
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [
      react(),
      // PWA shell for the mobile surface (route /mobile, reached
      // via Tailscale). Strategy=injectManifest so we own the
      // service worker (Web Push handler lands there in a later
      // commit). Disabled in dev to avoid the dev SW shimming
      // every renderer reload — desktop UI doesn't need it.
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'sw',
        filename: 'sw.ts',
        registerType: 'autoUpdate',
        devOptions: { enabled: false },
        manifest: {
          name: 'Jarvis',
          short_name: 'Jarvis',
          description:
            'Personal AI operating layer — reachable from your phone over Tailscale.',
          start_url: '/#/mobile',
          scope: '/',
          display: 'standalone',
          orientation: 'portrait',
          theme_color: '#04070b',
          background_color: '#04070b',
          icons: [
            // Single SVG covers every size. Real PNG fallbacks
            // for iOS home-screen polish can land later — the
            // SVG renders fine in the install prompt + Android
            // and is enough for v1.
            {
              src: '/icons/jarvis.svg',
              sizes: 'any',
              type: 'image/svg+xml',
              purpose: 'any maskable',
            },
          ],
        },
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
          // The renderer bundle is ~2.1 MB. Workbox precache
          // defaults to 2 MiB; bump it so the main chunk is
          // included offline. (We could code-split the mobile
          // surface later to bring this down.)
          maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        },
      }),
    ],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer'),
      },
    },
    server: {
      // Pick something in the 3006-3015 range. Strict so we never silently
      // wander outside it; change this line if 3010 is taken.
      port: 3010,
      strictPort: true,
      // Bind to all interfaces in dev so the phone can hit the
      // dev URL over Tailscale (`http://<mac>.<tail-net>.ts.net:3010/#/mobile`).
      // CORS is already permissive on the HTTP API, so cross-origin
      // calls from the dev URL to :4747 work.
      host: '0.0.0.0',
      // Vite 5 rejects any Host header that isn't an explicit allowlist
      // entry as a defence against DNS-rebinding attacks. Tailscale
      // tailnets all live under `.ts.net`, so a single wildcard lets
      // the phone hit `<mac>.<tail-net>.ts.net:3010` without us having
      // to hard-code the user's specific hostname.
      allowedHosts: ['.ts.net', 'localhost', '.local'],
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
});
