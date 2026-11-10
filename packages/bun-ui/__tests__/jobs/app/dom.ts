import { join } from "node:path";
import {
  setupDom as setupHarnessDom,
  preloadDynamicImports,
} from "../../harness/dom";
import { DOM_URL } from "./register-dom";

/**
 * The jobs UI's DOM tests: the harness (`__tests__/harness/dom.ts`) at
 * `/jobs`, every lazy screen preloaded. Test files take `render`,
 * `fireEvent`, … from here, never from `@testing-library/react` or
 * `react-dom` themselves.
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

/** Loads every on-demand screen chunk `app/jobs/screens/lazy.tsx` names, once per process. */
const loadScreenChunks = preloadDynamicImports(
  join(import.meta.dir, "..", "..", "..", "app", "jobs", "screens", "lazy.tsx"),
);

/**
 * Installs the DOM for the calling test file (the harness's `setupDom`, at
 * {@link DOM_URL}, with the lazy screens loaded first). Call once at the top
 * level of every DOM test file.
 */
export function setupDom(): void {
  setupHarnessDom({ url: DOM_URL, preload: loadScreenChunks });
}
