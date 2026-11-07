/**
 * Serves `helpers/api.ts` on port 0, optionally with bun-common's live
 * invalidation mounted first (the route source publishes a route's
 * `.describe({ cache: { invalidates } })` tags once its response is a 2xx).
 * A helper, not an example.
 */
import type { Server } from "bun";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { liveInvalidation } from "@kingsleyweb/bun-common/live";
import { createApi } from "./api";
import type { Api } from "./api";

/** What {@link serveApi} answers. */
export interface Served extends Api {
  /** The adapter. */
  adapter: BunHttpAdapter;
  /** Bun's server: `subscriberCount(topic)` says who is listening. */
  server: Server<unknown>;
  /** `http://127.0.0.1:<port>`. */
  baseUrl: string;
  /** Stops the server. */
  close: () => Promise<void>;
}

/** Starts the API on an OS-assigned port. */
export async function serveApi(
  options: { live?: boolean } = {},
): Promise<Served> {
  const api = createApi();
  const adapter = new BunHttpAdapter(0, { logger: noopLogger });
  // Mounted first: its route source only sees the requests that reach it.
  if (options.live === true) {
    adapter.use(
      liveInvalidation(adapter, { authorize: (_req, _res, next) => next() }),
    );
  }
  adapter.use(api.users.mount, api.users.router);
  const server = (await adapter.listen(0)) as Server<unknown>;
  return {
    ...api,
    adapter,
    server,
    baseUrl: `http://127.0.0.1:${server.port}`,
    close: () => adapter.close(),
  };
}
