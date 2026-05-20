import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

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
        // Two entries: the main process bundle + a standalone
        // transcribe-worker we fork() for Whisper inference. The
        // worker has to run out-of-process because ONNX Runtime
        // segfaults on some setups (Apple Silicon + q8 model)
        // would otherwise take the whole app down — a process
        // boundary is the only thing native crashes respect.
        input: {
          index: resolve(__dirname, 'electron/main/index.ts'),
          'transcribe-worker': resolve(
            __dirname,
            'electron/main/transcribe-worker.ts',
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
    plugins: [react()],
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
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
});
