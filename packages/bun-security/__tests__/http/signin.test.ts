/**
 * `installSecurity` on a real sign-in route (layers.md L11): a route marked
 * `securityProfile("login")` and `uniformAuthResponse()`, the attempted
 * username from `identify()` (the parsed body), the outcome inferred from
 * the answer. T-L11-2: a missing account and a wrong password answer the
 * same status and body, no sooner than the minimum time; the progressive
 * delay; the device cookie set on a success, which keeps the owner in
 * through a soft lock (T-L11-3); and the `login.*` presets on the route.
 */
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import type { BunRequest } from "@kingsleyweb/bun-common";
import { createSecurity } from "../../lib/index";
import type { SecurityPolicy } from "../../lib/index";
import {
  installSecurity,
  securityProfile,
  uniformAuthResponse,
} from "../../lib/http/index";
import { SECRET } from "../sensitive/helpers";

/** The accounts the app knows. */
const ACCOUNTS = new Map([["alice@example.org", "correct horse"]]);

/** An app with a sign-in route, the engine installed. */
async function app(policy: SecurityPolicy = {}, minResponseMs = 150) {
  const security = createSecurity<BunRequest>({
    policy,
    secret: SECRET,
    logger: () => {},
    identify: (req) => {
      const body = req.body as { username?: unknown } | undefined;
      return typeof body?.username === "string"
        ? { username: body.username }
        : undefined;
    },
  });
  const adapter = new BunHttpAdapter(0, { logger: () => {} });
  await installSecurity(adapter, security, { logger: () => {} });
  adapter.post(
    "/login",
    securityProfile("login"),
    uniformAuthResponse({ minResponseMs }),
    (req, res) => {
      const { username, password } = req.body as {
        username: string;
        password: string;
      };
      const known = ACCOUNTS.get(username);
      if (known === undefined)
        return res.status(404).json({ error: "no such user" });
      if (known !== password)
        return res.status(401).json({ error: "wrong password" });
      return res.json({ ok: true });
    },
  );
  return { adapter, security };
}

/** Posts a sign-in, timed. */
async function signIn(
  adapter: BunHttpAdapter,
  username: string,
  password: string,
  client = "203.0.113.20",
  cookie?: string,
) {
  const started = performance.now();
  const response = await adapter.fetch("/login", {
    method: "POST",
    remoteAddress: client,
    headers: {
      "content-type": "application/json",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify({ username, password }),
  });
  const body = await response.text();
  return {
    status: response.status,
    body,
    ms: performance.now() - started,
    setCookie: response.headers.get("set-cookie"),
  };
}

describe("a sign-in route under installSecurity", () => {
  it("T-L11-2: a missing account and a wrong password answer the same, no sooner than the minimum time", async () => {
    const { adapter } = await app();
    const missing = await signIn(adapter, "nobody@example.org", "x");
    const wrong = await signIn(adapter, "alice@example.org", "x");
    expect([missing.status, wrong.status]).toEqual([401, 401]);
    expect(missing.body).toBe(wrong.body);
    expect(JSON.parse(missing.body)).toEqual({
      type: "about:blank",
      title: "Login failed",
      status: 401,
      code: "login_failed",
    });
    for (const attempt of [missing, wrong])
      expect(attempt.ms).toBeGreaterThanOrEqual(145);
    const ok = await signIn(adapter, "alice@example.org", "correct horse");
    expect(ok.status).toBe(200);
    expect(ok.ms).toBeGreaterThanOrEqual(145);
    // Negative control: without the marker the app's own answers differ.
    const plain = new BunHttpAdapter(0, { logger: () => {} });
    await installSecurity(
      plain,
      createSecurity<BunRequest>({
        policy: {},
        secret: SECRET,
        logger: () => {},
      }),
      {
        logger: () => {},
      },
    );
    plain.post("/login", securityProfile("login"), (_req, res) =>
      res.status(404).json({ error: "no such user" }),
    );
    const raw = await signIn(plain, "nobody@example.org", "x");
    expect(raw.status).toBe(404);
  });

  it("infers failures from the answers, delays the next attempts, and issues a device cookie on a success", async () => {
    const { adapter } = await app(
      {
        profiles: {
          login: {
            failures: { delayAfter: 2, challengeAfter: 50, lockAfter: 60 },
          },
        },
      },
      0,
    );
    await signIn(adapter, "alice@example.org", "x");
    await signIn(adapter, "alice@example.org", "y");
    const delayed = await signIn(adapter, "alice@example.org", "z");
    expect(delayed.ms).toBeGreaterThanOrEqual(950);
    const ok = await signIn(adapter, "alice@example.org", "correct horse");
    expect(ok.status).toBe(200);
    expect(ok.setCookie).toStartWith("__Host-bun-security-device=");
    expect(ok.setCookie).toContain("HttpOnly");
    // The success cleared the count: no delay now.
    const after = await signIn(adapter, "alice@example.org", "x");
    expect(after.ms).toBeLessThan(900);
    expect(after.setCookie).toBeNull();
  });

  it("T-L11-3: an attacker locks the username out; the owner's device cookie still signs in", async () => {
    const { adapter } = await app(
      {
        profiles: {
          login: {
            failures: { delayAfter: 3, challengeAfter: 3, lockAfter: 3 },
          },
        },
        presets: { "login.account": false, "login.ip": false },
      },
      0,
    );
    const first = await signIn(
      adapter,
      "alice@example.org",
      "correct horse",
      "198.51.100.5",
    );
    const cookie = (first.setCookie ?? "").split(";")[0] ?? "";
    for (let i = 0; i < 3; i++) {
      await signIn(
        adapter,
        "alice@example.org",
        "guess",
        `203.0.113.${30 + i}`,
      );
    }
    const attacker = await signIn(
      adapter,
      "alice@example.org",
      "correct horse",
      "203.0.113.40",
    );
    expect(attacker.status).toBe(429);
    const owner = await signIn(
      adapter,
      "alice@example.org",
      "correct horse",
      "198.51.100.5",
      cookie,
    );
    expect(owner.status).toBe(200);
  });

  it("applies the login.* presets on the marked route: 10 a minute per address and username", async () => {
    const { adapter } = await app({ profiles: { login: false } }, 0);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await signIn(adapter, "alice@example.org", "x")).status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
