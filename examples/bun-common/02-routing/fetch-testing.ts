/**
 * Testing without a socket — `router.fetch()` and `adapter.fetch()`: every
 * input form, and proof that the socket-free path answers exactly as a served
 * request does.
 *
 * ```bash
 * bun 02-routing/fetch-testing.ts
 * ```
 *
 * - Same contract as `Bun.serve`'s `fetch`: a `Request` in, a `Response` out.
 *   No port, so nothing to release and nothing to collide with.
 * - A bare path means `GET http://localhost<path>`; an object with a `url` is a
 *   `RequestInit`; a `Request` is used as-is (a second `init` is ignored).
 * - `adapter.fetch()` goes through the adapter's own request handler — not-found
 *   handlers, the payload guard, response finalisation. `router.fetch()` is the
 *   router alone, so an unmatched path is a bare 404.
 * - With no socket there is no peer: `req.ip` is empty. While the adapter is
 *   listening, `adapter.fetch()` uses the live server's origin.
 */
import { BunHttpAdapter, BunRouter } from "@kingsleyweb/bun-common";
import { show, step, title } from "../shared/console";

title("Testing without a socket: fetch()");

/** Summarises a response as `"<status> <content-type> <body>"`. */
async function describe(response: Response): Promise<string> {
  return `${response.status} ${response.headers.get("content-type") ?? "-"} ${await response.text()}`;
}

/* ------------------------------------------------------------------ */
step("Every input form router.fetch() accepts");

const router = new BunRouter();
router.all("/echo", (req, res) => {
  res.json({
    method: req.method,
    path: req.path,
    query: req.query,
    body: req.body ?? null,
    token: req.getHeader("x-token") ?? null,
    host: req.hostname,
  });
});

show("a path — GET", await describe(await router.fetch("/echo?x=1")));
show(
  "a path and a RequestInit",
  await describe(
    await router.fetch("/echo", {
      method: "DELETE",
      headers: { "X-Token": "t1" },
    }),
  ),
);
show(
  "an object with a url",
  await describe(
    await router.fetch({
      url: "/echo",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "hello" }),
    }),
  ),
);
show(
  "a URL",
  await describe(await router.fetch(new URL("http://api.example.test/echo"))),
);
show(
  "a Request — used as-is, init ignored",
  await describe(
    await router.fetch(
      new Request("http://localhost/echo", { method: "PATCH" }),
      { method: "PUT" },
    ),
  ),
);

/* ------------------------------------------------------------------ */
step("router.fetch() vs adapter.fetch()");

/** The same small app, registered on anything with an adapter's surface. */
function build(adapter: BunHttpAdapter): BunHttpAdapter {
  adapter.get("/users/:id", (req, res) => {
    res.status(200).json({ id: req.params.id, query: req.query, ip: req.ip });
  });
  adapter.post("/users", (req, res) => {
    res.status(201).json({ created: req.body ?? null });
  });
  adapter.setNotFoundHandler((req, res) => {
    res.status(404).json({ error: `nothing at ${req.path}` });
  });
  return adapter;
}

const offline = build(new BunHttpAdapter());
show(
  "router.fetch() — nothing matches",
  await describe(await router.fetch("/missing")),
);
show(
  "adapter.fetch() — its not-found handler runs",
  await describe(await offline.fetch("/missing")),
);
show(
  "no socket, so no peer address",
  await describe(await offline.fetch("/users/1")),
);
show("…and no port was bound", offline.isListening);

const concurrent = await Promise.all(
  Array.from(
    { length: 50 },
    async (_, n) => (await offline.fetch(`/users/${n}`)).status,
  ),
);
show("50 concurrent calls, statuses", [...new Set(concurrent)]);

/* ------------------------------------------------------------------ */
step("Parity: the same requests, over a socket and without one");

const served = build(new BunHttpAdapter());
await served.listen(0);

/** Requests to send both ways. */
const targets: { path: string; init?: RequestInit }[] = [
  { path: "/users/42?expand=true" },
  { path: "/missing" },
  {
    path: "/users",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ada" }),
    },
  },
];

for (const { path, init } of targets) {
  const overSocket = await fetch(`${served.url}${path}`, init);
  const withoutSocket = await offline.fetch(path, init);
  const a = await describe(overSocket);
  const b = await describe(withoutSocket);
  // A served request should differ in one way — it has a peer address — so
  // `ip` is left out of the comparison.
  const same = a.replace(/"ip":"[^"]*"/, "") === b.replace(/"ip":"[^"]*"/, "");
  show(
    `${init?.method ?? "GET"} ${path}`,
    same
      ? `identical — ${b}`
      : `DIFFERENT\n    socket:  ${a}\n    offline: ${b}`,
  );
}

/* ------------------------------------------------------------------ */
step("adapter.fetch() on a listening adapter");

const live = await served.fetch("/users/7");
show("uses the live server's origin and server", await describe(live));

await served.close();
show("closed", !served.isListening);
