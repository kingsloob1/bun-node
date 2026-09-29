// Shared by bench.ts (the queue host) and executor.ts (the remote).
// A throwaway: a JSON frame with a per-frame HMAC, the shape of
// remote-transports.md §4.4.1 minus the session id and sequence number.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SECRET = "gwplan-bench-secret-not-a-real-one";

/** One attempt pushed to (or pulled by) the remote. */
export interface Item {
  id: string;
  name: string;
  data: unknown;
  /** Only in pull-proxy mode: the claim's lock token. */
  token?: string;
}

/** One outcome sent back. */
export interface Outcome {
  id: string;
  result?: unknown;
  error?: string;
  token?: string;
}

export function seal(obj: unknown): string {
  const json = JSON.stringify(obj);
  const mac = createHmac("sha256", SECRET).update(json).digest("hex");
  return `${mac}.${json}`;
}

export function open<T>(frame: string): T {
  const dot = frame.indexOf(".");
  const mac = Buffer.from(frame.slice(0, dot), "hex");
  const json = frame.slice(dot + 1);
  const want = createHmac("sha256", SECRET).update(json).digest();
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) {
    throw new Error("bad mac");
  }
  return JSON.parse(json) as T;
}

/** The trivial job every mode runs. */
export function work(item: Item): unknown {
  return { doubled: ((item.data as { i: number }).i ?? 0) * 2 };
}
