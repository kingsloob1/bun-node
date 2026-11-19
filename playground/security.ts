/**
 * The security demo (PR-X2, bun-security plan §11.6): a real control plane
 * (`createSecurityApi`) and the security UI (`securityUi`) on the
 * playground's adapter, a few demo services whose engines run behind
 * agents, and an attacker loop that keeps every screen moving.
 *
 * - **The control plane** at `/security-api`, on an in-memory store, with
 *   agents, alerts (an email channel whose messages this demo keeps, shown
 *   at `/playground/security`) and two-person approvals. Two operators:
 *   `playground` (the browser, every request) and `reviewer` (the seed's
 *   second pair of eyes, named by the `x-demo-operator` header).
 * - **The UI** at `/security`, built from the source (`dev: true`), in the
 *   playground's theme and layout.
 * - **The services**: `shop` (two instances, two agents) and `accounts` in
 *   group `storefront`, and `partner-api` on its own; each instance is an
 *   engine behind `installSecurity` on an adapter of its own that never
 *   listens (the loop calls its `fetch()`), connected to the control plane
 *   by `connectAgent` over the playground adapter's `fetch()` (no network),
 *   its decisions counted and sampled into events the agent posts.
 * - **The seed**: policies at every scope (the managed probe set, the
 *   honeypots, a canary, a counted rule and the ladder, lists by address,
 *   range and country, a dry-run rule, limits per address and per API key,
 *   the sign-in profile), published through the approvals they need; alert
 *   rules; and one dangerous change left waiting for approval.
 * - **The attacker loop** (`PLAYGROUND_SECURITY_INTERVAL_MS`, default
 *   1000; `0` seeds only): normal users every tick, and on their own
 *   cadences a path scan (probes and honeypots), a credential-stuffing
 *   burst, a canary sign-in, a spoofed and a verified crawler, a rotating
 *   IPv6 attacker, list hits, a dry-run rule's would-blocks and an API key's
 *   abuse. The counted rule and the ladder turn the scans into bans the
 *   agents report, and the alert rules fire on them.
 *
 * Everything is allowed to anyone who can reach the playground: never
 * expose it (it listens on 127.0.0.1 only).
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import type { BunRequest, LoggerLike } from "@kingsleyweb/bun-common";
import { createSecurity } from "@kingsleyweb/bun-security";
import type { Security, SecurityPolicy } from "@kingsleyweb/bun-security";
import type { IntelLookup, IntelRecord } from "@kingsleyweb/bun-security/intel";
import { connectAgent } from "@kingsleyweb/bun-security/agent";
import type { SecurityAgent } from "@kingsleyweb/bun-security/agent";
import {
  analyticsHook,
  analyticsSignalHook,
  createAnalyticsRecorder,
  createEventRing,
  createRedactor,
} from "@kingsleyweb/bun-security/analytics";
import { createSecurityApi } from "@kingsleyweb/bun-security/control";
import type { SecurityApi } from "@kingsleyweb/bun-security/control";
import {
  installSecurity,
  securityProfile,
  uniformAuthResponse,
} from "@kingsleyweb/bun-security/http";
import { memoryStore } from "@kingsleyweb/bun-security/store";
import {
  apiKeyAbuse,
  credentialStuffing,
  crawl,
  fetchTarget,
  ipv6Rotation,
  pathScan,
  runAttack,
  spoofedCrawler,
  staticCrawlerResolver,
} from "@kingsleyweb/bun-security/testing";
import type { Attack } from "@kingsleyweb/bun-security/testing";
import { securityUi } from "@kingsleyweb/bun-ui/security";
import type {
  SecurityUi,
  SecurityUiOptions,
} from "@kingsleyweb/bun-ui/security";

/** Where the control plane is mounted. */
export const SECURITY_API_BASE = "/security-api";

/** Where the security UI is mounted. */
export const SECURITY_UI_BASE = "/security";

/** The demo's own page: the loop's figures and the alert emails. */
export const SECURITY_DEMO_BASE = "/playground/security";

/** The header naming a demo operator other than the browser's. */
const OPERATOR_HEADER = "x-demo-operator";

/** The fleet's keying secret: the engines' `secret` and the control plane's `bans.secret`. */
const FLEET_SECRET = "playground-security-demo-fleet-secret-0123456789";

