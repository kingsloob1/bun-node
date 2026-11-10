import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Registers happy-dom as the global DOM, for every UI's DOM tests (the
 * harness). Each UI's `__tests__/<ui>/app/register-dom.ts` registers it at
 * that UI's default mount when imported (through its `dom.ts`), ahead of
 * React and Testing Library, so they evaluate against a DOM.
 *
 * `bun test` evaluates a module once per run and shares globals across test
 * files, so this cannot be a one-shot preload: `setupDom()` re-registers
 * before each DOM file and unregisters after it, which keeps happy-dom's
 * `fetch`/`Request`/`Response` out of the server tests that share the process.
 */

/** Where a DOM registered with no URL starts; each UI passes its mount instead. */
export const DEFAULT_DOM_URL = "http://localhost/";

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

/**
 * Registers happy-dom at `url` unless it already is, keeping Bun's timers.
 * When it already is and `url` is given, the page moves to `url` (same
 * origin), so the DOM starts where the calling UI expects whichever module
 * registered it first.
 */
export function registerDom(url?: string): void {
  if (GlobalRegistrator.isRegistered) {
    // Typed structurally: the DOM-free `app/pkg` project reaches this file.
    const page = globalThis as unknown as {
      location: { href: string };
      history: { replaceState: (data: null, unused: "", url: string) => void };
    };
    if (url !== undefined && page.location.href !== url) {
      page.history.replaceState(null, "", url);
    }
    return;
  }
  GlobalRegistrator.register({ url: url ?? DEFAULT_DOM_URL });
  for (const [name, value] of Object.entries(nativeTimers)) {
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  }
}
