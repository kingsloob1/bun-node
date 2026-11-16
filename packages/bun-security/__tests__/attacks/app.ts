/**
 * The app the attack simulations run against: ConcaveHR's request path as
 * plan §12 maps it, on bun-common's `BunHttpAdapter` with `installSecurity`
 * (the same engine bun-nest's adapter runs). Its policy is the realistic
 * one the plan describes: the shipped presets (`not_found_per_minute`
 * enforced, as ConcaveHR enforced it), the login profile's defaults, the
 * managed probe set enforced, honeypots, the crawler allowance, the
 * disposable-address patterns and ConcaveHR's counted rules, a Tor rule,
 * and API-key watching. Everything runs on a fake clock the runner moves.
 *
 * `defences: false` builds the same app with no engine at all: the
 * negative control every simulation runs, where the attack succeeds.
 */
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import { createSecurity, SecurityRefusal } from "../../lib/index";
import type {
  CreateSecurityOptions,
  Decision,
  RequestFacts,
  Security,
  SecurityPolicy,
  SecurityWarning,
} from "../../lib/index";
import {
  installSecurity,
  requestSecurity,
  securityProfile,
  uniformAuthResponse,
} from "../../lib/http/index";
import { ipIntel } from "../../lib/intel/index";
import {
  fetchTarget,
  runAttack,
  staticCrawlerResolver,
} from "../../lib/testing/index";
import type {
  Attack,
  AttackResult,
  AttackTarget,
  RunAttackOptions,
} from "../../lib/testing/index";
import { fakeClock } from "../helpers";
import type { FakeClock } from "../helpers";

/** The secret the app keys usernames, destinations and API keys with. */
export const APP_SECRET = "concave-attack-tests-secret-of-32-bytes-or-more";

/** Google's crawler range, as the fixture intel knows it (a fixture: no feed is fetched). */
export const GOOGLE_RANGE = "66.249.64.0/19";

/** An address inside {@link GOOGLE_RANGE}. */
export const GOOGLEBOT_ADDRESS = "66.249.66.1";

/** The Tor exits the fixture intel knows (a documentation range standing in for the exit list). */
export const TOR_RANGE = "192.0.2.0/24";

/** The accounts the app knows, by username, with their passwords. */
export const ACCOUNTS: ReadonlyMap<string, string> = new Map([
  ["alice@concave.example.org", "correct horse battery staple"],
  ["bob@concave.example.org", "hunter2-but-longer"],
  ["hank@concave.example.org", "a long passphrase of hank's"],
]);

/** Each account's second factor (a TOTP code, fixed for the test), which the attacker never has. */
export const SECOND_FACTORS: ReadonlyMap<string, string> = new Map([
  ["alice@concave.example.org", "246810"],
  ["bob@concave.example.org", "135791"],
  ["hank@concave.example.org", "112358"],
]);

/** The API keys the app has issued, by key, with their plans. */
export const API_KEYS: ReadonlyMap<string, string> = new Map([
  ["key_partner_live", "partner"],
  ["key_leaked_live", "partner"],
  // Never handed to anyone: planted in a backup as a canary (layers.md L8).
  ["key_canary_backup", "canary"],
]);

/** The disposable-address domains the app refuses (ConcaveHR's `EmailPatternGuard`). */
export const DISPOSABLE_DOMAINS: readonly string[] = [
  "mailinator.example",
  "tempmail.example",
  "10minutemail.example",
];

/**
 * The realistic policy (plan §12.2): the presets, the login profile's
 * defaults with a short delay (the delay's length is not under test, and
 * the fake clock cannot shorten a real wait), the managed probe set
 * enforced, ConcaveHR's counted rules, a Tor rule, honeypots, the crawler
 * allowance, identifier patterns and API-key watching.
 */