/**
 * Who sends what, by address, so one kind's bans never stop another's:
 * normal users 192.0.2.20–219, the office 192.0.2.10 (an allow entry), the
 * partner 192.0.2.240; spoofed crawlers 203.0.113.10–59, path scans .60–109,
 * credential stuffing .110–169, canary sign-ins .170–189, the blocked range
 * .192/26; the blocked country's addresses 198.51.100.0/24; Googlebot
 * 66.249.66.1; the rotating IPv6 attacker a new /64 under 2001:db8::/32 each
 * run.
 */
/** The demo services, their groups, and how many instances (each with an agent) each runs. */
const SERVICES = [
  { id: "shop", name: "Shop", groups: ["storefront"], instances: 2 },
  { id: "accounts", name: "Accounts", groups: ["storefront"], instances: 1 },
  { id: "partner-api", name: "Partner API", groups: [], instances: 1 },
] as const;

/** A demo service's id. */
type ServiceId = (typeof SERVICES)[number]["id"];

/** What the loop sends, by kind. */
export const LOOP_KINDS = [
  "normal",
  "path-scan",
  "credential-stuffing",
  "canary",
  "spoofed-crawler",
  "verified-crawler",
  "ipv6-rotation",
  "list-hits",
  "dry-run",
  "api-key-abuse",
] as const;

/** A kind of traffic the loop sends. */
export type LoopKind = (typeof LOOP_KINDS)[number];

/** What one kind of traffic did so far. */
export interface KindFigures {
  /** How many times it ran. */
  runs: number;
  /** Requests it sent. */
  requests: number;
  /** Requests refused (a 403, 429 or a dropped connection). */
  refused: number;
}

/** An alert email the control plane sent (kept, newest first, at most 50). */
export interface DemoEmail {
  /** When, epoch ms. */
  readonly at: number;
  /** Its subject. */
  readonly subject: string;
  /** Its text. */
  readonly text: string;
}

/** Options of {@link mountSecurityDemo}. */
export interface SecurityDemoOptions {
  /** The loop's tick, ms; `0` seeds and sends nothing. Default 1000. */
  readonly intervalMs?: number;
  /** Where the agents keep their state and artefacts; removed on stop. */
  readonly dataDir: string;
  /** The UI's theme and layout, as the playground's other UIs take them. */
  readonly theme?: SecurityUiOptions["theme"];
  /** The UI's layout. */
  readonly layout?: SecurityUiOptions["layout"];
  /** The UI's logger. Default silent. */
  readonly logger?: LoggerLike;
}

/** The mounted demo. */
export interface SecurityDemo {
  /** The control plane. */
  readonly api: SecurityApi;
  /** The UI's base path. */
  readonly uiBase: string;
  /** The UI's server: what the host-shell demo (`embed.ts`) mounts from. */
  readonly ui: SecurityUi;
  /** Each kind of traffic's figures. */
  readonly figures: () => Readonly<Record<LoopKind, KindFigures>>;
  /** The alert emails kept. */
  readonly emails: () => readonly DemoEmail[];
  /** Runs one tick of the loop now (whatever the interval). */
  readonly tick: () => Promise<void>;
  /** Starts the loop's timer (no-op at interval 0). */
  readonly start: () => void;
  /** Stops the loop, the agents, the engines and the control plane, and removes the data. */
  readonly stop: () => Promise<void>;
}

/** An intel lookup that also reports its feeds, as `ipIntel()`'s does (the engine reads it structurally). */
type ReportingIntel = IntelLookup & {
  /** Its feeds' state, for the heartbeat's IP-intel sources. */
  readonly status: () => {
    readonly databases: readonly never[];
    readonly classes: Readonly<Record<string, number>>;
    readonly cached: number;
    readonly feeds: readonly {
      readonly id: string;
      readonly class: string;
      readonly entries: number;
      readonly source: "disk";
      readonly updatedAt: number;
      readonly attemptedAt: number;
      readonly error: undefined;
      readonly dueAt: number;
    }[];
  };
};

