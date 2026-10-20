import type { Browser } from 'webextension-polyfill';

declare global {
  // Firefox exposes the promise-based WebExtension API as a global.
  const browser: Browser;
}