export const CONCAVE_POLICY: SecurityPolicy = {
  presets: { not_found_per_minute: "enforce" },
  profiles: { login: { failures: { maxDelay: "5ms" } } },
  requestRules: {
    managed: { mode: "enforce" },
    rules: [
      {
        id: "tor_exit_nodes",
        when: { class: { equals: "tor" } },
        action: "block",
      },
    ],
  },
  deception: {
    honeypots: true,
    canaries: [{ id: "backup-key", apiKey: "key_canary_backup" }],
  },
  crawlers: {},
  identifiers: {
    patterns: DISPOSABLE_DOMAINS.map((domain) => ({
      id: `disposable:${domain}`,
      kind: "email" as const,
      pattern: `*@${domain}`,
    })),
  },
  countedRules: [
    {
      // ConcaveHR's: a refused identifier on an auth route, scoped to
      // those routes as ConcaveHR's was. Only `security.check()` counts
      // `pattern.hit`; a request rule's hit counts `rule.hit` (plan §17.19).
      id: "disposable_signup",
      event: "pattern.hit",
      threshold: 1,
      window: "60s",
      duration: "7d",
      routes: ["POST /auth/*"],
    },
    {
      id: "password_resets_per_ip",
      event: "password.reset",
      threshold: 10,
      window: "1h",
      duration: "1d",
    },
    {
      id: "requests_per_second",
      event: "request",
      threshold: 100,
      window: "1s",
      duration: "15m",
    },
  ],
  apiKeys: {
    manyAddresses: { limit: 20, window: "1h", action: "ban", duration: "2h" },
  },
};

/** Options for {@link concaveApp}. */
export interface ConcaveAppOptions {
  /** `false` builds the app with no engine (the negative control). Default `true`. */
  readonly defences?: boolean;
  /** Replaces sections of {@link CONCAVE_POLICY} (shallow). */
  readonly policy?: SecurityPolicy;
  /** The sign-in route's `uniformAuthResponse` minimum, ms. Default `1` (the bulk runs; T-L11-2 sets its own). */
  readonly minResponseMs?: number;
  /** The fake clock the engine runs on. Default a new one. */
  readonly clock?: FakeClock;
  /** More `createSecurity` options (`maxKeys`, …). */
  readonly engine?: Partial<CreateSecurityOptions<BunRequest>>;
}

/** The app, its engine and what it recorded. */
export interface ConcaveApp {
  /** The adapter, with the engine installed (unless `defences: false`). */
  readonly adapter: BunHttpAdapter;
  /** The engine; `undefined` with `defences: false`. */
  readonly security: Security<BunRequest> | undefined;
  /** The fake clock the engine runs on. */
  readonly clock: FakeClock;
  /** Every decision the engine made, with its request's facts. */
  readonly decisions: { decision: Decision; facts: RequestFacts }[];
  /** Every warning it raised. */
  readonly warnings: SecurityWarning[];
  /** Accounts created through `/auth/signup`. */
  readonly signups: string[];
  /** A target over the adapter's socket-free `fetch()`. */
  readonly target: AttackTarget;
  /** Runs `attack` against the app, moving its clock. */
  readonly run: (
    attack: Attack,
    options?: RunAttackOptions,
  ) => Promise<AttackResult>;
  /** The ids of the rules that hit, with their actions (`login:distinct-usernames:challenge`), in order, each once. */
  readonly fired: () => string[];
}