/** An address's intel: Google's crawl range, a country to block, the rest elsewhere. */
function demoIntel(): ReportingIntel {
  const loadedAt = Date.now();
  const record = (text: string): IntelRecord => {
    if (text.startsWith("66.249."))
      return { country: "US", asn: 15169, classes: ["crawler:google"] };
    if (text.startsWith("198.51.100."))
      return { country: "KP", asn: 64500, classes: [] };
    if (text.startsWith("2001:db8:"))
      return { country: "NL", asn: 64501, classes: ["hosting"] };
    return { country: "GB", asn: 64496, classes: [] };
  };
  const intel: ReportingIntel = {
    lookup: (address) =>
      record(typeof address === "string" ? address : address.text),
    provides: () => ({
      country: true,
      asn: true,
      classes: new Set(["crawler:google", "hosting"]),
    }),
    ranges: (name) => (name === "crawler:google" ? ["66.249.64.0/19"] : []),
    // What the IP-intel sources panel shows: the demo's one feed, as a
    // loaded range file would report it.
    status: () => ({
      databases: [],
      classes: { "crawler:google": 1, hosting: 1 },
      cached: 0,
      feeds: [
        {
          id: "crawler:google",
          class: "crawler:google",
          entries: 1,
          source: "disk",
          updatedAt: loadedAt,
          attemptedAt: loadedAt,
          error: undefined,
          dueAt: loadedAt + 86_400_000,
        },
      ],
    }),
  };
  return intel;
}

/** The global policy the seed publishes. */
const GLOBAL_POLICY: SecurityPolicy = {
  presets: { not_found_per_minute: "enforce" },
  requestRules: {
    managed: { mode: "enforce" },
    rules: [
      {
        id: "admin-paths",
        when: { path: { prefix: "/admin" } },
        action: "block",
        mode: "dryRun",
      },
    ],
  },
  deception: {
    honeypots: true,
    canaries: [{ id: "backup-admin", user: "backup-admin" }],
  },
  countedRules: [
    {
      id: "probe-scan",
      event: "probe.hit",
      threshold: 3,
      window: "1m",
      action: "ladder",
    },
  ],
  ladder: {
    halfLife: "10m",
    steps: [
      { score: 4, action: "challenge" },
      { score: 8, action: "ban", duration: "10m" },
    ],
    base: "5m",
    factor: 2,
    maxBan: "1h",
  },
  lists: [
    { ip: "192.0.2.10", action: "allow", override: true, reason: "the office" },
    { ip: "203.0.113.192/26", action: "block", reason: "a known botnet range" },
    { country: "KP", action: "block", reason: "not served" },
    {
      ip: "66.249.70.0/24",
      action: "block",
      reason:
        "an old scraper range (it covers Googlebot's: a crawler conflict)",
    },
  ],
};

/** Each scope's policy after global's. */
const SCOPE_POLICIES: readonly (readonly [string, SecurityPolicy])[] = [
  [
    "group:storefront",
    { limits: [{ id: "per-address", limit: 120, window: "1m", key: "ip" }] },
  ],
  [
    "service:accounts",
    {
      limits: [
        {
          id: "sign-in",
          limit: 30,
          window: "1m",
          key: "ip",
          routes: ["POST /login"],
        },
      ],
    },
  ],
  [
    "service:partner-api",
    {
      limits: [
        {
          id: "per-key",
          limit: 60,
          window: "1m",
          key: "apiKey",
          routes: ["/api/*"],
        },
      ],
      apiKeys: { manyAddresses: { limit: 5, window: "10m", mode: "dryRun" } },
    },
  ],
];

/** One answer of the control plane, read. */
interface Answer {
  /** The status. */
  readonly status: number;
  /** The JSON body. */
  readonly body: Record<string, unknown>;
}

/** One running instance of a demo service. */
interface Instance {
  /** Its service. */
  readonly service: ServiceId;
  /** Its engine. */
  readonly security: Security<BunRequest>;
  /** Its app, never listening. */
  readonly app: BunHttpAdapter;
  /** Its agent. */
  readonly agent: SecurityAgent;
}

