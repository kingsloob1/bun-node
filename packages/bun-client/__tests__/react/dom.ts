/**
 * The DOM for the React binding's tests, with react-dom loaded AFTER it:
 * bun-ui's jobs rules (`packages/bun-ui/__tests__/jobs/app/dom.ts`, CLAUDE.md
 * "DOM tests — rules learned the hard way"), cut to what a hooks test needs.
 *
 * - happy-dom is registered before react-dom is evaluated: react-dom decides
 *   at evaluation whether a DOM exists, and Bun evaluates a statically
 *   imported CommonJS dependency ahead of this module's body. So react-dom
 *   is imported dynamically, below the registration; test files take
 *   {@link render} and {@link act} from here and never import react-dom.
 * - {@link setupDom} registers happy-dom for the calling file and
 *   unregisters it after, so its globals never reach another file sharing
 *   the process (`bun test --randomize`).
 * - Bun's timers and networking globals stay: React's scheduler captures a
 *   timer at load, and the client under test sends Bun `Request`s (with Bun
 *   `AbortSignal`s, which Bun's `Request` requires) to a bun-common router
 *   in process. happy-dom's `fetch` and `Request` would be neither.
 * - TanStack Query asks whether it runs on a server per call
 *   (`environmentManager.setIsServer`), instead of once at load: a DOM-less
 *   file loading query-core first would otherwise leave every test here
 *   with no timers.
 *
 * Its own render helper rather than Testing Library: the tests sit in the
 * package's DOM-free project (they import bun-common's sources, whose
 * Bun-typed streams the DOM lib contradicts), so they read the DOM through
 * the small {@link DomNode} view below.
 */
import type { ReactNode } from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll } from "bun:test";

/** The URL the DOM starts at. */
export const DOM_URL = "http://localhost/";

/** The globals of Bun's kept over happy-dom's, captured before it registers. */
const KEPT = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "setImmediate",
  "clearImmediate",
  "queueMicrotask",
  "fetch",
  "Request",
  "Response",
  "Headers",
  "FormData",
  "Blob",
  "File",
  "URL",
  "AbortController",
  "AbortSignal",
  "DOMException",
  "TransformStream",
  "WritableStream",
] as const;

const native = new Map<string, unknown>(
  KEPT.map((name) => [name, Reflect.get(globalThis, name)]),
);

/** Registers happy-dom unless it already is, keeping Bun's {@link KEPT} globals. */
export function registerDom(): void {
  if (GlobalRegistrator.isRegistered) return;
  GlobalRegistrator.register({ url: DOM_URL });
  for (const [name, value] of native) {
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  }
}

registerDom();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { createRoot } = await import("react-dom/client");
const React = await import("react");

/** React's `act`, awaited by every caller (an un-awaited one breaks the act scope). */
export const act = React.act;

const { environmentManager } = await import("@tanstack/react-query");
environmentManager.setIsServer(
  () => Reflect.get(globalThis, "window") === undefined,
);

/** The DOM as the tests read it: happy-dom's node, the members used here. */
export interface DomNode {
  /** The node's text, its descendants' included. */
  readonly textContent: string | null;
  /** Its first descendant matching `selector`, or `null`. */
  querySelector: (selector: string) => DomNode | null;
  /** Clicks it (a `click` event React's root listener receives). */
  click: () => void;
  /** Appends a child. */
  appendChild: (node: DomNode) => DomNode;
  /** Removes it from its parent. */
  remove: () => void;
}

/** The document, as {@link DomNode}s. */
function doc(): {
  body: DomNode & { textContent: string | null };
  createElement: (tag: string) => DomNode;
} {
  return Reflect.get(globalThis, "document") as ReturnType<typeof doc>;
}

/** A rendered tree. */
export interface Rendered {
  /** The container's text. */
  text: () => string;
  /** The container. */
  container: DomNode;
  /** Renders `node` in place of the tree (a new element type remounts). */
  rerender: (node: ReactNode) => Promise<void>;
  /** Unmounts the tree and removes the container. */
  unmount: () => Promise<void>;
}

/** Trees still mounted, unmounted after each test. */
const mounted = new Set<Rendered>();

/** Renders `node` into a fresh container under `document.body`, inside `act`. */
export async function render(node: ReactNode): Promise<Rendered> {
  const container = doc().createElement("div");
  doc().body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(node);
  });
  const rendered: Rendered = {
    text: () => container.textContent ?? "",
    container,
    rerender: async (next) => {
      await act(async () => {
        root.render(next);
      });
    },
    unmount: async () => {
      if (!mounted.delete(rendered)) return;
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
  mounted.add(rendered);
  return rendered;
}

/** Lets fetches through the in-process router, and React's commits, finish. */
export async function settle(): Promise<void> {
  for (let index = 0; index < 3; index++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

/**
 * Waits, inside `act`, until `check` stops throwing (it holds its
 * assertions); rethrows its last error after `timeout` ms.
 */
export async function waitFor(
  check: () => void,
  timeout = 2000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

/** Clicks `node` inside `act`. */
export async function click(node: DomNode | null): Promise<void> {
  if (node === null) throw new Error("click: no such node");
  await act(async () => {
    node.click();
  });
}

/**
 * Installs the DOM for the calling test file: registered before its tests,
 * every tree unmounted between them, unregistered after them. Call once at
 * the top level of every DOM test file.
 */
export function setupDom(): void {
  beforeAll(() => {
    registerDom();
  });
  afterEach(async () => {
    for (const rendered of [...mounted]) await rendered.unmount();
    doc().body.textContent = "";
  });
  afterAll(async () => {
    await settle();
    if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  });
}
