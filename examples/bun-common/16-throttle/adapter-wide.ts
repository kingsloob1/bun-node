/**
 * Throttling an adapter — the `throttle` option, the headers and the 429.
 *
 * ```bash
 * bun 16-throttle/adapter-wide.ts
 * ```
 *
 * `new BunHttpAdapter(0, { throttle: { limit, window } })` installs a throttle
 * as the router's first middleware, so it covers every route, every mounted
 * router and the not-found handler (a burst of 404s counts too). The default
 * algorithm is a sliding window; the headers are the IETF draft-11 pair
 * `RateLimit-Policy` and `RateLimit`, and a refusal is a `429`
 * `application/problem+json` with `Retry-After`.
 *
 * A fake clock (`now`) makes every count and every "seconds left" exact, and a
 * `key` reading `x-client` stands in for distinct addresses: a socket-free
 * `fetch()` has no `req.ip`, so the default key would be `"unknown"` for all.
 * The last step serves over a real socket, where the default key is the address.
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  BunRouter,
  getThrottleResults,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("Throttling an adapter");

/** A minute-aligned instant, so window edges are exact. */
const T0 = 60_000 * 29_000_000;
let time = T0 + 20_000;

/** Who is calling: the `x-client` header (a socket-free request has no address). */
const byClient = (req: BunRequest): string => req.get("x-client") ?? "anon";

const adapter = new BunHttpAdapter(0, {
  throttle: {
    limit: 3,
    window: "1m",
    headers: "ietf",
    key: byClient,
    now: () => time,
  },
});
const api = new BunRouter();
api.get("/users", (_req, res) => res.json(["ada"]));
adapter.use("/api", api);
adapter.get("/", (req, res) => {
  const [result] = getThrottleResults(req) ?? [];
  res.json({ used: result?.used, remaining: result?.remaining });
});
adapter.setNotFoundHandler((_req, res) => {
  res.status(404).send("nothing here");
});

step("headers on every answer");
const first = await adapter.fetch("/", { headers: { "x-client": "a" } });
checkEqual("200", first.status, 200);
checkEqual(
  "RateLimit-Policy",
  first.headers.get("RateLimit-Policy"),
  '"default";q=3;w=60',
);
checkEqual(
  "RateLimit: 2 left, 40 s to the window's end",
  first.headers.get("RateLimit"),
  '"default";r=2;t=40',
);
checkEqual(
  "no Retry-After on a success",
  first.headers.get("Retry-After"),
  null,
);
checkEqual("the handler sees getThrottleResults(req)", await first.json(), {
  used: 1,
  remaining: 2,
});

step("a mounted router and the not-found handler count too");
const headers = { "x-client": "a" };
checkEqual(
  "mounted route",
  (await adapter.fetch("/api/users", { headers })).status,
  200,
);
checkEqual(
  "a 404 is still counted",
  (await adapter.fetch("/nope", { headers })).status,
  404,
);

step("the fourth request is refused");
const refused = await adapter.fetch("/", { headers });
checkEqual("429", refused.status, 429);
check(
  "problem+json",
  (refused.headers.get("Content-Type") ?? "").includes(
    "application/problem+json",
  ),
);
checkEqual("Cache-Control", refused.headers.get("Cache-Control"), "no-store");
const wait = Number(refused.headers.get("Retry-After"));
check("Retry-After is whole seconds", Number.isInteger(wait) && wait > 0, wait);
checkEqual(
  "RateLimit agrees with Retry-After",
  refused.headers.get("RateLimit"),
  `"default";r=0;t=${wait}`,
);
const body = (await refused.json()) as Record<string, unknown>;
show("429 body", body);
checkEqual("body", body, {
  type: "urn:bun-common:error:TOO_MANY_REQUESTS",
  title: "Too Many Requests",
  status: 429,
  code: "TOO_MANY_REQUESTS",
  detail: `Rate limit exceeded; retry in ${wait} seconds.`,
});

step("another client has its own count");
checkEqual(
  "client b",
  (await adapter.fetch("/", { headers: { "x-client": "b" } })).status,
  200,
);

step("the window moves on");
time += 2 * 60_000;
checkEqual(
  "client a again",
  (await adapter.fetch("/", { headers })).status,
  200,
);

step("over a real socket the default key is the address");
const served = new BunHttpAdapter(0, {
  throttle: { limit: 1, window: "1m", now: () => T0 },
});
served.get("/", (_req, res) => res.send("ok"));
await served.listen(0, "127.0.0.1");
try {
  const url = `http://127.0.0.1:${served.getBunServer()!.port}/`;
  const statuses = [(await fetch(url)).status, (await fetch(url)).status];
  checkEqual("one request per address", statuses, [200, 429]);
} finally {
  await served.close();
}

summary();
