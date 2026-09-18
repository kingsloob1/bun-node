import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { DOM_URL, registerDom } from "./register-dom";

/**
 * The DOM for component tests, and Testing Library loaded AFTER it.
 *
 * Order matters: react-dom decides at module evaluation whether it runs in a
 * DOM (`canUseDOM`), and Bun evaluates a CommonJS dependency ahead of the
 * ESM bodies that statically import it. Imported statically, react-dom
 * would load before happy-dom registers and fall back to its legacy change
 * polyfill — `onChange` then never fires. So Testing Library (which loads
 * react-dom) is imported dynamically, below the registration. Test files must
 * take `render`/`fireEvent`/... from here, never import
 * `@testing-library/react` or `react-dom` themselves.
 */
registerDom();

const testingLibrary = await import("@testing-library/react");

export const { act, cleanup, fireEvent, render, waitFor, within } =
  testingLibrary;

const { environmentManager, focusManager, onlineManager } =
  await import("@tanstack/react-query");

/**
 * TanStack Query decides whether it runs on a server ONCE, when query-core
 * evaluates: `typeof window === "undefined"`. On a "server" it schedules no
 * timers at all, so `refetchInterval` never fires and a polling screen reads
 * once and stops. `bun test` shares that module across files, so whichever
 * file loads it first decides for the whole run: a DOM-less file (one testing
 * a helper next to `app/queryClient.ts`, say) ahead of the DOM files leaves
 * every later polling test broken — and only in whole-package runs. Asking
 * again at each call answers for the DOM that is registered now.
 */
environmentManager.setIsServer(() => typeof window === "undefined");

/**
 * Fails a test that starts with TanStack Query believing it runs on a
 * server, in a background tab or offline: in each, polling silently stops,
 * and a test asserting a refetch would fail far from the cause.
 */
export function assertQueryEnvironment(): void {
  const problems = [
    environmentManager.isServer() && "believes it runs on a server",
    !focusManager.isFocused() && "believes the tab is unfocused",
    !onlineManager.isOnline() && "believes it is offline",
  ].filter(Boolean);
  if (problems.length > 0) {
    throw new Error(
      `TanStack Query ${problems.join(", ")} at the start of a DOM test: an earlier test leaked that state, and polling would not run.`,
    );
  }
}

export { DOM_URL };

/** Lets React's scheduler (and any queued microtasks) finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Installs the DOM for the calling test file: registered before its tests,
 * cleaned between them (rendered trees, storage, URL, theme), unregistered
 * after them, so happy-dom's `fetch`/`Request`/`Response` never leak into
 * server tests sharing the process. Call once at the top level of every DOM
 * test file.
 */
export function setupDom(): void {
  beforeAll(() => registerDom());
  beforeEach(() => assertQueryEnvironment());
  afterEach(async () => {
    cleanup();
    await settle();
    document.body.innerHTML = "";
    try {
      localStorage.clear();
    } catch {
      // Storage may be unavailable; nothing to clear.
    }
    delete document.documentElement.dataset.theme;
    window.history.replaceState(null, "", DOM_URL);
  });
  afterAll(async () => {
    await settle();
    if (GlobalRegistrator.isRegistered) {
      await GlobalRegistrator.unregister();
    }
  });
}

/**
 * Queries bound to the current `document.body`. Testing Library's `screen`
 * binds to the body that existed when it was first imported, which is stale
 * once a file re-registers the DOM, so tests use this instead.
 */
export function page() {
  return within(document.body);
}

/** Moves the DOM's URL (as a server-side route would land the browser there). */
export function visit(path: string): void {
  window.history.replaceState(null, "", path);
}
