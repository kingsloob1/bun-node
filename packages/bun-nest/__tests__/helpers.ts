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
