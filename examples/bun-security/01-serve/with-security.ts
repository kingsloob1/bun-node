/**
 * A plain `Bun.serve` behind bun-security: `withSecurity` around the fetch
 * handler and `hardenServe` around the options, on a real socket.
 *
 * ```bash
 * bun 01-serve/with-security.ts
 * ```
 *
 * - `withSecurity(security, fetch, options)` turns each request into facts,
 *   asks the engine, and answers a refusal itself (problem+json, or a small
 *   HTML page for a browser), so the handler only ever sees what passed.
 * - The client is the socket peer unless `trustProxy` trusts it. Here the
 *   server listens on localhost and trusts it as the proxy (`"loopback"`),
 *   so each request names its client in `X-Forwarded-For`, as a proxy in
 *   front of the service would. A loopback client of its own would be in
 *   the built-in `internal` list, which no address entry refuses.
 * - `hardenServe` sets `idleTimeout` (10 s) and `maxRequestBodySize` (1 MiB)
 *   unless you set them.
 */
import { createSecurity } from "@kingsleyweb/bun-security";
import { hardenServe, withSecurity } from "@kingsleyweb/bun-security/serve";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("withSecurity on a plain Bun.serve");

const security = createSecurity({
  policy: {
    service: "checkout",
    lists: [
      { ip: "203.0.113.0/24", action: "block", reason: "scanner" },
      { user: "u_mallory", action: "block" },
    ],
  },
  identify: (req) => ({ user: req.headers.get("x-user-id") ?? undefined }),
  logger: () => {},
});

const options = hardenServe({
  port: 0,
  hostname: "127.0.0.1",
  fetch: withSecurity(
    security,
    (req) => new Response(`hello from ${new URL(req.url).pathname}`),
    { trustProxy: "loopback", logger: () => {} },
  ),
});
checkEqual("hardenServe set idleTimeout", options.idleTimeout, 10);
const server = Bun.serve(options);
const base = `http://127.0.0.1:${server.port}`;

/** A request from `client`, as the proxy in front would forward it. */
function from(
  client: string,
  path = "/",
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: { "x-forwarded-for": client, ...headers },
  });
}

try {
  /* ------------------------------------------------------------------ */
  step("an ordinary client passes");
  const ok = await from("198.51.100.10", "/cart");
  show("198.51.100.10", `${ok.status} ${await ok.text()}`);
  checkEqual("200 from the handler", ok.status, 200);

  /* ------------------------------------------------------------------ */
  step("a listed range is refused before the handler runs");
  const blocked = await from("203.0.113.9", "/cart");
  const problem = (await blocked.json()) as Record<string, unknown>;
  show("203.0.113.9", { status: blocked.status, problem });
  checkEqual("403", blocked.status, 403);
  checkEqual(
    "problem+json",
    blocked.headers.get("content-type"),
    "application/problem+json",
  );
  checkEqual("the code, never the rule's name", problem.code, "blocked");
  check("no reason in the body", !JSON.stringify(problem).includes("scanner"));

  /* ------------------------------------------------------------------ */
  step("a listed user, from identify()");
  const mallory = await from("198.51.100.11", "/cart", {
    "x-user-id": "u_mallory",
  });
  await mallory.body?.cancel();
  checkEqual("u_mallory refused", mallory.status, 403);

  /* ------------------------------------------------------------------ */
  step("a browser gets a small HTML page instead");
  const page = await from("203.0.113.9", "/", { accept: "text/html" });
  const html = await page.text();
  show("page", html.split("\n")[0]);
  check(
    "an HTML answer",
    page.headers.get("content-type")?.startsWith("text/html") === true,
  );

  /* ------------------------------------------------------------------ */
  step("a spoofed X-Forwarded-For from an untrusted peer is never read");
  // The same server with no trustProxy: the peer (loopback, internal) is the
  // client, and the header claiming a blocked range is ignored.
  const direct = Bun.serve(
    hardenServe({
      port: 0,
      hostname: "127.0.0.1",
      fetch: withSecurity(security, () => new Response("ok"), {
        logger: () => {},
      }),
    }),
  );
  const spoofed = await fetch(`http://127.0.0.1:${direct.port}/`, {
    headers: { "x-forwarded-for": "203.0.113.9" },
  });
  await spoofed.body?.cancel();
  checkEqual(
    "the claim is ignored: the peer is the client",
    spoofed.status,
    200,
  );
  await direct.stop(true);
} finally {
  await server.stop(true);
  security.close();
}

summary();
