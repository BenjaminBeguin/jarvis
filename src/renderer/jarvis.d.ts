import type { JarvisApi } from '../../electron/preload/index';

declare global {
  interface Window {
    jarvis: JarvisApi;
  }
}

export {};
