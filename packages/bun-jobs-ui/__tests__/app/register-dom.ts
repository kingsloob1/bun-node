import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Registers happy-dom as the global DOM. Imported (through `dom.ts`) ahead of
 * React and Testing Library, so they evaluate against a DOM.
 *
 * `bun test` evaluates a module once per run and shares globals across test
 * files, so this cannot be a one-shot preload: `setupDom()` re-registers
 * before each DOM file and unregisters after it, which keeps happy-dom's
 * `fetch`/`Request`/`Response` out of the server tests that share the process.
 */

/** The URL the DOM starts at: the UI's default mount. */
export const DOM_URL = "http://localhost/jobs";

/** Bun's own networking globals, captured before happy-dom replaces them. */
export const native = {
  /** Bun's `fetch`. */
  fetch: globalThis.fetch,
  /** Bun's `Request`. */
  Request: globalThis.Request,
  /** Bun's `Response`. */
  Response: globalThis.Response,
};

/**
 * Bun's timers. happy-dom would replace them with its window's, and modules
 * that capture a timer at load (React's scheduler, react-dom) would keep the
 * FIRST window's — dead once that file unregisters, so every later file's
 * renders stall. Keeping Bun's timers global avoids that.
 */
const nativeTimers = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  setImmediate: globalThis.setImmediate,
  clearImmediate: globalThis.clearImmediate,
  queueMicrotask: globalThis.queueMicrotask,
};

/** Registers happy-dom unless it already is, keeping Bun's timers. */
export function registerDom(): void {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register({ url: DOM_URL });
    for (const [name, value] of Object.entries(nativeTimers)) {
      Object.defineProperty(globalThis, name, {
        value,
        configurable: true,
        writable: true,
      });
    }
  }
}

registerDom();
