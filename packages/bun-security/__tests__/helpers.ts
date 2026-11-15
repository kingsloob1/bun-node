/**
 * Shared test helpers: a seeded random source (so a property test's failure
 * is reproducible from the seed it prints), a fake clock, and request facts
 * built without a socket.
 */
import type { RequestFacts } from "../lib/engine/facts";

/** A small seeded PRNG (mulberry32): the same seed, the same sequence. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random 32-bit word from `random`. */
export function randomWord(random: () => number): number {
  return Math.floor(random() * 0x100000000) >>> 0;
}

/** A clock the test moves by hand. */
export interface FakeClock {
  /** The current time, in milliseconds since the epoch. */
  now: () => number;
  /** Moves the clock forward by `ms`. */
  advance: (ms: number) => void;
}

/** A {@link FakeClock} starting at `start` (a whole minute by default). */
export function fakeClock(start = Date.UTC(2026, 10, 15, 12, 0, 0)): FakeClock {
  let time = start;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
}

/** Request facts for a test: a `GET /` from `client`, peer the same unless given. */
export function facts(overrides: Partial<RequestFacts> = {}): RequestFacts {
  const client = overrides.client ?? "203.0.113.10";
  return {
    method: "GET",
    path: "/",
    rawPath: "/",
    headers: {},
    cookieNames: [],
    peer: client,
    client,
    chain: [{ address: client, source: "socket", trusted: false }],
    ...overrides,
  };
}
