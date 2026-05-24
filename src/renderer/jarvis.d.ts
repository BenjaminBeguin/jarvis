/// <reference types="vite/client" />

import type { JarvisApi } from '../../electron/preload/index';

declare global {
  interface Window {
    jarvis: JarvisApi;
  }
}

// Vite's `?raw` query — pulls a file in as a UTF-8 string at build
// time. Works for imports inside src/. Cross-directory imports
// (e.g. docs/) need a per-callsite @ts-expect-error because TS's
// path resolver fails the lookup before consulting this declaration.
declare module '*?raw' {
  const content: string;
  export default content;
}

export {};
