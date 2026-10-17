import type { FetchLike } from "../../app/api/client";
import { FakeSocket } from "./live/fakes";

/**
 * A ledger of every handle the code under test opens through the globals —
 * timers, animation frames, window and document listeners, sockets, event
 * sources, observers — and of every request through the API client's
 * `fetch`, so a test can assert that none is left once the tree unmounted.
 * It replaces `@eslint-react`'s dropped `web-api-no-leaked-*` rules, and goes
 * further than they did: they read one effect at a time, this watches what
 * actually stayed open (`unmountLeaks.test.tsx`).
 *
 * What it sees is what looks a global up **at call time**: the app, TanStack
 * Query (its `timeoutManager` calls the global `setTimeout`/`setInterval`
 * each time), Testing Library. Modules that captured a global when they were
 * loaded — React's scheduler, react-dom's internals, happy-dom's own timers —
 * never see the wrapper, which is the separation wanted: their handles are
 * not the app's to close.
 *
 * Gotchas, measured while building it:
 * - Never decide anything on a handle's {@link Handle.origin}: it is read from
 *   the stack, and JavaScriptCore's proper tail calls drop frames, so
 *   `() => requestAnimationFrame(loop)` reads as opened by happy-dom. It is
 *   for the failure message, and for asserting that a case started.
 * - A timer's `refresh()` (Bun's `Timeout`) re-arms a fired timeout behind
 *   the ledger's back. Nothing in `app/**` calls it.
 * - An observer is open while it observes something, not from its
 *   construction: one that was built and never observed holds nothing.
 */

/** What a handle is. */
export type HandleKind =
  | "timeout"
  | "interval"
  | "animation-frame"
  | "listener"
  | "websocket"
  | "eventsource"
  | "observer"
  | "fetch";

/** How a handle closed. */
export type HandleClosure =
  /** A timeout ran, an animation frame was painted, a `once` listener fired. */
  | "fired"
  /** `clearTimeout`/`clearInterval`/`cancelAnimationFrame`. */
  | "cleared"
  /** `removeEventListener`, or its `signal` aborted. */
  | "removed"
  /** A socket or event source closed, by either side. */
  | "closed"
  /** An observer was disconnected, or stopped observing its last target. */
  | "disconnected"
  /** A request answered (or failed) on its own. */
  | "settled"
  /** A request's `signal` aborted it. */
  | "aborted"
  /** {@link HandleLedger.disposeAll} closed it, after a negative control. */
  | "disposed";

/** One thing the code under test opened. */
export interface Handle {
  /** What it is. */
  kind: HandleKind;
  /** Which one: `5000ms`, `window popstate`, the URL, the observer's class. */
  detail: string;
  /** Who opened it, from the stack: `app/live/live.ts:252`, `tanstack`, `test …`, `unknown`. For messages and start assertions only. */
  origin: string;
  /** The opening stack, without the ledger's own frames: printed when it outlives the unmount. */
  stack: string;
  /** Whether it is still open. */
  open: boolean;
  /** How it closed; `undefined` while open. */
  closedBy: HandleClosure | undefined;
  /** Closes it for real, so a negative control's planted leak does not outlive its test. */
  dispose: () => void;
}

/** Frames of this file, left out of origins and stacks. */
const SELF = /handleLedger\.ts/;

/** The first frame outside this file, classified. */
function originOf(stack: string): string {
  for (const frame of stack.split("\n").slice(1)) {
    if (SELF.test(frame)) {
      continue;
    }
    if (/node_modules\/@tanstack\//.test(frame)) {
      return "tanstack";
    }
    if (/node_modules\/react-dom\//.test(frame)) {
      return "react-dom";
    }
    if (/node_modules\/@testing-library\//.test(frame)) {
      return "testing-library";
    }
    if (/node_modules\/happy-dom\//.test(frame)) {
      return "happy-dom";
    }
    const app = /bun-jobs-ui\/(app\/[^:)]+:\d+)/.exec(frame);
    if (app) {
      return app[1]!;
    }
    const test = /bun-jobs-ui\/(__tests__\/[^:)]+:\d+)/.exec(frame);
    if (test) {
      return `test ${test[1]}`;
    }
  }
  return "unknown";
}

