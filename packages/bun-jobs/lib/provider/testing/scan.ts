import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import * as timersPromises from "node:timers/promises";
import { promisify } from "node:util";

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
  /** Stops tracking; the last tracker to stop puts the global timer functions back. */
  restore: () => void;
}

/** One tracker's state: its call context and the timers it has seen. */
interface Tracking {
  /** Entered by `run`; a timer created inside it is this tracker's. */
  call: AsyncLocalStorage<true>;
  /** Its timers still pending. */
  live: Set<unknown>;
}

/** The global timer functions the wrappers stand in for. */
interface TimerGlobals {
  /** `setTimeout`. */
  setTimeout: typeof globalThis.setTimeout;
  /** `clearTimeout`. */
  clearTimeout: typeof globalThis.clearTimeout;
  /** `setInterval`. */
  setInterval: typeof globalThis.setInterval;
  /** `clearInterval`. */
  clearInterval: typeof globalThis.clearInterval;
}

/** The names of the globals swapped. */
const TIMER_NAMES = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
] as const;

/**
 * The swap shared by every tracker in the process: installed by the first
 * `trackTimers()`, and the true originals put back by the last `restore()`,
 * so overlapping trackers (two kit runs at once) never leave a wrapper
 * behind. `undefined` while none is active.
 */
let installed:
  | {
      /** The globals as they were before the first tracker. */
      originals: TimerGlobals;
      /** The wrappers installed in their place. */
      wrappers: TimerGlobals;
      /** The trackers active now. */
      trackers: Set<Tracking>;
    }
  | undefined;

/** Installs the shared wrappers, capturing the true originals. */
function install(): NonNullable<typeof installed> {
  const originals: TimerGlobals = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  const trackers = new Set<Tracking>();
  /** A timer handle created now, added to every tracker whose call it is in. */
  const note = (handle: unknown): void => {
    for (const tracking of trackers) {
      if (tracking.call.getStore() === true) {
        tracking.live.add(handle);
      }
    }
  };
  // A clear by the handle itself, or by its number (Bun timers coerce to one).
  const forget = (handle: unknown): void => {
    for (const tracking of trackers) {
      for (const one of tracking.live) {
        if (one === handle || Number(one) === Number(handle)) {
          tracking.live.delete(one);
        }
      }
    }
  };
  type Timer = (this: unknown, ...args: unknown[]) => unknown;
  /**
   * Gives a wrapper `util.promisify`'s custom form, taken from
   * `node:timers/promises` rather than read off the native timer: on Bun
   * 1.4.2 and 1.4.3 a warm read site of `timer[promisify.custom]` answers
   * one timer's form for another (setInterval's async iterator for
   * setTimeout), https://github.com/oven-sh/bun/issues/44275. Read it off
   * the timer again once that is fixed.
   */
  const promisified = (body: Timer, custom: unknown): Timer => {
    Object.defineProperty(body, promisify.custom, { value: custom });
    return body;
  };
  const wrappers = {
    setTimeout: promisified(function (callback, ...rest) {
      let handle: unknown;
      const fire = (...inner: unknown[]): void => {
        for (const tracking of trackers) {
          tracking.live.delete(handle);
        }
        (callback as (...a: unknown[]) => void)(...inner);
      };
      handle = Reflect.apply(originals.setTimeout, this, [
        typeof callback === "function" ? fire : callback,
        ...rest,
      ]);
      note(handle);
      return handle;
    }, timersPromises.setTimeout),
    setInterval: promisified(function (...args) {
      const handle = Reflect.apply(originals.setInterval, this, args);
      note(handle);
      return handle;
    }, timersPromises.setInterval),
    clearTimeout: function (this: unknown, handle: unknown) {
      forget(handle);
      return Reflect.apply(originals.clearTimeout, this, [handle]);
    } as Timer,
    clearInterval: function (this: unknown, handle: unknown) {
      forget(handle);
      return Reflect.apply(originals.clearInterval, this, [handle]);
    } as Timer,
  } as unknown as TimerGlobals;
  Object.assign(globalThis, wrappers);
  return { originals, wrappers, trackers };
}

/**
 * Replaces the global `setTimeout`/`setInterval` and their clears with
 * counting wrappers until `restore()`, so the kit can see a timer a call
 * left behind. The swap is brief (the timeouts check, about 2 s) and is
 * always undone, in a `finally`; the wrappers keep `this` and
 * `util.promisify`'s custom forms. Trackers may overlap (two kit runs at
 * once): the wrappers are installed once, and the true originals come back
 * when the last tracker stops, for each global still holding a wrapper (one
 * something else replaced meanwhile is left as it is). Only timers created
 * in a tracker's call context are its own (an `AsyncLocalStorage` entered by
 * `run`, which follows promise continuations, timer callbacks and the
 * listeners they fire): other code in the process, such as another test's
 * pollers, is not the provider's.
 */
export function trackTimers(): TimerTracker {
  installed ??= install();
  const swap = installed;
  const tracking: Tracking = {
    call: new AsyncLocalStorage<true>(),
    live: new Set(),
  };
  swap.trackers.add(tracking);
  let stopped = false;
  return {
    run: (fn) => tracking.call.run(true, fn),
    pending: () => tracking.live.size,
    restore: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      swap.trackers.delete(tracking);
      if (swap.trackers.size > 0 || installed !== swap) {
        return;
      }
      installed = undefined;
      const g = globalThis as unknown as Record<string, unknown>;
      for (const name of TIMER_NAMES) {
        if (g[name] === swap.wrappers[name]) {
          g[name] = swap.originals[name];
        }
      }
    },
  };
}
