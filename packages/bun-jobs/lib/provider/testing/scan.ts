import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";

/**
 * Two instruments the conformance kit measures a provider with: a secret
 * scanner over everything bun-jobs would write, and a tracker of the timers
 * a call leaves behind. Internal.
 */

/** How deep a value is walked for text. */
const MAX_DEPTH = 10;

/**
 * Every piece of text reachable from `value`: strings, error messages,
 * stacks and causes, object keys and values, and what class instances a
 * redactor leaves alone carry (a `URL`'s href, a `Headers`' or `Map`'s
 * entries, a `Request`'s URL and headers, a custom `toString()`).
 */
export function textOf(value: unknown): string[] {
  const out: string[] = [];
  walk(value, out, new WeakSet(), 0);
  return out;
}

/** Collects `value`'s text into `out`. */
function walk(
  value: unknown,
  out: string[],
  seen: WeakSet<object>,
  depth: number,
): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    out.push(String(value));
    return;
  }
  if (typeof value !== "object" || value === null || depth > MAX_DEPTH) {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  if (value instanceof Error) {
    out.push(value.name, value.message, value.stack ?? "");
    walk(value.cause, out, seen, depth + 1);
  } else if (value instanceof URL) {
    out.push(value.href);
  } else if (value instanceof Request || value instanceof Response) {
    out.push(value.url);
    walk(value.headers, out, seen, depth + 1);
  } else if (
    value instanceof Headers ||
    value instanceof Map ||
    value instanceof URLSearchParams ||
    value instanceof FormData
  ) {
    for (const [key, entry] of (
      value as { entries: () => Iterable<[unknown, unknown]> }
    ).entries()) {
      walk(key, out, seen, depth + 1);
      walk(entry, out, seen, depth + 1);
    }
    return;
  } else if (value instanceof Set || Array.isArray(value)) {
    for (const entry of value) {
      walk(entry, out, seen, depth + 1);
    }
    return;
  } else if (
    typeof (value as { toString?: unknown }).toString === "function" &&
    (value as { toString: unknown }).toString !== Object.prototype.toString
  ) {
    try {
      out.push(String(value));
    } catch {
      // A toString that throws carries nothing to scan.
    }
  }
  for (const key of Object.keys(value)) {
    out.push(key);
    walk((value as Record<string, unknown>)[key], out, seen, depth + 1);
  }
}

/** The forms a secret is looked for in, besides base64: as it is, and URL-encoded. */
function forms(secret: string): string[] {
  return [...new Set([secret, encodeURIComponent(secret)])];
}

/** Runs of base64 long enough to hide a secret, decoded (standard and URL-safe alphabets). */
function decodedBase64(piece: string): string[] {
  const out: string[] = [];
  for (const match of piece.matchAll(/[\w+/-]{12,}={0,2}/g)) {
    const run = match[0];
    for (let skip = 0; skip < 4; skip++) {
      // A run may start mid-quantum when it follows other base64 text.
      out.push(Buffer.from(run.slice(skip), "base64").toString("latin1"));
    }
  }
  return out;
}

/**
 * The secrets found in `values`' text, each once, by index in `secrets`.
 * A secret counts when it appears as it is, URL-encoded, or inside a run of
 * base64 (a `Basic` credential, an encoded token).
 */
export function findSecrets(
  /** What to scan. */
  values: readonly unknown[],
  /** The secrets (canaries) to look for. */
  secrets: readonly string[],
): { index: number; where: string }[] {
  const found: { index: number; where: string }[] = [];
  const texts = values.map((value, at) => {
    const text = textOf(value);
    return { at, text: [...text, ...text.flatMap(decodedBase64)] };
  });
  secrets.forEach((secret, index) => {
    const looks = forms(secret);
    for (const { at, text } of texts) {
      const hit = text.find((piece) =>
        looks.some((form) => piece.includes(form)),
      );
      if (hit !== undefined) {
        found.push({ index, where: String(at) });
        return;
      }
    }
  });
  return found;
}

/** What {@link trackTimers} answers: the timers still pending, and how to stop tracking. */
export interface TimerTracker {
  /** Runs `fn` as the tracked call: timers created inside it, or in anything it continues, are counted. */
  run: <T>(fn: () => T) => T;
  /** Tracked timers that have neither fired nor been cleared. */
  pending: () => number;
  /** Puts the global timer functions back. */
  restore: () => void;
}

/**
 * Replaces the global `setTimeout`/`setInterval` and their clears with
 * counting wrappers until `restore()`, so the kit can see a timer a call
 * left behind. Only timers created in the call's async context are counted
 * (an `AsyncLocalStorage` entered by `run`, which follows promise
 * continuations, timer callbacks and the listeners they fire): other code in
 * the process, such as another test's pollers, is not the provider's.
 */
export function trackTimers(): TimerTracker {
  const call = new AsyncLocalStorage<true>();
  const original = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  const live = new Set<unknown>();
  // A clear by the handle itself, or by its number (Bun timers coerce to one).
  const forget = (handle: unknown): void => {
    for (const one of live) {
      if (one === handle || Number(one) === Number(handle)) {
        live.delete(one);
      }
    }
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.setTimeout = (
    callback: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ): unknown => {
    let handle: unknown;
    const fire = (...inner: unknown[]): void => {
      live.delete(handle);
      callback(...inner);
    };
    handle = (original.setTimeout as (...a: unknown[]) => unknown)(
      fire,
      ms,
      ...args,
    );
    if (call.getStore() === true) {
      live.add(handle);
    }
    return handle;
  };
  g.setInterval = (
    callback: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ): unknown => {
    const handle = (original.setInterval as (...a: unknown[]) => unknown)(
      callback,
      ms,
      ...args,
    );
    if (call.getStore() === true) {
      live.add(handle);
    }
    return handle;
  };
  g.clearTimeout = (handle: unknown): void => {
    forget(handle);
    (original.clearTimeout as (h: unknown) => void)(handle);
  };
  g.clearInterval = (handle: unknown): void => {
    forget(handle);
    (original.clearInterval as (h: unknown) => void)(handle);
  };
  return {
    run: (fn) => call.run(true, fn),
    pending: () => live.size,
    restore: () => {
      Object.assign(globalThis, original);
    },
  };
}