/** The stack of the current call, deep enough to get past React's frames. */
function captureStack(): string {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 60;
  const stack = new Error("opened here").stack ?? "";
  Error.stackTraceLimit = limit;
  return stack
    .split("\n")
    .filter((line, index) => index === 0 || !SELF.test(line))
    .join("\n");
}

/** Whether a function is the engine's own, not a wrapper someone installed. */
function isNative(fn: unknown): boolean {
  return typeof fn === "function" && /\[native code\]/.test(String(fn));
}

/** Bun's own timers, captured when this module loads, before any ledger wraps them. */
const native = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
};

for (const [name, fn] of Object.entries(native)) {
  if (!isNative(fn)) {
    throw new Error(
      `handleLedger.ts loaded after something replaced the global ${name}: its own timers would be recorded`,
    );
  }
}

/** Resolves after `ms` on a Bun timer the ledger never records: for draining and waiting inside a ledger test. */
export function nativeSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    native.setTimeout(resolve, ms);
  });
}

/** A timer id as the timer functions take it: Bun's `Timeout` object, or its number. */
type TimerId = ReturnType<typeof setTimeout> | number;

/** A constructor taking one callback, as every observer class is. */
type ObserverConstructor<T> = new (callback: never, ...rest: never[]) => T;

/**
 * The part of an observer the ledger drives. A class, not an interface, so
 * the ledger's subclass may override its methods (a declaration only: it
 * emits nothing).
 */
declare abstract class ObserverLike {
  /** Starts observing a target. */
  observe(target: never, options?: never): void;
  /** Stops observing everything. */
  disconnect(): void;
  /** Stops observing one target, where the class has it. */
  unobserve?(target: never): void;
}

/** Options of {@link HandleLedger.trackFetch}. */
export interface TrackFetchOptions {
  /** Calls it matches never answer until their signal aborts them (or {@link HandleLedger.disposeAll} does). Defaults to none. */
  hang?: (url: string) => boolean;
}

/**
 * Records the handles opened while it is installed (see the module comment).
 * Install it in `beforeEach` and uninstall it in `afterEach`: uninstalling
 * restores each global's exact previous property descriptor.
 */
export class HandleLedger {
  /** Every handle opened since {@link install}, in order, open or not. */
  readonly handles: Handle[] = [];
  /** Every socket the code under test created, in order. */
  readonly sockets: TrackedSocket[] = [];
  /** Undoes each patch, in reverse. */
  #restore: (() => void)[] = [];
  /** Whether it is installed now. */
  #installed = false;

