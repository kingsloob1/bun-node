/**
 * Shared test helpers for constructing {@link BunRequest}/{@link BunResponse}
 * instances without standing up a full HTTP server per test.
 */
import type { Server } from "bun";
import { BunRequest } from "../lib/BunRequest";
import { BunResponse } from "../lib/BunResponse";

/** The options object accepted by {@link BunRequest}'s constructor. */
type BunRequestOptions = ConstructorParameters<typeof BunRequest>[2];

/** A long-lived loopback server reused as the `server` argument for requests. */
export const testServer: Server<unknown> = Bun.serve({
  port: 0,
  fetch: () => new Response("ok"),
  websocket: {
    message: () => {},
    open: () => {},
    close: () => {},
    drain: () => {},
  },
});

export interface MakeRequestInit {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  /** Extra {@link BunRequest} options, merged over the helper defaults. */
  options?: Partial<NonNullable<BunRequestOptions>>;
}

/** Builds and fully initialises a {@link BunRequest}. */
export async function makeRequest(
  init: MakeRequestInit = {},
): Promise<BunRequest> {
  const request = new Request(init.url ?? "http://localhost/", {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body,
  });

  return BunRequest.init(request, testServer, {
    parseBody: !!init.body,
    parseCookies: true,
    parseQuery: true,
    ...init.options,
  });
}

/** Builds a {@link BunResponse} bound to a fresh request. */
export async function makeResponse(
  init: MakeRequestInit = {},
): Promise<BunResponse> {
  const request = await makeRequest(init);
  return new BunResponse(request);
}
