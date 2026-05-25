/**
 * Shared test helpers for constructing {@link BunRequest}/{@link BunResponse}
 * instances without standing up a full HTTP server per test.
 */
import type { Server } from "bun";
import { BunRequest } from "../lib/BunRequest";
import { BunResponse } from "../lib/BunResponse";

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
  });
}

/** Builds a {@link BunResponse} bound to a fresh request. */
export async function makeResponse(
  init: MakeRequestInit = {},
): Promise<BunResponse> {
  const request = await makeRequest(init);
  return new BunResponse(request);
}