  /** Records a handle opened now. */
  #record(kind: HandleKind, detail: string, dispose: () => void): Handle {
    const stack = captureStack();
    const handle: Handle = {
      kind,
      detail,
      origin: originOf(stack),
      stack,
      open: true,
      closedBy: undefined,
      dispose,
    };
    this.handles.push(handle);
    return handle;
  }

  /** {@link #record}, for the wrappers and classes the ledger installs. */
  #recorder(): (
    kind: HandleKind,
    detail: string,
    dispose: () => void,
  ) => Handle {
    return (kind, detail, dispose) => this.#record(kind, detail, dispose);
  }

  /** Replaces `owner[name]`, restoring the previous own property descriptor (or its absence) on uninstall. */
  #patch(owner: object, name: string, value: unknown): void {
    const before = Object.getOwnPropertyDescriptor(owner, name);
    Object.defineProperty(owner, name, {
      value,
      configurable: true,
      writable: true,
    });
    this.#restore.push(() => {
      if (before) {
        Object.defineProperty(owner, name, before);
      } else {
        delete (owner as Record<string, unknown>)[name];
      }
    });
  }

  /** Wraps the globals. Throws when already installed. */
  install(): void {
    if (this.#installed) {
      throw new Error("the ledger is already installed");
    }
    this.#installed = true;
    this.#installTimers();
    this.#installFrames();
    this.#installListeners(window, "window");
    this.#installListeners(document, "document");
    this.#installSockets();
    this.#installObservers();
  }

  /** Restores every global it wrapped, exactly as it was. */
  uninstall(): void {
    for (const restore of this.#restore.splice(0).reverse()) {
      restore();
    }
    // FakeSocket keeps every instance: drop ours, so a later file's
    // `FakeSocket.last` is never one of them.
    FakeSocket.instances = FakeSocket.instances.filter(
      (socket) => !(socket instanceof TrackedSocket),
    );
    this.#installed = false;
  }

  /** The handles still open. */
  outstanding(): Handle[] {
    return this.handles.filter((handle) => handle.open);
  }

  /** The handles of `kind` opened since install, open or not, that `predicate` accepts. */
  opened(
    kind: HandleKind,
    predicate: (handle: Handle) => boolean = () => true,
  ): Handle[] {
    return this.handles.filter(
      (handle) => handle.kind === kind && predicate(handle),
    );
  }

  /** Closes every open handle for real, marking it `disposed` (after a negative control). */
  disposeAll(): void {
    for (const handle of this.outstanding()) {
      handle.dispose();
      close(handle, "disposed");
    }
  }

  /** Throws, naming each handle still open with the stack that opened it. */
  assertNoneOpen(): void {
    const open = this.outstanding();
    if (open.length === 0) {
      return;
    }
    const lines = open.map((handle) => {
      const frames = handle.stack.split("\n").slice(1, 9).join("\n");
      return `- ${handle.kind} ${handle.detail}, opened by ${handle.origin}:\n${frames}`;
    });
    throw new Error(
      `${open.length} handle(s) outlived the unmount:\n${lines.join("\n")}`,
    );
  }

  /**
   * Wraps the API client's `fetch`: each call is a handle until it settles or
   * its signal aborts it. Calls `options.hang` matches stay pending until
   * aborted, which is how a test puts a read in flight at unmount.
   */
  trackFetch(inner: FetchLike, options: TrackFetchOptions = {}): FetchLike {
    const hang = options.hang ?? (() => false);
    return (input, init) => {
      const signal = init.signal ?? undefined;
      if (signal?.aborted) {
        return inner(input, init);
      }
      let rejectHung: ((error: unknown) => void) | undefined;
      const handle = this.#record(
        "fetch",
        `${init.method ?? "GET"} ${input}`,
        () => rejectHung?.(new DOMException("disposed", "AbortError")),
      );
      const onAbort = () => close(handle, "aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
      const pending = hang(input)
        ? new Promise<Response>((_resolve, reject) => {
            rejectHung = reject;
            signal?.addEventListener(
              "abort",
              () =>
                reject(
                  new DOMException("The operation was aborted.", "AbortError"),
                ),
              { once: true },
            );
          })
        : inner(input, init);
      return pending.finally(() => {
        signal?.removeEventListener("abort", onAbort);
        close(handle, "settled");
      });
    };
  }

  /** setTimeout, setInterval and their clears, over one id space (as in browsers, either clear clears either). */
  #installTimers(): void {
    const byId = new Map<unknown, Handle>();
    /** Keys a timer by its object and by its number, since both clear it. */
    const remember = (id: TimerId, handle: Handle) => {
      byId.set(id, handle);
      const numeric = Number(id);
      if (Number.isFinite(numeric)) {
        byId.set(numeric, handle);
      }
    };
    const forget = (id: unknown, how: HandleClosure) => {
      const handle =
        byId.get(id) ??
        (id === undefined || id === null ? undefined : byId.get(Number(id)));
      if (handle) {
        close(handle, how);
      }
    };
    const record = this.#recorder();
    this.#patch(
      globalThis,
      "setTimeout",
      function setTimeout(
        callback: (...args: unknown[]) => void,
        ms?: number,
        ...args: unknown[]
      ) {
        let id: TimerId | undefined;
        const handle = record("timeout", `${ms ?? 0}ms`, () => {
          native.clearTimeout(id as ReturnType<typeof setTimeout>);
        });
        id = native.setTimeout(
          (...callArgs: unknown[]) => {
            close(handle, "fired");
            callback(...callArgs);
          },
          ms,
          ...args,
        );
        remember(id, handle);
        return id;
      },
    );
    this.#patch(
      globalThis,
      "setInterval",
      function setInterval(
        callback: (...args: unknown[]) => void,
        ms?: number,
        ...args: unknown[]
      ) {
        let id: TimerId | undefined;
        const handle = record("interval", `${ms ?? 0}ms`, () => {
          native.clearInterval(id as ReturnType<typeof setInterval>);
        });
        id = native.setInterval(callback, ms, ...args);
        remember(id, handle);
        return id;
      },
    );
    this.#patch(globalThis, "clearTimeout", function clearTimeout(id: unknown) {
      forget(id, "cleared");
      native.clearTimeout(id as ReturnType<typeof setTimeout>);
    });
    this.#patch(
      globalThis,
      "clearInterval",
      function clearInterval(id: unknown) {
        forget(id, "cleared");
        native.clearInterval(id as ReturnType<typeof setInterval>);
      },
    );
  }

  /** requestAnimationFrame and cancelAnimationFrame: a frame closes when painted. */
  #installFrames(): void {
    const request = globalThis.requestAnimationFrame;
    const cancel = globalThis.cancelAnimationFrame;
    if (typeof request !== "function" || typeof cancel !== "function") {
      return;
    }
    const byId = new Map<number, Handle>();
    const record = this.#recorder();
    this.#patch(
      globalThis,
      "requestAnimationFrame",
      function requestAnimationFrame(callback: FrameRequestCallback) {
        let id = 0;
        const handle = record("animation-frame", "frame", () => {
          cancel(id);
        });
        id = request((time) => {
          byId.delete(id);
          close(handle, "fired");
          callback(time);
        });
        byId.set(id, handle);
        return id;
      },
    );
    this.#patch(
      globalThis,
      "cancelAnimationFrame",
      function cancelAnimationFrame(id: number) {
        const handle = byId.get(id);
        if (handle) {
          byId.delete(id);
          close(handle, "cleared");
        }
        cancel(id);
      },
    );
  }

  /**
   * `target`'s add/removeEventListener, keyed by (type, listener, capture) —
   * the identity the DOM de-duplicates on — honouring `once` (closed when it
   * fires) and `signal` (closed when it aborts; never added if already aborted).
   */
  #installListeners(target: EventTarget, name: string): void {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    /** Open listeners by key, with what undoes the ledger's own helpers. */
    const live = new Map<
      string,
      Map<
        EventListenerOrEventListenerObject,
        { handle: Handle; detach: () => void }
      >
    >();
    const keyOf = (type: string, options?: boolean | EventListenerOptions) =>
      `${type}|${typeof options === "boolean" ? options : Boolean(options?.capture)}`;
    const forget = (
      key: string,
      listener: EventListenerOrEventListenerObject,
      how: HandleClosure,
    ) => {
      const entry = live.get(key)?.get(listener);
      if (entry) {
        live.get(key)!.delete(listener);
        entry.detach();
        close(entry.handle, how);
      }
    };
    const record = this.#recorder();
    this.#patch(
      target,
      "addEventListener",
      function addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) {
        add(type, listener, options);
        const signal = typeof options === "object" ? options.signal : undefined;
        if (!listener || signal?.aborted) {
          return;
        }
        const key = keyOf(type, options);
        const byListener = live.get(key) ?? new Map();
        live.set(key, byListener);
        if (byListener.has(listener)) {
          return; // A duplicate add is a no-op in the DOM too.
        }
        const handle = record("listener", `${name} ${type}`, () => {
          remove(type, listener, options);
        });
        const helpers: (() => void)[] = [];
        const capture =
          typeof options === "boolean" ? options : Boolean(options?.capture);
        if (typeof options === "object" && options.once) {
          // Added after the listener, so it runs after it on the same event.
          const fired = () => forget(key, listener, "fired");
          add(type, fired, { once: true, capture });
          helpers.push(() => remove(type, fired, { capture }));
        }
        if (signal) {
          const aborted = () => forget(key, listener, "removed");
          signal.addEventListener("abort", aborted, { once: true });
          helpers.push(() => signal.removeEventListener("abort", aborted));
        }
        byListener.set(listener, {
          handle,
          detach: () => {
            for (const helper of helpers) {
              helper();
            }
          },
        });
      },
    );
    this.#patch(
      target,
      "removeEventListener",
      function removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
      ) {
        remove(type, listener, options);
        if (listener) {
          forget(keyOf(type, options), listener, "removed");
        }
      },
    );
  }

  /** WebSocket as a {@link TrackedSocket}, and EventSource as a tracked fake. */
  #installSockets(): void {
    const record = this.#recorder();
    const sockets = this.sockets;
    class LedgerSocket extends TrackedSocket {
      constructor(url: string, protocols: string[] = []) {
        super(url, protocols);
        sockets.push(this);
        this.handle = record("websocket", url, () => this.close(1000));
      }
    }
    this.#patch(globalThis, "WebSocket", LedgerSocket);

    class LedgerEventSource extends TrackedEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        this.handle = record("eventsource", this.url, () => {
          this.close();
        });
      }
    }
    this.#patch(globalThis, "EventSource", LedgerEventSource);
  }

  /**
   * MutationObserver and ResizeObserver, tracked over the DOM's own, and
   * IntersectionObserver as a fake that reports every target visible at once
   * (happy-dom's never reports, so lazily loaded rows would never load).
   */
  #installObservers(): void {
    const globals = globalThis as unknown as Record<
      string,
      ObserverConstructor<ObserverLike> | undefined
    >;
    for (const name of ["MutationObserver", "ResizeObserver"]) {
      const Base = globals[name] ?? InertObserver;
      this.#patch(globalThis, name, this.#trackObserver(name, Base));
    }
    this.#patch(
      globalThis,
      "IntersectionObserver",
      this.#trackObserver("IntersectionObserver", VisibleIntersectionObserver),
    );
  }

  /** A subclass of `Base` that is a handle while it observes at least one target. */
  #trackObserver(
    name: string,
    Base: ObserverConstructor<ObserverLike>,
  ): ObserverConstructor<ObserverLike> {
    const record = this.#recorder();
    return class TrackedObserver extends Base {
      /** The handle while observing; a new one after a disconnect and a new observe. */
      #handle: Handle | undefined;
      /** What it observes now. */
      #targets = new Set<unknown>();

      override observe(target: never, options?: never): void {
        super.observe(target, options);
        this.#targets.add(target);
        if (!this.#handle?.open) {
          this.#handle = record("observer", name, () => {
            super.disconnect();
          });
        }
      }

      override unobserve(target: never): void {
        super.unobserve?.(target);
        this.#targets.delete(target);
        if (this.#targets.size === 0 && this.#handle) {
          close(this.#handle, "disconnected");
        }
      }

      override disconnect(): void {
        super.disconnect();
        this.#targets.clear();
        if (this.#handle) {
          close(this.#handle, "disconnected");
        }
      }
    };
  }
}

