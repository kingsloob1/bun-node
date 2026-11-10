import { setupDom as setupHarnessDom } from "../../harness/dom";
import { DOM_URL } from "./register-dom";

/**
 * The docs viewer's DOM tests: the harness (`__tests__/harness/dom.ts`) at
 * `/docs` (the viewer has no lazy screens to preload). Test files take
 * `render`, `fireEvent`, … from here, never from `@testing-library/react` or
 * `react-dom` themselves.
 */

export {
  act,
  assertQueryEnvironment,
  cleanup,
  fireEvent,
  page,
  render,
  visit,
  waitFor,
  within,
} from "../../harness/dom";
export { DOM_URL };

/**
 * Installs the DOM for the calling test file (the harness's `setupDom`, at
 * {@link DOM_URL}). Call once at the top level of every DOM test file.
 */
export function setupDom(): void {
  setupHarnessDom({ url: DOM_URL });
}
