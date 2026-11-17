/**
 * bun-security on bun-common's `BunHttpAdapter`: `installSecurity` puts the
 * engine in the adapter's three stages, and the boot self-test proves it is
 * in the pipeline.
 *
 * ```bash
 * bun 01-serve/install-security.ts
 * ```
 *
 * - Install first, before any route or middleware: the route stage is a
 *   middleware and runs in registration order.
 * - **Early stage** (before the body is read): address lists and bans, the
 *   request's shape, honeypots, address-keyed limits. **Route stage**:
 *   `identify(req)`, user and API-key entries, route-keyed limits, CSRF.
 *   **Response stage**: the security headers, stack-trace scrubbing, and the
 *   outcome (route-not-found marked) reported to the engine.
 * - The adapter's socket-free `fetch()` runs the production pipeline with no
 *   port; `remoteAddress` names the peer.
 */
import { BunHttpAdapter, ConfigError } from "@kingsleyweb/bun-common";
import type { BunRequest } from "@kingsleyweb/bun-common";
import { createSecurity } from "@kingsleyweb/bun-security";
import {
  installSecurity,
  requestSecurity,
  securityProfile,
} from "@kingsleyweb/bun-security/http";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("installSecurity on a BunHttpAdapter");

const security = createSecurity<BunRequest>({
  policy: {
    lists: [
      { ip: "203.0.113.0/24", action: "block" },
      { user: "u_mallory", action: "block" },
    ],
    limits: [{ id: "per-user", limit: 3, window: "1m", key: "user" }],
  },
  identify: (req) => ({ user: req.get("x-user-id") ?? undefined }),
  logger: () => {},
});

const app = new BunHttpAdapter(0, { logger: () => {} });
const installation = await installSecurity(app, security, { logger: () => {} });
show("boot self-test", installation.selfTest);
checkEqual(
  "the self-test saw all three stages",
  installation.selfTest.ran,
  true,
);

app.get("/me", (_req, res) => res.json({ ok: true }));
app.post("/login", securityProfile("login"), (req, res) =>
  res.json({ profile: requestSecurity(req)?.profile ?? null }),
);

/* ------------------------------------------------------------------ */
step("an ordinary request, with the security headers on its answer");
const ok = await app.fetch("/me", { remoteAddress: "198.51.100.10" });
show("headers", Object.fromEntries(ok.headers));
checkEqual("200", ok.status, 200);
checkEqual("nosniff", ok.headers.get("x-content-type-options"), "nosniff");
checkEqual(
  "frame-ancestors",
  ok.headers.get("content-security-policy"),
  "frame-ancestors 'none'",
);

/* ------------------------------------------------------------------ */
step("the early stage refuses a listed address; the route stage a listed user");
const early = await app.fetch("/me", { remoteAddress: "203.0.113.5" });
await early.body?.cancel();
checkEqual("203.0.113.5 refused", early.status, 403);
const user = await app.fetch("/me", {
  remoteAddress: "198.51.100.10",
  headers: { "x-user-id": "u_mallory" },
});
await user.body?.cancel();
checkEqual("u_mallory refused", user.status, 403);

/* ------------------------------------------------------------------ */
step("a route-keyed limit from identify(): 3 a minute per user");
const statuses: number[] = [];
for (let i = 0; i < 4; i++) {
  const response = await app.fetch("/me", {
    remoteAddress: "198.51.100.10",
    headers: { "x-user-id": "u_ada" },
  });
  await response.body?.cancel();
  statuses.push(response.status);
}
show("u_ada", statuses);
checkEqual("the fourth is 429", statuses, [200, 200, 200, 429]);

/* ------------------------------------------------------------------ */
step("a route's profile, read by the app");
const me = await app.fetch("/login", {
  method: "POST",
  remoteAddress: "198.51.100.12",
  headers: { "content-type": "application/json" },
  body: "{}",
});
checkEqual("POST /login answers", me.status, 200);
checkEqual("its profile", await me.json(), { profile: "login" });

/* ------------------------------------------------------------------ */
step("the self-test fails an install that is not in the pipeline");
const bypassed = new BunHttpAdapter(0, { logger: () => {} });
// A catch-all ahead of the install: the engine would never see a request.
bypassed.use((_req, res) => res.send("everything"));
await checkRejects(
  "installSecurity rejects",
  () => installSecurity(bypassed, security, { logger: () => {} }),
  { name: ConfigError.name, message: /self-test|did not see/ },
);

/* ------------------------------------------------------------------ */
step("remove() takes the engine back off");
installation.remove();
const after = await app.fetch("/me", { remoteAddress: "203.0.113.5" });
await after.body?.cancel();
check(
  "the listed address now reaches the app",
  after.status === 200,
  after.status,
);

security.close();
summary();