/** Marks `handle` closed, `how`, unless it already is. */
function close(handle: Handle, how: HandleClosure): void {
  if (handle.open) {
    handle.open = false;
    handle.closedBy = how;
  }
}

/** A {@link FakeSocket} the ledger counts: open until either side closes it, recording which channels the client holds. */
export class TrackedSocket extends FakeSocket {
  /** `WebSocket.CONNECTING`. */
  static readonly CONNECTING = 0;
  /** `WebSocket.OPEN`. */
  static readonly OPEN = 1;
  /** `WebSocket.CLOSING`. */
  static readonly CLOSING = 2;
  /** `WebSocket.CLOSED`. */
  static readonly CLOSED = 3;

  /** Its ledger handle; set by the ledger's constructor. */
  handle: Handle | undefined;

  /** Every channel the client holds now, from its subscribe and unsubscribe frames (acked or not). */
  readonly held = new Set<string>();

  override send(data: string): void {
    super.send(data);
    const frame = JSON.parse(data) as {
      /** The frame's op. */
      op: string;
      /** The channels it names. */
      channels?: string[];
    };
    for (const channel of frame.channels ?? []) {
      if (frame.op === "subscribe") {
        this.held.add(channel);
      }
      if (frame.op === "unsubscribe") {
        this.held.delete(channel);
      }
    }
  }