/** Builds the app. */
export async function concaveApp(
  options: ConcaveAppOptions = {},
): Promise<ConcaveApp> {
  const clock = options.clock ?? fakeClock();
  const decisions: { decision: Decision; facts: RequestFacts }[] = [];
  const warnings: SecurityWarning[] = [];
  const signups: string[] = [];
  const adapter = new BunHttpAdapter(0, { logger: () => {} });
  let security: Security<BunRequest> | undefined;
  if (options.defences !== false) {
    security = createSecurity<BunRequest>({
      policy: { ...CONCAVE_POLICY, ...options.policy },
      secret: APP_SECRET,
      now: clock.now,
      logger: () => {},
      intel: await ipIntel({
        ranges: { tor: [TOR_RANGE], "crawler:google": [GOOGLE_RANGE] },
        now: clock.now,
        logger: () => {},
      }),
      resolver: staticCrawlerResolver(),
      identify: (req) => {
        const body = req.body as { username?: unknown } | undefined;
        const apiKey = req.request.headers.get("x-api-key") ?? undefined;
        return {
          ...(typeof body?.username === "string"
            ? { username: body.username }
            : {}),
          ...(apiKey !== undefined && API_KEYS.has(apiKey)
            ? { apiKey, apiKeyPlan: API_KEYS.get(apiKey) }
            : {}),
        };
      },
      onDecision: (decision, facts) => decisions.push({ decision, facts }),
      onWarning: (warning) => warnings.push(warning),
      ...options.engine,
    });
    await installSecurity(adapter, security, { logger: () => {} });
  }
  const engine = security;

  /** Answers a `security.check()` refusal as ConcaveHR's guard does: generically. */
  const refuse = (res: BunResponse, refusal: SecurityRefusal) =>
    res
      .status(refusal.status)
      .set("content-type", "application/problem+json")
      .send(
        JSON.stringify({
          title: refusal.message,
          status: refusal.status,
          code: refusal.code,
        }),
      );

  adapter.get("/", (_req, res) => res.send("home"));
  adapter.get("/pricing", (_req, res) => res.send("pricing"));
  adapter.get("/careers/:slug", (req, res) =>
    res.send(`job ${req.params.slug}`),
  );
  adapter.post(
    "/auth/login",
    securityProfile("login"),
    // Part of the defence: the negative control answers as the app would alone.
    options.defences === false
      ? (_req, _res, next) => next()
      : uniformAuthResponse({ minResponseMs: options.minResponseMs ?? 1 }),
    (req, res) => {
      const { username, password, secondFactor } = req.body as {
        username?: string;
        password?: string;
        secondFactor?: string;
      };
      const known = username === undefined ? undefined : ACCOUNTS.get(username);
      if (known === undefined)
        return res.status(404).json({ error: "no such user" });
      if (known !== password)
        return res.status(401).json({ error: "wrong password" });
      // The engine's step-up tag (one account failing from many addresses,
      // layers.md L11): the right password is not enough without the
      // account's second factor.
      if (
        requestSecurity(req)?.decision?.tags.includes("step-up") === true &&
        secondFactor !== SECOND_FACTORS.get(username!)
      )
        return res.status(401).json({ error: "second factor required" });
      return res.json({ ok: true });
    },
  );
  adapter.post("/auth/signup", securityProfile("signup"), async (req, res) => {
    const { email } = req.body as { email?: string };
    if (typeof email !== "string")
      return res.status(422).json({ error: "email required" });
    const facts =
      engine === undefined ? undefined : requestSecurity(req)?.facts;
    try {
      await engine?.check(facts, "email", email);
    } catch (error) {
      if (error instanceof SecurityRefusal) return refuse(res, error);
      throw error;
    }
    signups.push(email);
    if (engine !== undefined && facts !== undefined)
      await engine.signal(facts, "signup");
    return res.status(201).json({ ok: true });
  });
  adapter.get("/api/v1/employees", (req, res) => {
    const key = req.request.headers.get("x-api-key");
    if (key === null || !API_KEYS.has(key))
      return res.status(401).json({ error: "unknown key" });
    return res.json({ employees: [] });
  });
  adapter.post("/payroll/transfer", (_req, res) => res.json({ ok: true }));

  const target = fetchTarget(adapter);
  return {
    adapter,
    security,
    clock,
    decisions,
    warnings,
    signups,
    target,
    run: (attack, runOptions = {}) =>
      runAttack(attack, target, { advance: clock.advance, ...runOptions }),
    fired: () => {
      const seen = new Set<string>();
      for (const { decision } of decisions) {
        for (const hit of decision.hits) seen.add(`${hit.rule}:${hit.action}`);
      }
      return [...seen];
    },
  };
}
