/**
 * The security app's API client: bun-client's typed calls over the
 * generated route map (`routes.gen.ts`, `bun run gen:client`), through one
 * `fetch` that adds what every call needs — the CSRF header on a mutation,
 * the break-glass token while a session lasts (and forgets it on a `401`) —
 * and turns every failure into this app's {@link ApiError}.
 */
import type { Client, ClientMiddleware } from "@kingsleyweb/bun-client";
import type { SecurityUiConfig } from "../../../lib/security/browser/config.ts";
import type { BreakGlassStore } from "../session/breakGlass";
import type { Routes } from "./routes.gen";
import { createClient, NetworkError } from "@kingsleyweb/bun-client";
import { ApiError, errorFromResponse } from "./errors";
import { manifest } from "./routes.gen";

/** The client and what it is built on. */
export interface SecurityClient {
  /** The typed client: `api.client.get("/meta")`. */
  readonly client: Client<Routes>;
  /** The API's base (`config.apiBase`). */
  readonly base: string;
  /** The break-glass session. */
  readonly breakGlass: BreakGlassStore;
  /** `fetch` with the app's headers (the live stream and the documents use it). */
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Called when a `401` ended the break-glass session (the layout re-renders). */
  readonly onSessionEnded: (listener: () => void) => () => void;
}

/** Options of {@link createSecurityClient}. */
export interface SecurityClientOptions {
  /** The fetch to use (tests pass their own). Default the global `fetch`. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

/** The methods that change something: they carry the CSRF header. */
const MUTATIONS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Builds the client for `config`. */
export function createSecurityClient(
  config: SecurityUiConfig,
  breakGlass: BreakGlassStore,
  options: SecurityClientOptions = {},
): SecurityClient {
  const raw =
    options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const listeners = new Set<() => void>();
  const send = async (
    input: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    const method = (init.method ?? "GET").toUpperCase();
    if (MUTATIONS.has(method) && !headers.has(config.csrfHeader))
      headers.set(config.csrfHeader, "1");
    const session = breakGlass.current();
    if (session !== null) headers.set(session.header, session.token);
    let response: Response;
    try {
      response = await raw(input, {
        credentials: "same-origin",
        ...init,
        method,
        headers,
      });
    } catch (cause) {
      throw new ApiError({
        status: 0,
        code: "NETWORK_ERROR",
        title: "The security API could not be reached",
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (response.status === 401 && session !== null) {
      // The session expired or was refused: forget it.
      breakGlass.clear();
      for (const listener of listeners) listener();
    }
    return response;
  };
  /** Every failed answer becomes an `ApiError`, thrown. */
  const failures: ClientMiddleware = async (_ctx, next) => {
    let response: Response;
    try {
      response = await next();
    } catch (error) {
      if (error instanceof NetworkError) {
        throw new ApiError({
          status: 0,
          code: "NETWORK_ERROR",
          title: "The security API could not be reached",
        });
      }
      throw error;
    }
    if (!response.ok && response.status !== 304)
      throw await errorFromResponse(response);
    return response;
  };
  const client = createClient<Routes>({
    baseUrl: config.apiBase,
    manifest,
    fetch: async (request) => {
      const init: RequestInit = {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
      };
      if (request.method !== "GET" && request.method !== "HEAD") {
        const body = await request.text();
        if (body !== "") init.body = body;
      }
      return await send(request.url, init);
    },
    middleware: [failures],
    retry: false,
    timeout: false,
  });
  return Object.freeze({
    client,
    base: config.apiBase,
    breakGlass,
    fetch: send,
    onSessionEnded: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

/** The data of a call's successful answers (a union when it has several, as `200 | 202`). */
export type DataOf<R> = R extends { ok: true; data: infer D } ? D : never;

/** A call's data, its failure thrown as an `ApiError` (the middleware already threw for a problem). */
export async function dataOf<R extends { ok: boolean }>(
  call: Promise<R>,
): Promise<DataOf<R>> {
  const result = await call;
  if (result.ok) return (result as unknown as { data: DataOf<R> }).data;
  const response = (result as unknown as { response?: Response }).response;
  if (response === undefined) {
    throw new ApiError({
      status: 0,
      code: "NETWORK_ERROR",
      title: "The security API could not be reached",
    });
  }
  throw await errorFromResponse(response);
}