  override close(code?: number): void {
    super.close(code);
    if (this.handle) {
      close(this.handle, "closed");
    }
  }

  override drop(code?: number): void {
    super.drop(code);
    if (this.handle) {
      close(this.handle, "closed");
    }
  }
}

/** Throws, naming them, when `socket` still holds any of `channels`: what a screen's hold left behind. */
export function assertReleased(
  socket: TrackedSocket,
  channels: readonly string[],
): void {
  const kept = channels.filter((channel) => socket.held.has(channel));
  if (kept.length > 0) {
    throw new Error(
      `live hold never released: ${kept.join(", ")} still subscribed after the screen unmounted`,
    );
  }
}

/** An EventSource that never connects: open until closed. */
class TrackedEventSource extends EventTarget {
  /** `EventSource.CONNECTING`. */
  static readonly CONNECTING = 0;
  /** `EventSource.OPEN`. */
  static readonly OPEN = 1;
  /** `EventSource.CLOSED`. */
  static readonly CLOSED = 2;

  /** The URL asked for, resolved against the page. */
  readonly url: string;
  /** Whether credentials were asked for. */
  readonly withCredentials: boolean;
  /** `CONNECTING` until closed, then `CLOSED`. */
  readyState = 0;
  /** The `open` handler. */
  onopen: ((event: Event) => void) | null = null;
  /** The `message` handler. */
  onmessage: ((event: MessageEvent) => void) | null = null;
  /** The `error` handler. */
  onerror: ((event: Event) => void) | null = null;
  /** Its ledger handle; set by the ledger's constructor. */
  handle: Handle | undefined;

