/**
 * Shared test helpers for the bun-nest package.
 */
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import type { Server } from "bun";
import { BunRequest } from "@kingsleyweb/bun-common";
import { of } from "rxjs";

/** A loopback server reused as the `server` argument for requests. */
export const testServer: Server<unknown> = Bun.serve({
  port: 0,
  fetch: () => new Response("ok"),
});

/** Builds an initialised multipart {@link BunRequest} from a FormData payload. */
export async function makeMultipartRequest(
  build: (fd: FormData) => void,
): Promise<BunRequest> {
  const fd = new FormData();
  build(fd);
  const request = new Request("http://localhost/upload", {
    method: "POST",
    body: fd,
  });
  return BunRequest.init(request, testServer, {
    parseBody: true,
    parseCookies: false,
    parseQuery: false,
  });
}

/** Minimal NestJS `ExecutionContext` exposing only the HTTP request. */
export function makeExecutionContext(req: BunRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => undefined,
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

/** A `CallHandler` whose stream emits the supplied value. */
export function makeCallHandler(value: unknown = "handled"): CallHandler {
  return { handle: () => of(value) };
}

/** A connected WebSocket test client that buffers and awaits server messages. */
export interface WsTestClient {
  /** The underlying browser-style WebSocket. */
  socket: WebSocket;
  /** Every text frame received, in order (raw strings). */
  received: string[];
  /** Send a raw string (or a JSON-encoded object) to the server. */
  send: (data: string | Record<string, unknown>) => void;
  /**
   * Resolve once a received frame (parsed as JSON) satisfies `predicate`.
   * Rejects after `timeoutMs` (default 2000). Already-buffered frames count.
   */
  waitFor: (
    predicate: (msg: any) => boolean,
    timeoutMs?: number,
  ) => Promise<any>;
  /** Close the socket and resolve once it is fully closed. */
  close: () => Promise<void>;
}

/** Opens a {@link WsTestClient} to `url` and resolves once the socket is open. */
export async function connectWs(
  url: string,
  timeoutMs = 2000,
): Promise<WsTestClient> {
  const socket = new WebSocket(url);
  const received: string[] = [];
  const waiters: {
    predicate: (m: any) => boolean;
    resolve: (m: any) => void;
  }[] = [];

  socket.addEventListener("message", (event) => {
    const raw = String(event.data);
    received.push(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(parsed)) {
        waiters[i].resolve(parsed);
        waiters.splice(i, 1);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`WebSocket open timed out: ${url}`)),
      timeoutMs,
    );
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket errored connecting to ${url}`));
    });
  });

  return {
    socket,
    received,
    send: (data) =>
      socket.send(typeof data === "string" ? data : JSON.stringify(data)),
    waitFor: (predicate, ms = 2000) =>
      new Promise((resolve, reject) => {
        const parsedBuffer = received.map((r) => {
          try {
            return JSON.parse(r);
          } catch {
            return r;
          }
        });
        const existing = parsedBuffer.find((m) => predicate(m));
        if (existing !== undefined) {
          resolve(existing);
          return;
        }
        const timer = setTimeout(
          () =>
            reject(new Error("Timed out waiting for a matching WS message")),
          ms,
        );
        waiters.push({
          predicate,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.addEventListener("close", () => resolve());
        socket.close();
      }),
  };
}
