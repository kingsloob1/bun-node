import { join } from "node:path";
import {
  preloadDynamicImports,
  setupDom as setupHarnessDom,
} from "../../harness/dom";
import { DOM_URL } from "./register-dom";

/**
 * The security app's DOM tests: the harness (`__tests__/harness/dom.ts`) at
 * `/security`, with the app's on-demand screens and analytics panels
 * preloaded so `React.lazy`
 * resolves in microtasks. Test files take `render`, `fireEvent`, … from
 * here, never from `@testing-library/react` or `react-dom` themselves.
 */

export {
  act,
  assertQueryEnvironment,
  cleanup,
  fireEvent,
  LOADED,
  page,
  render,
  visit,
  waitFor,
  within,
} from "../../harness/dom";
export { DOM_URL };

/** Loads `app/security/screens/lazy.tsx`'s screens once. */
const loadScreenChunks = preloadDynamicImports(
  join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "app",
    "security",
    "screens",
    "lazy.tsx",
  ),
);

/** Loads `app/security/analytics/lazy.tsx`'s panels once (PR-U2). */
const loadPanelChunks = preloadDynamicImports(
  join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "app",
    "security",
    "analytics",
    "lazy.tsx",
  ),
);

/**
 * Installs the DOM for the calling test file (the harness's `setupDom`, at
 * {@link DOM_URL}). Call once at the top level of every DOM test file.
 */
export function setupDom(): void {
  setupHarnessDom({
    url: DOM_URL,
    preload: async () => {
      await loadScreenChunks();
      await loadPanelChunks();
    },
  });
}
