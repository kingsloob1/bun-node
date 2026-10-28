/**
 * Shared pieces of the encryption tests (the encryption plan, PR-E1): fixed
 * ring keys, a cache on the memory driver and a fake clock with its `error`
 * events collected, raw reads and plants, and test user ciphers — a real
 * AES-256-GCM that authenticates the AAD, sync or async, and one that does
 * not (the conformance kit's negative control).
 */
import type { LogEvent } from "@kingsleyweb/bun-common";
import { createTestLogger } from "@kingsleyweb/bun-common";
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv } from "node:crypto";
import type {
  CacheCipher,
  CacheDecryptError,
  CacheEventMap,
  CreateCacheOptions,
} from "../../lib/index";
import { createCache, memoryDriver } from "../../lib/index";
import { fakeClock } from "../../lib/testing/index";

/** The clock every test starts at. */
export const T0 = 1_700_000_000_000;

/** A ring key of 32 bytes, all `fill`. */
export function ringKey(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

/** Key `a` (bytes of 1). */
export const KEY_A = ringKey(1);
/** Key `b` (bytes of 2). */
export const KEY_B = ringKey(2);

/** A recognisable plaintext, searched for in stored bytes. */
export const SENTINEL = "bun-cache-encryption-sentinel-0123456789";

/** A cache on the memory driver, with the driver, the clock, every `error` event and every log record exposed. */
export function setup(
  options: Omit<CreateCacheOptions, "driver"> = {},
  shared?: {
    /** A driver another cache already uses (to share a store). */
    driver?: ReturnType<typeof memoryDriver>;
    /** Its clock. */
    clock?: ReturnType<typeof fakeClock>;
  },
): {
  /** The cache. */
  cache: ReturnType<typeof createCache>;
  /** The driver under it. */
  driver: ReturnType<typeof memoryDriver>;
  /** The shared fake clock. */
  clock: ReturnType<typeof fakeClock>;
  /** Every `error` event. */
  errors: CacheEventMap["error"][];
  /** Every log record. */
  logs: LogEvent[];
} {
  const clock = shared?.clock ?? fakeClock(T0);
  const driver = shared?.driver ?? memoryDriver({ now: clock.now });
  const { logger, events: logs } = createTestLogger();
  const cache = createCache({
    driver,
    sweepInterval: 0,
    logger,
    ...options,
    now: clock.now,
  });
  const errors: CacheEventMap["error"][] = [];
  cache.on("error", (event) => {
    errors.push(event);
  });
  return { cache, driver, clock, errors, logs };
}

/** The stored bytes at `key` in `ns`. */
export async function storedBytes(
  driver: ReturnType<typeof memoryDriver>,
  key: string,
  ns = "cache",
): Promise<Uint8Array> {
  const stored = await driver.get(ns, key);
  if (stored === undefined) {
    throw new Error(`nothing stored at ${ns}/${key}`);
  }
  return stored.value;
}

/** Whether `bytes` holds `text` as UTF-8. */
export function contains(bytes: Uint8Array, text: string): boolean {
  return Buffer.from(bytes).includes(Buffer.from(text));
}

/** The decrypt errors among `errors`, as `CacheDecryptError`s. */
export function decryptErrors(
  errors: readonly CacheEventMap["error"][],
): CacheDecryptError[] {
  return errors
    .filter((event) => event.phase === "decrypt")
    .map((event) => event.error as CacheDecryptError);
}

/** The test cipher's own key. */
const CIPHER_KEY = new Uint8Array(32).fill(7);

/**
 * A user cipher: AES-256-GCM under one fixed key, a random nonce per seal,
 * authenticating `context.aad` (or not, with `ignoreAad` — the negative
 * control). Its output is nonce ‖ ciphertext ‖ tag. With `async`, both
 * functions answer promises.
 */
export function testCipher(
  options: {
    /** Its id; defaults to 200. */
    id?: number;
    /** Answer promises. */
    async?: boolean;
    /** Skip `setAAD`: a cipher the conformance kit must fail. */
    ignoreAad?: boolean;
    /** The key; defaults to a fixed one. */
    key?: Uint8Array;
  } = {},
): CacheCipher {
  const key = options.key ?? CIPHER_KEY;
  const seal = (plaintext: Uint8Array, aad: Uint8Array): Uint8Array => {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    if (options.ignoreAad !== true) {
      cipher.setAAD(aad);
    }
    return Buffer.concat([
      nonce,
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
  };
  const open = (sealed: Uint8Array, aad: Uint8Array): Uint8Array => {
    if (sealed.length < 28) {
      throw new Error("too short");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      sealed.subarray(0, 12),
    );
    if (options.ignoreAad !== true) {
      decipher.setAAD(aad);
    }
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([
      decipher.update(sealed.subarray(12, sealed.length - 16)),
      decipher.final(),
    ]);
  };
  const id = options.id ?? 200;
  if (options.async === true) {
    return {
      id,
      seal: async (plaintext, context) => {
        await Promise.resolve();
        return seal(plaintext, context.aad);
      },
      open: async (sealed, context) => {
        await Promise.resolve();
        return open(sealed, context.aad);
      },
    };
  }
  return {
    id,
    seal: (plaintext, context) => seal(plaintext, context.aad),
    open: (sealed, context) => open(sealed, context.aad),
  };
}
