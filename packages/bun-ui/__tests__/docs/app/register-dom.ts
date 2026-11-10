import { registerDom } from "../../harness/register-dom";

/**
 * Registers happy-dom (the harness's `registerDom`) at the docs UI's
 * default mount as a side effect of being imported, through `./dom`, ahead
 * of React and Testing Library. Every test file that reaches it calls
 * `setupDom()` (`__tests__/harness/domLeak.test.ts`).
 */

export { native } from "../../harness/register-dom";

/** The URL the DOM starts at: the UI's default mount. */
export const DOM_URL = "http://localhost/docs";

registerDom(DOM_URL);
