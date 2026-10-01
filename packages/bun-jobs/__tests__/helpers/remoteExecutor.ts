/**
 * Helpers for the reference executor's tests: envelopes, signed requests,
 * and the two ways an executor is reached — called directly as a fetch
 * handler, or through a real `Bun.serve` on port 0.
 */

import type {
  InvokeEnvelope,
  RemoteExecutor,
  RemoteInvokeJob,
  RemoteSecret,
} from "../../lib/remote";
import { signEnvelope, verifyEnvelope } from "../../lib/remote";

/** A 32-byte secret. */
export const SECRET = "test-secret-0123456789abcdefghij";
/** Another 32-byte secret: the wrong key. */
export const WRONG_SECRET = "wrong-secret-0123456789abcdefghi";

let counter = 0;
/** A fresh envelope id. */
export function nextId(prefix = "inv"): string {
  counter++;
  return `${prefix}_${process.pid}_${counter}`;
}

/** One job of an invoke, with defaults for every field. */
export function job(overrides: Partial<RemoteInvokeJob> = {}): RemoteInvokeJob {
  const id = overrides.id ?? nextId("job");
  const attempt = overrides.attempt ?? 1;
  return {
    id,
    name: "echo",
    data: null,
    attempt,
    idempotencyKey: `ns:q:${id}:${attempt}`,
    fence: `token-${id}:1000`,
    delivery: 1,
    ...overrides,
  };
}

/** An invoke envelope carrying `jobs`, deadline 30 s out on the gateway's clock. */
export function invoke(
  jobs: RemoteInvokeJob[],
  overrides: Partial<InvokeEnvelope> = {},
): InvokeEnvelope {
  const now = Date.now();
  return {
    v: 1,
    op: "invoke",
    id: nextId(),
    now,
    deadlineAt: now + 30_000,
    namespace: "ns",
    queue: "q",
    worker: { id: "worker-1", key: "svc.q" },
    jobs,
    ...overrides,
  };
}

/** Options for {@link signedPost}. */
export interface SignedPostOptions {
  /** The key to sign with. Default {@link SECRET}. */
  secret?: RemoteSecret;
  /** The signing clock. Default now. */
  now?: number;
  /** The direction to sign as. Default `request`. */
  direction?: "request" | "response";
  /** Extra headers. */
  headers?: Record<string, string>;
  /** Leave the signature off. */
  unsigned?: boolean;
}

/** A `POST` of a body (an envelope, or raw text), signed as a request. */
export async function signedPost(
  url: string,
  body: unknown,
  options: SignedPostOptions = {},
): Promise<Request> {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "bun-jobs-protocol": "1",
    ...options.headers,
  };
  const id = (body as { id?: unknown } | null)?.id;
  if (typeof id === "string") {
    headers["bun-jobs-id"] = id;
  }
  if (!options.unsigned) {
    headers["bun-jobs-signature"] = await signEnvelope(text, {
      direction: options.direction ?? "request",
      secret: options.secret ?? SECRET,
      now: options.now,
    });
  }
  return new Request(url, { method: "POST", body: text, headers });
}

/** A signed handshake `GET`. */
export async function signedGet(
  url: string,
  options: { secret?: RemoteSecret; id?: string; now?: number } = {},
): Promise<Request> {
  const id = options.id ?? nextId("hs");
  return new Request(url, {
    headers: {
      "bun-jobs-id": id,
      "bun-jobs-signature": await signEnvelope(null, {
        direction: "request",
        secret: options.secret ?? SECRET,
        id,
        now: options.now,
      }),
    },
  });
}

/** A response's body and whether its signature verifies as a `response` under `secret`. */
export async function read(
  response: Response,
  secret: RemoteSecret = SECRET,
): Promise<{
  /** The HTTP status. */
  status: number;
  /** The body, parsed (`null` when empty). */
  body: any;
  /** Whether a signature was sent and verifies as a response. */
  signed: boolean;
  /** Whether any signature header was sent. */
  hasSignature: boolean;
}> {
  const text = await response.text();
  const header = response.headers.get("bun-jobs-signature");
  const verified =
    header === null
      ? false
      : (await verifyEnvelope(text, header, { direction: "response", secret }))
          .ok;
  return {
    status: response.status,
    body: text.length === 0 ? null : JSON.parse(text),
    signed: verified,
    hasSignature: header !== null,
  };
}

/** How a test reaches an executor. */
export interface Transport {
  /** The transport's name, for test titles. */
  name: string;
  /** The base URL requests are built against. */
  url: string;
  /** Sends a request to the executor and resolves its answer. */
  send: (request: Request) => Promise<Response>;
  /** Stops anything the transport started. */
  close: () => Promise<void>;
}

/** Calls the executor directly, as a fetch handler. */
export function direct(executor: RemoteExecutor): Transport {
  return {
    name: "direct",
    url: "http://executor.test/bun-jobs",
    send: (request) => executor(request),
    close: async () => {},
  };
}

/** Serves the executor with `Bun.serve` on port 0 and sends over a real socket. */
export function served(executor: RemoteExecutor): Transport {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 255,
    fetch: (request) => executor(request),
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    name: "Bun.serve",
    url: `${base}/bun-jobs`,
    send: (request) => {
      // Re-target the request at the server: same method, headers and body.
      const target = new URL(request.url);
      return fetch(`${base}${target.pathname}${target.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
    },
    close: async () => {
      await server.stop(true);
    },
  };
}

/** Both transports, by name. */
export const TRANSPORTS = { direct, served } as const;

/** A promise and its resolver, for holding a handler until the test lets it go. */
export function gate<T = void>(): {
  /** Settles when `open` is called. */
  promise: Promise<T>;
  /** Lets the promise settle. */
  open: (value: T) => void;
} {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Waits until `check` is true, polling every 5 ms, failing after `ms`. */
export async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error("condition not met in time");
    }
    await Bun.sleep(5);
  }
}
