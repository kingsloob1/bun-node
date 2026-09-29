/**
 * The prototype adapters: bun-common's and bun-nest's `BunHttpAdapter`,
 * subclassed so `listen()` hands `Bun.serve` a native `routes` table built by
 * `NativeRoutes`. No library code changes.
 *
 * Two switches, read at construction, so the existing test files can run
 * against these classes unmodified (see tests/preload.ts):
 *
 * - `BNR_NATIVE=1` — native routes on (the thing under test).
 * - `BNR_SERVED=1` — `adapter.fetch()` goes over a real socket to a server
 *   this adapter starts on port 0, instead of calling `handleNativeRequest`
 *   in process. Most tests use `fetch()`; without this they would never touch
 *   `Bun.serve`, so native routing would go untested.
 */
import process from "node:process";
import type { FetchInput } from "../../../../../packages/bun-common/lib/BunRouter";
import { toNativeRequest } from "../../../../../packages/bun-common/lib/BunRouter";
import { installCandidateIndex, installRingCache } from "./candidate-index";
import { NativeRoutes, nativeStats } from "./native-routes";

type ListenArgs = [port: string | number, ...rest: unknown[]];
interface AdapterShape {
  instance: unknown;
  isListening: boolean;
  url: string;
  listen(...args: ListenArgs): Promise<unknown>;
  close(): Promise<void>;
  fetch(input: never, init?: RequestInit): Promise<Response>;
}

/** What the mixin adds to an adapter instance. */
export interface NativeRoutesFlags {
  /** Whether `listen()` installs native routes. */
  nativeRoutesEnabled: boolean;
  /** Whether `fetch()` goes over a real socket (test mode). */
  servedFetch: boolean;
}

/** Adds native routing (and the served-fetch test mode) to an adapter class. */
export function withNativeRoutes<TBase extends abstract new (...args: any) => object>(
  Adapter: TBase,
): new (...args: ConstructorParameters<TBase>) => InstanceType<TBase> & NativeRoutesFlags {
  const Base = Adapter as unknown as new (...args: any[]) => AdapterShape;
  class NativeRoutesAdapter extends Base implements NativeRoutesFlags {
    /** Whether `listen()` installs native routes. */
    nativeRoutesEnabled = process.env.BNR_NATIVE === "1";
    /** Whether `fetch()` goes over a real socket (test mode). */
    servedFetch = process.env.BNR_SERVED === "1";
    #native: NativeRoutes | undefined;
    #userRoutes: Record<string, unknown> | undefined;

    constructor(...args: any[]) {
      super(...args);
      if (process.env.BNR_INDEX === "1") installCandidateIndex(this.instance as never);
      if (process.env.BNR_RINGCACHE === "1") installRingCache(this.instance as never);
    }

    override async listen(...args: ListenArgs) {
      if (this.nativeRoutesEnabled) {
        const self = this as unknown as { serverOptions?: { routes?: Record<string, unknown> } };
        const options = (self.serverOptions ??= {});
        this.#userRoutes ??= options.routes ?? {};
        this.#native ??= new NativeRoutes(this as never, this.#userRoutes);
        options.routes = { ...this.#native.build(), ...this.#userRoutes };
      }
      return super.listen(...args);
    }

    override async close() {
      this.#native?.dispose();
      return super.close();
    }

    override async fetch(input: never, init?: RequestInit): Promise<Response> {
      if (!this.servedFetch) return super.fetch(input, init);
      if (!this.isListening) await this.listen(0);
      nativeStats.servedFetches++;
      const request = toNativeRequest(input as FetchInput, init);
      const original = new URL(request.url);
      const target = new URL(`${original.pathname}${original.search}`, this.url);
      const headers = new Headers(request.headers);
      if (!headers.has("host")) headers.set("host", original.host);
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      return globalThis.fetch(target, {
        method: request.method,
        headers,
        body: hasBody ? await request.arrayBuffer() : undefined,
        redirect: "manual",
        decompress: false,
      } as RequestInit);
    }
  }
  return NativeRoutesAdapter as never;
}