/** A demo service's app: its pages, its sign-in and its API, behind its engine. */
async function serviceApp(
  security: Security<BunRequest>,
): Promise<BunHttpAdapter> {
  const app = new BunHttpAdapter(0, { logger: () => {} });
  await installSecurity(app, security, { logger: () => {} });
  for (const path of [
    "/",
    "/pricing",
    "/products",
    "/products/:id",
    "/robots.txt",
  ])
    app.get(path, (_req, res) => res.send("ok"));
  // A staff page: the dry-run rule would block it (and records that it would).
  app.get("/admin/*", (_req, res) => res.send("the staff pages"));
  app.post(
    "/login",
    securityProfile("login"),
    uniformAuthResponse({ minResponseMs: 1 }),
    (req, res) => {
      const body = req.body as { password?: unknown } | undefined;
      return body?.password === "correct horse"
        ? res.json({ ok: true })
        : res.status(401).json({ error: "wrong password" });
    },
  );
  app.get("/api/orders", (req, res) =>
    req.get("x-api-key") === undefined
      ? res.status(401).json({ error: "an API key is needed" })
      : res.json({ orders: [] }),
  );
  return app;
}

/** See the module's description. */
export async function mountSecurityDemo(
  app: BunHttpAdapter,
  options: SecurityDemoOptions,
): Promise<SecurityDemo> {
  const intervalMs = options.intervalMs ?? 1000;
  mkdirSync(options.dataDir, { recursive: true });
  const bundleKey = generateKeyPairSync("ed25519");
  const auditKey = generateKeyPairSync("ed25519");
  const emails: DemoEmail[] = [];
  const api = createSecurityApi({
    store: memoryStore(),
    authenticate: (req) => {
      const id = req.request.headers.get(OPERATOR_HEADER) ?? "playground";
      return { id, name: id === "playground" ? "Playground" : "Reviewer" };
    },
    owners: ["playground", "reviewer"],
    // Every operator here is always freshly stepped up: the playground allows everything.
    stepUp: { verify: () => true, challenge: () => SECURITY_DEMO_BASE },
    approvals: "two-person",
    signing: { keyId: "sk_demo", privateKey: bundleKey.privateKey },
    audit: {
      signing: { keyId: "ak_demo", privateKey: auditKey.privateKey },
      allowNoExternalCheckpoints: true,
    },
    bans: { secret: FLEET_SECRET },
    agents: {
      allowEphemeralStore: true,
      heartbeatInterval: "10s",
      artefacts: { dir: join(options.dataDir, "artefacts") },
    },
    alerts: {
      evaluateIntervalMs: 15_000,
      email: (message) => {
        emails.unshift({
          at: Date.now(),
          subject: message.subject,
          text: message.text,
        });
        emails.length = Math.min(emails.length, 50);
        return Promise.resolve();
      },
    },
    basePath: SECURITY_API_BASE,
    docs: { title: "Playground security API" },
    logger: noopLogger,
  });
  app.use(api.basePath, api.router);
  const ui = securityUi({
    api,
    basePath: SECURITY_UI_BASE,
    title: "bun-node playground: security",
    dev: true,
    logger: options.logger ?? noopLogger,
    ...(options.theme === undefined ? {} : { theme: options.theme }),
    ...(options.layout === undefined ? {} : { layout: options.layout }),
  });
  app.use(ui.basePath, ui.router);

  /** A call to the control plane through the adapter's `fetch()`, as `operator`. */
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    operator = "playground",
  ): Promise<Answer> => {
    const response = await app.fetch(`${api.basePath}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-bun-security-csrf": "1",
        [OPERATOR_HEADER]: operator,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
    };
  };
  /** Fails the seed on an answer it did not expect. */
  const expect = (
    answer: Answer,
    statuses: readonly number[],
    what: string,
  ) => {
    if (!statuses.includes(answer.status))
      throw new Error(
        `the security demo's seed: ${what} answered ${answer.status} ${JSON.stringify(answer.body)}`,
      );
    return answer;
  };
  /** Saves and publishes `policy` at `scope`; a change approvals hold is approved by the reviewer. */
  const publish = async (scope: string, policy: SecurityPolicy) => {
    const read = (await call("GET", `/policies/${scope}`)).body as {
      draft: { revision: number } | null;
      head: { id: string } | null;
    };
    expect(
      await call("PUT", `/policies/${scope}/draft`, {
        policy,
        revision: read.draft?.revision ?? null,
      }),
      [200],
      `the ${scope} draft`,
    );
    const published = expect(
      await call("POST", `/policies/${scope}/publish`, {
        expectedHead: read.head?.id ?? null,
        message: "the playground's seed",
      }),
      [200, 202],
      `the ${scope} publish`,
    );
    if (published.status === 202) {
      const approval = published.body as { id: string; revision: number };
      expect(
        await call(
          "POST",
          `/approvals/${approval.id}/approve`,
          { revision: approval.revision, reason: "the playground's seed" },
          "reviewer",
        ),
        [200],
        `the ${scope} approval`,
      );
    }
  };

  // ── The seed ────────────────────────────────────────────────────────────
  expect(
    await call("POST", "/groups", { id: "storefront", name: "Storefront" }),
    [201],
    "the storefront group",
  );
  for (const service of SERVICES) {
    expect(
      await call("POST", "/services", {
        id: service.id,
        name: service.name,
        groups: [...service.groups],
        environment: "production",
        topology: "c",
      }),
      [201],
      `service ${service.id}`,
    );
  }
  await publish("global", GLOBAL_POLICY);
  for (const [scope, policy] of SCOPE_POLICIES) await publish(scope, policy);
  // The alert rules, to an email channel this demo keeps.
  expect(
    await call("POST", "/alerts/channels", {
      id: "ops-email",
      name: "Ops (kept by the playground)",
      type: "email",
      to: ["ops@playground.invalid"],
      receives: { kinds: ["*"] },
    }),
    [201],
    "the alert channel",
  );
  const rules = [
    {
      id: "ban-storm",
      title: "Automatic bans piling up",
      severity: "warning",
      condition: {
        type: "banStorm",
        windowMs: 300_000,
        value: 3,
        source: "auto",
      },
    },
    {
      id: "rule-tripped",
      title: "A rule tripped repeatedly",
      severity: "warning",
      condition: {
        type: "threshold",
        metric: "rules",
        groupBy: "rule",
        windowMs: 600_000,
        value: 20,
      },
    },
    {
      id: "canary-used",
      title: "Canary used",
      severity: "critical",
      condition: {
        type: "threshold",
        metric: "rules",
        groupBy: "rule",
        prefix: "canary:",
        windowMs: 300_000,
        value: 1,
      },
    },
    {
      id: "address-refused",
      title: "An address refused heavily",
      severity: "info",
      condition: {
        type: "threshold",
        metric: "top.refused",
        dims: { kind: "ip" },
        groupBy: "subject",
        windowMs: 600_000,
        value: 30,
      },
    },
  ];
  for (const { id, ...rule } of rules) {
    expect(
      await call("PUT", `/alerts/rules/${id}`, {
        ...rule,
        scope: "global",
        channels: ["ops-email"],
        revision: null,
      }),
      [200, 201],
      `alert rule ${id}`,
    );
  }
  // The agents, one per instance, and their engines.
  const instances: Instance[] = [];
  for (const service of SERVICES) {
    for (let n = 1; n <= service.instances; n++) {
      const id = `${service.id}-${n}`;
      const created = expect(
        await call("POST", "/agents", { id, service: service.id }),
        [201],
        `agent ${id}`,
      ).body as { secret: string };
      const recorder = createAnalyticsRecorder({ service: service.id });
      const ring = createEventRing({
        // The caps' warnings would flood the playground's terminal.
        logger: () => {},
        service: service.id,
        recorder,
        sampleAllows: 0.05,
      });
      const security = createSecurity<BunRequest>({
        policy: { service: service.id },
        secret: FLEET_SECRET,
        intel: demoIntel(),
        // No real DNS: an address outside Google's range has no name.
        resolver: staticCrawlerResolver(),
        identify: (req) => {
          const body = req.body as { username?: unknown } | undefined;
          const apiKey = req.get("x-api-key");
          // The signed-in user, as the app's session would name it.
          const user = req.get("x-demo-user");
          return {
            ...(typeof body?.username === "string"
              ? { username: body.username }
              : {}),
            ...(user === undefined || user === null ? {} : { user }),
            ...(apiKey === undefined || apiKey === null
              ? {}
              : { apiKey, apiKeyPlan: "partner" }),
          };
        },
        onDecision: analyticsHook({
          recorder,
          ring,
          redactor: createRedactor(),
        }),
        onSignal: analyticsSignalHook({ recorder }),
        logger: () => {},
      });
      const agent = connectAgent({
        url: `http://playground.internal${api.basePath}`,
        agent: id,
        secret: created.secret,
        service: service.id,
        publicKeys: { sk_demo: bundleKey.publicKey },
        security,
        stateFile: join(options.dataDir, `${id}.state.json`),
        artefactDir: join(options.dataDir, `${id}-artefacts`),
        pollInterval: "5s",
        banPollInterval: "2s",
        heartbeatInterval: "10s",
        nudge: false,
        events: { ring, recorder },
        fetch: (url, init) => app.fetch(new Request(url, init)),
        logger: () => {},
      });
      await agent.ready;
      instances.push({
        service: service.id,
        security,
        app: await serviceApp(security),
        agent,
      });
    }
  }
  // One dangerous change left waiting for a second operator: the reviewer
  // turns the dry-run rule on, for the browser's operator to approve.
  {
    const read = (await call("GET", "/policies/global", undefined, "reviewer"))
      .body as {
      draft: { revision: number } | null;
      head: { id: string } | null;
    };
    const enforced: SecurityPolicy = {
      ...GLOBAL_POLICY,
      requestRules: {
        ...GLOBAL_POLICY.requestRules,
        rules: [{ ...GLOBAL_POLICY.requestRules!.rules![0], mode: "enforce" }],
      },
    };
    expect(
      await call(
        "PUT",
        "/policies/global/draft",
        { policy: enforced, revision: read.draft?.revision ?? null },
        "reviewer",
      ),
      [200],
      "the waiting change's draft",
    );
    expect(
      await call(
        "POST",
        "/policies/global/publish",
        {
          expectedHead: read.head?.id ?? null,
          message: "enforce the admin-paths rule (waiting for your approval)",
        },
        "reviewer",
      ),
      [202],
      "the waiting change",
    );
  }

  // ── The attacker loop ───────────────────────────────────────────────────
  const figures = Object.fromEntries(
    LOOP_KINDS.map((kind) => [kind, { runs: 0, requests: 0, refused: 0 }]),
  ) as Record<LoopKind, KindFigures>;
  let tickNumber = 0;
  /** The instances of `service`, taken in turn. */
  const pick = (service: ServiceId): Instance => {
    const of = instances.filter((i) => i.service === service);
    return of[tickNumber % of.length];
  };
  /** Sends `attack` to `instance`, counting it under `kind`. */
  const send = async (kind: LoopKind, instance: Instance, attack: Attack) => {
    const result = await runAttack(attack, fetchTarget(instance.app));
    const figure = figures[kind];
    figure.runs += 1;
    figure.requests += result.sent;
    figure.refused += result.refused;
  };
  /** A request list from requests. */
  const requests = (name: string, list: Attack["requests"]): Attack => ({
    name,
    requests: list,
  });
  const tick = async () => {
    tickNumber += 1;
    const t = tickNumber;
    const user = (n: number) => `192.0.2.${20 + ((t * 7 + n) % 200)}`;
    // Normal users on every service.
    await send(
      "normal",
      pick("shop"),
      requests("browsing", [
        { path: "/", client: user(1) },
        { path: `/products/${t % 40}`, client: user(1) },
        { path: "/pricing", client: user(2) },
      ]),
    );
    await send(
      "normal",
      pick("accounts"),
      requests("signing-in", [
        {
          method: "POST",
          path: "/login",
          client: user(3),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username: `user${t % 30}@example.com`,
            password: "correct horse",
          }),
        },
      ]),
    );
    await send(
      "normal",
      pick("partner-api"),
      requests("partner-calls", [
        {
          path: "/api/orders",
          client: "192.0.2.240",
          headers: { "x-api-key": "pk_partner_good" },
        },
      ]),
    );
    // The office reaches the admin pages (an allow entry); a visitor trips the dry-run rule.
    if (t % 4 === 0)
      await send(
        "dry-run",
        pick("shop"),
        requests("admin-visit", [{ path: "/admin/reports", client: user(4) }]),
      );
    if (t % 5 === 0)
      await send(
        "list-hits",
        pick("shop"),
        requests("listed", [
          { path: "/admin/reports", client: "192.0.2.10" },
          { path: "/", client: `203.0.113.${200 + (t % 50)}` },
          { path: "/pricing", client: `198.51.100.${1 + (t % 200)}` },
        ]),
      );
    if (t % 3 === 0)
      await send(
        "verified-crawler",
        pick("shop"),
        crawl({
          client: "66.249.66.1",
          paths: ["/", `/products/${t % 40}`, `/old/page-${t}`],
        }),
      );
    if (t % 7 === 0)
      await send(
        "spoofed-crawler",
        pick("shop"),
        spoofedCrawler({ client: `203.0.113.${10 + (t % 50)}` }),
      );
    if (t % 9 === 0)
      await send(
        "path-scan",
        pick("shop"),
        pathScan({ client: `203.0.113.${60 + (t % 50)}`, count: 8 }),
      );
    if (t % 11 === 0)
      await send(
        "ipv6-rotation",
        pick("shop"),
        ipv6Rotation({
          count: 150,
          path: "/products",
          prefix: `2001:db8:${(t % 100).toString(16)}:1`,
        }),
      );
    if (t % 13 === 0)
      await send(
        "credential-stuffing",
        pick("accounts"),
        credentialStuffing({
          count: 40,
          client: `203.0.113.${110 + (t % 60)}`,
        }),
      );
    if (t % 17 === 0)
      await send(
        "api-key-abuse",
        pick("partner-api"),
        apiKeyAbuse({
          key: "pk_partner_leaked",
          count: 80,
          path: "/api/orders",
        }),
      );
    if (t % 30 === 0)
      await send(
        "canary",
        pick("accounts"),
        requests("canary-sign-in", [
          {
            method: "POST",
            path: "/login",
            client: `203.0.113.${170 + (t % 20)}`,
            headers: {
              "content-type": "application/json",
              // The session a stolen backup account opens: the canary.
              "x-demo-user": "backup-admin",
            },
            body: JSON.stringify({
              username: "backup-admin",
              password: "letmein",
            }),
          },
          // The canary banned its address: the next request is refused.
          { path: "/", client: `203.0.113.${170 + (t % 20)}` },
        ]),
      );
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  const schedule = () => {
    if (stopped || intervalMs <= 0) return;
    timer = setTimeout(() => {
      running = tick()
        .catch((error: unknown) => {
          process.stderr.write(
            `security demo: a tick failed: ${String(error)}\n`,
          );
        })
        .finally(schedule);
    }, intervalMs);
  };

  // The demo's own page: the loop's figures and the alert emails kept.
  app.get(`${SECURITY_DEMO_BASE}/status`, (_req, res) =>
    res.json({ tick: tickNumber, figures, emails }),
  );
  app.get(SECURITY_DEMO_BASE, (_req, res) => {
    const rows = LOOP_KINDS.map(
      (kind) =>
        `<tr><th scope="row">${kind}</th><td>${figures[kind].runs}</td><td>${figures[kind].requests}</td><td>${figures[kind].refused}</td></tr>`,
    ).join("");
    const mails = emails
      .map(
        (mail) =>
          `<li><strong>${escapeHtml(mail.subject)}</strong> <small>${new Date(mail.at).toISOString()}</small><pre>${escapeHtml(mail.text)}</pre></li>`,
      )
      .join("");
    res.set("content-type", "text/html; charset=utf-8");
    res.send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Security demo</title></head><body><h1>The security demo</h1><p><a href="${SECURITY_UI_BASE}">Open the security UI</a> · tick ${tickNumber}</p><table><thead><tr><th>Kind</th><th>Runs</th><th>Requests</th><th>Refused</th></tr></thead><tbody>${rows}</tbody></table><h2>Alert emails</h2><ul>${mails || "<li>None yet: the alert rules are evaluated every 15 s.</li>"}</ul></body></html>`,
    );
  });

  return {
    api,
    uiBase: ui.basePath,
    ui,
    figures: () => figures,
    emails: () => emails,
    tick,
    start: schedule,
    stop: async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await running;
      for (const instance of instances) {
        await instance.agent.close();
        instance.security.close();
      }
      api.live.close();
      api.close();
      rmSync(options.dataDir, { recursive: true, force: true });
    },
  };
}

/** `text` safe in HTML. */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