  constructor(url: string | URL, init?: EventSourceInit) {
    super();
    this.url = new URL(String(url), globalThis.location?.href).href;
    this.withCredentials = init?.withCredentials ?? false;
  }

  /** Closes it. */
  close(): void {
    this.readyState = 2;
    if (this.handle) {
      close(this.handle, "closed");
    }
  }
}

/** An observer that observes nothing: the base where the DOM has no such class. */
class InertObserver implements ObserverLike {
  constructor(_callback: never) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): never[] {
    return [];
  }
}

/** An IntersectionObserver reporting each target visible, a microtask after it is observed (as `overview.test.tsx`'s fake does). */
class VisibleIntersectionObserver implements ObserverLike {
  /** The margin asked for. */
  readonly rootMargin: string;
  /** No root: the viewport. */
  readonly root = null;
  /** The default threshold. */
  readonly thresholds: readonly number[] = [0];
  /** The callback. */
  readonly #callback: IntersectionObserverCallback;
  /** What it observes now. */
  readonly #targets = new Set<Element>();

  constructor(
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.#callback = callback;
    this.rootMargin = options?.rootMargin ?? "0px";
  }

  observe(target: Element): void {
    this.#targets.add(target);
    queueMicrotask(() => {
      if (this.#targets.has(target)) {
        this.#callback(
          [{ isIntersecting: true, target } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
    });
  }

  unobserve(target: Element): void {
    this.#targets.delete(target);
  }

  disconnect(): void {
    this.#targets.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
