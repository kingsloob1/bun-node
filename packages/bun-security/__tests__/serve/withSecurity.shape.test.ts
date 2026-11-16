/**
 * `withSecurity` with PR-S3's layers on a real `Bun.serve` over raw sockets,
 * where no client normalises the request line: T-L6-2 (two `Host` lines,
 * which Bun accepts, `docs/bun-bugs/duplicate-host-accepted.md`, are
 * refused with `400`), T-L6-1 (`//admin` and `/a/%2e%2e/admin` reach the
 * `/admin` rule), an encoded slash refused, and a honeypot answered `404`
 * and the client banned from its next request.
 */
import { connect } from "node:net";
import { afterAll, describe, expect, it } from "bun:test";
import { createSecurity } from "../../lib/index";
import type { SecurityPolicy } from "../../lib/index";
import { withSecurity } from "../../lib/serve/index";

/** Servers to stop after the file. */
const servers: Bun.Server<undefined>[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop(true)));
});

/** Serves a handler behind the engine on port 0; answers its port and what it saw. */
function serve(policy: SecurityPolicy): { port: number; seen: string[] } {
  const seen: string[] = [];
  const security = createSecurity<Request>({ policy, logger: () => {} });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: withSecurity(
      security,
      (request) => {
        seen.push(new URL(request.url).pathname);
        return new Response("handled");
      },
      { logger: () => {} },
    ),
  });
  servers.push(server);
  return { port: server.port ?? 0, seen };
}

/** Sends `head` (a request line and headers) as written; answers the status line. */
function send(port: number, head: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = "";
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`${head}Connection: close\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      received += chunk.toString();
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(received.split("\r\n")[0] ?? ""));
  });
}

describe("withSecurity, raw requests", () => {
  it("T-L6-2: refuses two Host lines with 400 before the handler", async () => {
    const { port, seen } = serve({});
    expect(
      await send(
        port,
        "GET / HTTP/1.1\r\nHost: a.example\r\nHost: b.example\r\n",
      ),
    ).toBe("HTTP/1.1 400 Bad Request");
    expect(seen).toEqual([]);
    // Negative control: one Host line is served.
    expect(await send(port, "GET / HTTP/1.1\r\nHost: a.example\r\n")).toBe(
      "HTTP/1.1 200 OK",
    );
  });

  it("T-L6-1: //admin and /a/%2e%2e/admin reach the /admin rule; an encoded slash is refused", async () => {
    const { port, seen } = serve({
      internal: false,
      lists: [{ ip: "127.0.0.0/8", action: "block", paths: ["/admin"] }],
    });
    for (const target of ["/admin", "//admin", "/a/%2e%2e/admin", "/ADMIN/x"]) {
      expect({
        target,
        line: await send(port, `GET ${target} HTTP/1.1\r\nHost: x\r\n`),
      }).toEqual({
        target,
        line: "HTTP/1.1 403 Forbidden",
      });
    }
    expect(await send(port, "GET /files/a%2Fb HTTP/1.1\r\nHost: x\r\n")).toBe(
      "HTTP/1.1 400 Bad Request",
    );
    expect(await send(port, "GET /public HTTP/1.1\r\nHost: x\r\n")).toBe(
      "HTTP/1.1 200 OK",
    );
    expect(seen).toEqual(["/public"]);
  });

  it("answers a honeypot 404, then bans the client", async () => {
    const { port } = serve({
      internal: false,
      deception: { honeypots: { answer: "not-found" } },
    });
    expect(await send(port, "GET /.env HTTP/1.1\r\nHost: x\r\n")).toBe(
      "HTTP/1.1 404 Not Found",
    );
    expect(await send(port, "GET / HTTP/1.1\r\nHost: x\r\n")).toBe(
      "HTTP/1.1 403 Forbidden",
    );
  });
});
