/**
 * Attack simulators (plan §11.2): the traffic of the attacks bun-security
 * defends against, as plain request lists, and a runner that sends them to
 * an app and reports what happened. Apps use them to test their own
 * policies; the package's own suites use them for the named T-cases.
 *
 * ```ts
 * const result = await runAttack(credentialStuffing({ count: 100 }), fetchTarget(app));
 * expect(result.refused).toBeGreaterThan(0);
 * ```
 *
 * They measure **outcomes**, never speed: each request's status, the
 * refusals and their problem codes, the first refusal's place. A request
 * may carry `at` (ms from the attack's start): the runner moves a fake
 * clock with `advance` rather than waiting, so a six-hour attack runs in
 * milliseconds. Nothing leaves the process: targets are an app's
 * socket-free `fetch()` or a `Bun.serve` handler.
 *
 * Default addresses are public ones (the documentation ranges of RFC 5737
 * and RFC 3849 where one /24 is enough, `198.51.x.x`, `203.0.x.x` and
 * `100.200.x.x` where more are needed), never an internal range, which the
 * engine lets past most layers. Every simulator takes its own instead.
 */

import type { CrawlerResolver } from "../crawlers/verify";

/** One request of an attack. */
export interface AttackRequest {
  /** The method. Default `GET`. */
  readonly method?: string;
  /** The path, with any query (`/login`, `/search?q=x`). */
  readonly path: string;
  /** The socket peer's address. */
  readonly client: string;
  /** Headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** A body, as text (JSON or a form). */
  readonly body?: string;
  /** When it is sent, ms from the attack's start; the runner's `advance` moves a clock to it. */
  readonly at?: number;
}

/** An attack: a name and its requests, in order. */
export interface Attack {
  /** What it is (`credential-stuffing`). */
  readonly name: string;
  /** Its requests. */
  readonly requests: readonly AttackRequest[];
}

/** Where an attack is sent: one request in, its answer out. */
export type AttackTarget = (request: AttackRequest) => Promise<Response>;

/** What {@link runAttack} reports. */
export interface AttackResult {
  /** The attack's name. */
  readonly name: string;
  /** Requests sent. */
  readonly sent: number;
  /** Each answer's status, in order. */
  readonly statuses: readonly number[];
  /** Answers by status (`{ "200": 12, "429": 3 }`). */
  readonly byStatus: Readonly<Record<string, number>>;
  /** Answers the defence refused (see {@link RunAttackOptions.refused}). */
  readonly refused: number;
  /** The first refused request's index, if any was. */
  readonly firstRefused: number | undefined;
  /** Refusals by their problem `code` (`banned`, `rate_limited`, …; `dropped` for a dropped connection). */
  readonly codes: Readonly<Record<string, number>>;
  /** Each answer's problem `code`, `undefined` for an answer without one. */
  readonly answers: readonly (string | undefined)[];
}

/** Options for {@link runAttack}. */
export interface RunAttackOptions {
  /** Moves a fake clock to a request's `at` (by the difference since the last). Without it, `at` is ignored. */
  readonly advance?: (ms: number) => void;
  /**
   * Whether an answer is the defence's refusal. Default: any `403`, `429`
   * or `503`, and any problem+json answer with a `code` except a `401`
   * (`uniformAuthResponse`'s failed sign-in, the app's own answer). The
   * engine answers a probe or a honeypot with a `404` problem
   * (`not_found`), which counts; a router's plain `404` does not, nor does
   * an app's own problem+json without a `code`. A dropped connection
   * (status `0`, code `dropped`) always counts. The simulators send no
   * `Accept: text/html`, so refusals come as problem+json.
   */
  readonly refused?: (response: Response, code: string | undefined) => boolean;
  /**
   * Awaited after each answer, before the next request: lets an app's
   * fire-and-forget outcome recording land (`installSecurity` reports an
   * answer to the engine after sending it), as real traffic's spacing would.
   * Default none.
   */
  readonly settle?: () => Promise<void>;
  /** Stops after this many refusals. Default: never. */
  readonly stopAfterRefusals?: number;
}

/** The default refusal test. */
function defaultRefused(response: Response, code: string | undefined): boolean {
  if ([403, 429, 503].includes(response.status)) return true;
  // A problem code is the defence's (a probe's or a honeypot's disguised
  // `404` included), except a failed sign-in's `401`, which is the app's
  // answer made uniform.
  return code !== undefined && response.status !== 401;
}

/** One request's answer: its status (`0` when the connection was dropped) and problem `code`. */
async function answerOf(
  target: AttackTarget,
  request: AttackRequest,
): Promise<{
  status: number;
  code: string | undefined;
  response: Response | undefined;
}> {
  let response: Response;
  let body: string;
  try {
    response = await target(request);
    // A dropped connection (`drop`) is a body that errors, or a target that throws.
    body = await response.text();
  } catch {
    return { status: 0, code: undefined, response: undefined };
  }
  let code: string | undefined;
  if ((response.headers.get("content-type") ?? "").includes("problem+json")) {
    try {
      const parsed = JSON.parse(body) as { code?: unknown };
      if (typeof parsed.code === "string") code = parsed.code;
    } catch {
      // Not a problem body after all.
    }
  }
  return { status: response.status, code, response };
}

/** Sends `attack` to `target`, in order; what happened. */
export async function runAttack(
  attack: Attack,
  target: AttackTarget,
  options: RunAttackOptions = {},
): Promise<AttackResult> {
  const refused = options.refused ?? defaultRefused;
  const statuses: number[] = [];
  const answers: (string | undefined)[] = [];
  const byStatus: Record<string, number> = {};
  const codes: Record<string, number> = {};
  let refusals = 0;
  let firstRefused: number | undefined;
  let clock = 0;
  for (const [index, request] of attack.requests.entries()) {
    if (
      request.at !== undefined &&
      options.advance !== undefined &&
      request.at > clock
    ) {
      options.advance(request.at - clock);
      clock = request.at;
    }
    const { status, code, response } = await answerOf(target, request);
    await options.settle?.();
    statuses.push(status);
    answers.push(code);
    byStatus[String(status)] = (byStatus[String(status)] ?? 0) + 1;
    if (response === undefined || refused(response, code)) {
      refusals++;
      firstRefused ??= index;
      const name = code ?? (response === undefined ? "dropped" : undefined);
      if (name !== undefined) codes[name] = (codes[name] ?? 0) + 1;
      if (
        options.stopAfterRefusals !== undefined &&
        refusals >= options.stopAfterRefusals
      ) {
        break;
      }
    }
  }
  return Object.freeze({
    name: attack.name,
    sent: statuses.length,
    statuses: Object.freeze(statuses),
    byStatus: Object.freeze(byStatus),
    refused: refusals,
    firstRefused,
    codes: Object.freeze(codes),
    answers: Object.freeze(answers),
  });
}

/** An app with a socket-free `fetch()`: bun-common's `BunRouter` and adapters, bun-nest's adapter. */
export interface FetchableApp {
  /** Runs a request through the app. */
  readonly fetch: (
    input: string,
    init: RequestInit & {
      /** The socket peer's address the request reports. */
      readonly remoteAddress?: string;
    },
  ) => Promise<Response>;
}

/** A target over an app's socket-free `fetch()`: no port is bound. */
export function fetchTarget(app: FetchableApp): AttackTarget {
  return (request) =>
    app.fetch(request.path, {
      method: request.method ?? "GET",
      remoteAddress: request.client,
      ...(request.headers === undefined ? {} : { headers: request.headers }),
      ...(request.body === undefined ? {} : { body: request.body }),
    });
}

/** A `Bun.serve` fetch handler (`withSecurity`'s). */
export type ServeHandler = (
  request: Request,
  server: {
    /** The socket peer of `request`, as `Bun.Server#requestIP` returns it. */
    readonly requestIP: (request: Request) => {
      /** The peer's address. */
      readonly address: string;
    } | null;
  },
) => Response | Promise<Response> | undefined | Promise<Response | undefined>;

/**
 * A target over a `Bun.serve` handler (`withSecurity`'s), its peer the
 * request's `client`. An answer of `undefined` (an upgrade taken) reads as
 * a dropped connection.
 */
export function handlerTarget(
  handler: ServeHandler,
  origin = "http://app.test",
): AttackTarget {
  return async (request) => {
    const answer = await handler(
      new Request(`${origin}${request.path}`, {
        method: request.method ?? "GET",
        ...(request.headers === undefined ? {} : { headers: request.headers }),
        ...(request.body === undefined ? {} : { body: request.body }),
      }),
      { requestIP: () => ({ address: request.client }) },
    );
    if (answer === undefined) throw new Error("no answer");
    return answer;
  };
}

/**
 * `attack` with its requests `everyMs` apart (each request's `at`, from
 * `startMs`), replacing any times it had: real traffic arrives over time,
 * and a rule counting per second sees it that way.
 */
export function paced(attack: Attack, everyMs: number, startMs = 0): Attack {
  return {
    name: attack.name,
    requests: attack.requests.map((request, i) => ({
      ...request,
      at: startMs + i * everyMs,
    })),
  };
}

/** Attacks one after another, as one: each later one's times shifted to start after the one before it ends. */
export function sequence(name: string, ...attacks: readonly Attack[]): Attack {
  const requests: AttackRequest[] = [];
  let offset = 0;
  for (const attack of attacks) {
    let last = offset;
    for (const request of attack.requests) {
      const at = request.at === undefined ? offset : offset + request.at;
      requests.push({ ...request, at });
      last = Math.max(last, at);
    }
    offset = last;
  }
  return { name, requests };
}

// ── Addresses ──────────────────────────────────────────────────────────────

/**
 * The `n`th address (from 0) under `base`, an IPv4 prefix of one to three
 * octets (`"198.51"`, `"203.0.113"`, `"10"`): its last octet runs 1 to 254,
 * the others 0 to 253, so a two-octet base holds 64,516 addresses. Throws a
 * `RangeError` past that rather than repeating one.
 */
export function nthAddress(n: number, base = "198.51"): string {
  const parts = base.split(".").map(Number);
  const free = 4 - parts.length;
  if (
    free < 1 ||
    free > 3 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    throw new RangeError(
      `nthAddress: base must be one to three octets; got "${base}"`,
    );
  }
  if (!Number.isSafeInteger(n) || n < 0 || n >= 254 ** free) {
    throw new RangeError(
      `nthAddress: ${String(n)} is outside the ${254 ** free} addresses under "${base}"`,
    );
  }
  const octets = [...parts];
  for (let i = free - 1; i >= 0; i--) {
    octets.push((Math.floor(n / 254 ** i) % 254) + (i === 0 ? 1 : 0));
  }
  return octets.join(".");
}

/** `n` addresses inside one IPv6 /64 (`2001:db8:1:2::` by default). */
export function ipv6InPrefix(n: number, prefix = "2001:db8:1:2"): string[] {
  return Array.from(
    { length: n },
    (_, i) =>
      `${prefix}:${(i + 1).toString(16)}:${(i * 7 + 3).toString(16)}:${(i * 13 + 5).toString(16)}:1`,
  );
}

// ── Sign-in attacks (layers.md L11, T-L11-1) ───────────────────────────────

/** Common settings of the sign-in attacks. */
export interface SignInAttackOptions {
  /** The sign-in path. Default `/login`. */
  readonly path?: string;
  /** The body's username field. Default `username`. */
  readonly usernameField?: string;
  /** The body's password field. Default `password`. */
  readonly passwordField?: string;
  /** Extra headers on every request. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The time between attempts, in ms (each request's `at`). Default none: all at once. */
  readonly everyMs?: number;
}

/** A JSON sign-in request. */
function signIn(
  options: SignInAttackOptions,
  client: string,
  username: string,
  password: string,
  at?: number,
): AttackRequest {
  return {
    method: "POST",
    path: options.path ?? "/login",
    client,
    headers: { "content-type": "application/json", ...options.headers },
    body: JSON.stringify({
      [options.usernameField ?? "username"]: username,
      [options.passwordField ?? "password"]: password,
    }),
    ...(at === undefined ? {} : { at }),
  };
}

/** The `at` of attempt `i` under `options.everyMs`. */
function spaced(options: SignInAttackOptions, i: number): number | undefined {
  return options.everyMs === undefined ? undefined : i * options.everyMs;
}

/** Credential stuffing from one address: `count` leaked username and password pairs (T-L11-1's 1 IP × N usernames). */
export function credentialStuffing(
  options: SignInAttackOptions & {
    /** How many pairs. Default `1000`. */
    readonly count?: number;
    /** The attacker's address. Default `203.0.113.66`. */
    readonly client?: string;
    /** The leaked usernames' email domain. Default `leaked.example.org`. */
    readonly domain?: string;
  } = {},
): Attack {
  const count = options.count ?? 1000;
  const client = options.client ?? "203.0.113.66";
  return {
    name: "credential-stuffing",
    requests: Array.from({ length: count }, (_, i) =>
      signIn(
        options,
        client,
        `user${i}@${options.domain ?? "leaked.example.org"}`,
        `leaked-password-${i}`,
        spaced(options, i),
      ),
    ),
  };
}

/** Guessing one account's password from many addresses (T-L11-1's N IPs × 1 username). */
export function distributedGuessing(
  options: SignInAttackOptions & {
    /** The account attacked. */
    readonly username: string;
    /** How many guesses, each from a new address. Default `1000`. */
    readonly count?: number;
    /** The addresses' prefix, for {@link nthAddress}. Default `198.51`. */
    readonly base?: string;
  },
): Attack {
  const count = options.count ?? 1000;
  return {
    name: "distributed-guessing",
    requests: Array.from({ length: count }, (_, i) =>
      signIn(
        options,
        nthAddress(i, options.base),
        options.username,
        `guess-${i}`,
        spaced(options, i),
      ),
    ),
  };
}

/**
 * Password spraying: one common password against many usernames, from a
 * pool of `clients` addresses taken in turn (default 1). A pool as large
 * as the username list is a fresh address per attempt.
 */
export function passwordSpraying(
  options: SignInAttackOptions & {
    /** The accounts sprayed, in order. */
    readonly usernames: readonly string[];
    /** The one password tried. Default `Winter2026!`. */
    readonly password?: string;
    /** How many addresses the attempts rotate through. Default `1`. */
    readonly clients?: number;
    /** The addresses' prefix, for {@link nthAddress}. Default `203.0`. */
    readonly base?: string;
  },
): Attack {
  const pool = Math.max(1, options.clients ?? 1);
  return {
    name: "password-spraying",
    requests: options.usernames.map((username, i) =>
      signIn(
        options,
        nthAddress(i % pool, options.base ?? "203.0"),
        username,
        options.password ?? "Winter2026!",
        spaced(options, i),
      ),
    ),
  };
}

/**
 * Low-and-slow: `count` attempts from one address spread evenly over
 * `hours` (T-L11-1), so a per-minute limit never sees more than one; on one
 * username, or a new one each time with `usernames`.
 */
export function lowAndSlow(
  options: Omit<SignInAttackOptions, "everyMs"> & {
    /** The one account tried, unless `usernames` is given. */
    readonly username?: string;
    /** Accounts tried in turn. Default: `username`, or a new one each attempt. */
    readonly usernames?: readonly string[];
    /** How many attempts. Default `60`. */
    readonly count?: number;
    /** The hours they are spread over. Default `6`. */
    readonly hours?: number;
    /** The attacker's address. Default `203.0.113.67`. */
    readonly client?: string;
  },
): Attack {
  const count = options.count ?? 60;
  const every = ((options.hours ?? 6) * 3_600_000) / count;
  return {
    name: "low-and-slow",
    requests: Array.from({ length: count }, (_, i) =>
      signIn(
        options,
        options.client ?? "203.0.113.67",
        options.usernames?.[i % options.usernames.length] ??
          options.username ??
          `user${i}@leaked.example.org`,
        `slow-guess-${i}`,
        Math.round(i * every),
      ),
    ),
  };
}

/**
 * Account enumeration (T-L11-2): a wrong password for each name in
 * `usernames`, from one address, to tell real accounts from missing ones
 * by status, body or time. {@link enumerationLeaks} reads the answers.
 */
export function accountEnumeration(
  options: SignInAttackOptions & {
    /** The names probed, real and missing. */
    readonly usernames: readonly string[];
    /** The attacker's address. Default `203.0.113.72`. */
    readonly client?: string;
  },
): Attack {
  return {
    name: "account-enumeration",
    requests: options.usernames.map((username, i) =>
      signIn(
        options,
        options.client ?? "203.0.113.72",
        username,
        `wrong-${i}`,
        spaced(options, i),
      ),
    ),
  };
}

/** One answer of an enumeration probe, as {@link probeAnswers} records it. */
export interface ProbeAnswer {
  /** The username tried. */
  readonly username: string;
  /** The answer's status. */
  readonly status: number;
  /** The answer's body. */
  readonly body: string;
  /** How long the answer took, in ms (the wall clock: the one thing here that is a time). */
  readonly ms: number;
}

/** Sends each request of `attack` and records its status, body and time, for {@link enumerationLeaks}. */
export async function probeAnswers(
  attack: Attack,
  target: AttackTarget,
): Promise<ProbeAnswer[]> {
  const out: ProbeAnswer[] = [];
  for (const request of attack.requests) {
    const started = performance.now();
    const response = await target(request);
    const body = await response.text();
    const parsed =
      request.body === undefined
        ? undefined
        : (JSON.parse(request.body) as Record<string, unknown>);
    const username =
      Object.values(parsed ?? {}).find(
        (value): value is string => typeof value === "string",
      ) ?? "";
    out.push({
      username,
      status: response.status,
      body,
      ms: performance.now() - started,
    });
  }
  return out;
}

/**
 * What tells `known` accounts from the rest in `answers`: `status` and
 * `body` when the two groups' answers differ, `time` when the fastest
 * answer of one group comes before `minMs`. Empty when nothing does.
 */
export function enumerationLeaks(
  answers: readonly ProbeAnswer[],
  known: ReadonlySet<string>,
  minMs: number,
): ("status" | "body" | "time")[] {
  const groups = [
    answers.filter((answer) => known.has(answer.username)),
    answers.filter((answer) => !known.has(answer.username)),
  ];
  const leaks: ("status" | "body" | "time")[] = [];
  const distinct = (pick: (answer: ProbeAnswer) => string | number) =>
    new Set(
      groups.map((group) => [...new Set(group.map(pick))].sort().join("|")),
    ).size > 1;
  if (distinct((answer) => answer.status)) leaks.push("status");
  if (distinct((answer) => answer.body)) leaks.push("body");
  if (answers.some((answer) => answer.ms < minMs)) leaks.push("time");
  return leaks;
}

// ── Scanning (layers.md L7, L14, L8) ───────────────────────────────────────

/** The probe paths a scanner tries first (ffuf's and nuclei's favourites). */
export const PROBE_PATHS: readonly string[] = Object.freeze([
  "/.env",
  "/.git/config",
  "/wp-admin/",
  "/wp-login.php",
  "/phpmyadmin/index.php",
  "/actuator/env",
  "/cgi-bin/test.cgi",
  "/admin.php",
  "/server-status",
  "/.aws/credentials",
]);

/** Path scanning from one address: the probe paths, then `count` dead links (a fuzzing burst of 404s). */
export function pathScan(
  options: {
    /** The scanner's address. Default `203.0.113.68`. */
    readonly client?: string;
    /** How many dead links follow the probes. Default `200`. */
    readonly count?: number;
    /** The probe paths, sent first. Default {@link PROBE_PATHS}. */
    readonly probes?: readonly string[];
    /** The scanner's `User-Agent`. Default ffuf's. */
    readonly userAgent?: string;
  } = {},
): Attack {
  const client = options.client ?? "203.0.113.68";
  const headers = {
    "user-agent": options.userAgent ?? "Fuzz Faster U Fool v2.1.0",
  };
  const paths = [
    ...(options.probes ?? PROBE_PATHS),
    ...Array.from(
      { length: options.count ?? 200 },
      (_, i) => `/api/v1/fuzz-${i}`,
    ),
  ];
  return {
    name: "path-scan",
    requests: paths.map((path) => ({ path, client, headers })),
  };
}

// ── Address games (layers.md L2) ───────────────────────────────────────────

/** One client rotating through `count` addresses of one IPv6 /64 (T-L2-3: one key, one limit). */
export function ipv6Rotation(
  options: {
    /** How many addresses. Default `100`. */
    readonly count?: number;
    /** The path requested. Default `/`. */
    readonly path?: string;
    /** The /64, as its first four groups. Default `2001:db8:1:2`. */
    readonly prefix?: string;
  } = {},
): Attack {
  return {
    name: "ipv6-rotation",
    requests: ipv6InPrefix(options.count ?? 100, options.prefix).map(
      (client) => ({ path: options.path ?? "/", client }),
    ),
  };
}

/** A client rotating through many addresses (Tor exits, a botnet): one request each, or `perAddress`. */
export function addressRotation(options: {
  /** The addresses, in turn. */
  readonly addresses: readonly string[];
  /** The path requested. Default `/`. */
  readonly path?: string;
  /** The method. Default `GET`. */
  readonly method?: string;
  /** Requests from each address. Default `1`. */
  readonly perAddress?: number;
  /** Headers on every request. */
  readonly headers?: Readonly<Record<string, string>>;
  /** A body on every request, as text. */
  readonly body?: string;
}): Attack {
  const requests: AttackRequest[] = [];
  for (const client of options.addresses) {
    for (let i = 0; i < (options.perAddress ?? 1); i++) {
      requests.push({
        path: options.path ?? "/",
        client,
        ...(options.method ? { method: options.method } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.body === undefined ? {} : { body: options.body }),
      });
    }
  }
  return { name: "address-rotation", requests };
}

/** A key-cardinality flood (T-L9-2): `count` distinct addresses, one request each, to swell the state tables. */
export function keyCardinalityFlood(
  options: {
    /** How many addresses. Default `10_000`. */
    readonly count?: number;
    /** The path requested. Default `/`. */
    readonly path?: string;
    /** The addresses' prefix, for {@link nthAddress}. Default `100.200`. */
    readonly base?: string;
  } = {},
): Attack {
  return {
    name: "key-cardinality-flood",
    requests: Array.from({ length: options.count ?? 10_000 }, (_, i) => ({
      path: options.path ?? "/",
      client: nthAddress(i, options.base ?? "100.200"),
    })),
  };
}

/** A burst of `count` requests from one address, `everyMs` apart (default all at once). */
export function burst(
  options: {
    /** The address. Default `203.0.113.69`. */
    readonly client?: string;
    /** The path requested. Default `/`. */
    readonly path?: string;
    /** How many requests. Default `100`. */
    readonly count?: number;
    /** The time between them, in ms. Default none: all at once. */
    readonly everyMs?: number;
    /** The method. Default `GET`. */
    readonly method?: string;
  } = {},
): Attack {
  return {
    name: "burst",
    requests: Array.from({ length: options.count ?? 100 }, (_, i) => ({
      path: options.path ?? "/",
      client: options.client ?? "203.0.113.69",
      ...(options.method ? { method: options.method } : {}),
      ...(options.everyMs === undefined ? {} : { at: i * options.everyMs }),
    })),
  };
}

/** A client claiming another's address in `X-Forwarded-For` (T-L2-1): the peer is `peer`, the claim `claimed`. */
export function forwardedForSpoof(options: {
  /** The real socket peer. */
  readonly peer: string;
  /** The address claimed in `X-Forwarded-For`. */
  readonly claimed: string;
  /** How many requests. Default `1`. */
  readonly count?: number;
  /** The path requested. Default `/`. */
  readonly path?: string;
}): Attack {
  return {
    name: "forwarded-for-spoof",
    requests: Array.from({ length: options.count ?? 1 }, () => ({
      path: options.path ?? "/",
      client: options.peer,
      headers: { "x-forwarded-for": options.claimed },
    })),
  };
}

// ── Crawlers (layers.md L3.2) ───────────────────────────────────────────────

/** Real crawlers' `User-Agent`s, by registry id. */
export const CRAWLER_USER_AGENTS: Readonly<Record<string, string>> =
  Object.freeze({
    google:
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    bing: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36",
    apple:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)",
    duckduckgo: "DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)",
  });

/** A crawl: `crawler`'s `User-Agent` from `client` over `paths` (verified when `client` is in its ranges). */
export function crawl(options: {
  /** A registry id of {@link CRAWLER_USER_AGENTS}, or a `User-Agent` of its own. Default `google`. */
  readonly crawler?: string;
  /** The crawler's address. */
  readonly client: string;
  /** The paths crawled, in order. */
  readonly paths: readonly string[];
}): Attack {
  const userAgent =
    CRAWLER_USER_AGENTS[options.crawler ?? "google"] ?? options.crawler ?? "";
  return {
    name: `crawl:${options.crawler ?? "google"}`,
    requests: options.paths.map((path) => ({
      path,
      client: options.client,
      headers: { "user-agent": userAgent },
    })),
  };
}

/** A spoofed crawler (T-L3-2): a crawler's `User-Agent` from an address that is not the crawler's. */
export function spoofedCrawler(
  options: {
    /** The crawler impersonated. Default `google`. */
    readonly crawler?: string;
    /** The impostor's address. Default `203.0.113.70`. */
    readonly client?: string;
    /** The paths requested. Default `/`, `/pricing` and `/.env`. */
    readonly paths?: readonly string[];
  } = {},
): Attack {
  return {
    ...crawl({
      client: options.client ?? "203.0.113.70",
      paths: options.paths ?? ["/", "/pricing", "/.env"],
      ...(options.crawler ? { crawler: options.crawler } : {}),
    }),
    name: `spoofed-crawler:${options.crawler ?? "google"}`,
  };
}

// ── Account and API abuse (layers.md L11.7, L12) ───────────────────────────

/** Sign-ups with disposable addresses (ConcaveHR's first wave): `count` of them, from one address. */
export function disposableSignups(
  options: {
    /** The sign-up path. Default `/signup`. */
    readonly path?: string;
    /** The attacker's address. Default `203.0.113.71`. */
    readonly client?: string;
    /** How many sign-ups. Default `30`. */
    readonly count?: number;
    /** The disposable domains, in turn. Default three `.example` ones. */
    readonly domains?: readonly string[];
    /** The body's email field. Default `email`. */
    readonly emailField?: string;
  } = {},
): Attack {
  const domains = options.domains ?? [
    "mailinator.example",
    "tempmail.example",
    "10minutemail.example",
  ];
  return {
    name: "disposable-signups",
    requests: Array.from({ length: options.count ?? 30 }, (_, i) => ({
      method: "POST",
      path: options.path ?? "/signup",
      client: options.client ?? "203.0.113.71",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        [options.emailField ?? "email"]:
          `probe${i}@${domains[i % domains.length] ?? "tempmail.example"}`,
        name: `'; DROP TABLE users; -- ${i}`,
      }),
    })),
  };
}

/** One API key used from `count` addresses (a leaked key; L12's many-addresses anomaly). */
export function apiKeyAbuse(options: {
  /** The key used. */
  readonly key: string;
  /** The header carrying it. Default `x-api-key`. */
  readonly header?: string;
  /** How many addresses use it, one request each. Default `50`. */
  readonly count?: number;
  /** The path requested. Default `/api`. */
  readonly path?: string;
  /** The addresses' prefix, for {@link nthAddress}. Default `45.80`. */
  readonly base?: string;
}): Attack {
  return {
    name: "api-key-abuse",
    requests: Array.from({ length: options.count ?? 50 }, (_, i) => ({
      path: options.path ?? "/api",
      client: nthAddress(i, options.base ?? "45.80"),
      headers: { [options.header ?? "x-api-key"]: options.key },
    })),
  };
}

// ── Browsers (layers.md L13) ───────────────────────────────────────────────

/**
 * Cross-site form posts with the victim's cookies (T-L13-1): a cross-site
 * one (`Sec-Fetch-Site: cross-site`), a same-site one, and a header-less
 * one carrying only `Origin` (an old browser), from `origin`.
 */
export function crossSitePosts(
  options: {
    /** The state-changing path. Default `/transfer`. */
    readonly path?: string;
    /** The victim's `Cookie` header. Default `session=victim`. */
    readonly cookie?: string;
    /** The victim's address. Default `198.51.100.40`. */
    readonly client?: string;
    /** The attacker's origin. Default `https://evil.example`. */
    readonly attacker?: string;
    /** The app's own origin. Default `http://app.test`. */
    readonly site?: string;
  } = {},
): Attack {
  const base = {
    method: "POST",
    path: options.path ?? "/transfer",
    client: options.client ?? "198.51.100.40",
  };
  const cookie = options.cookie ?? "session=victim";
  const attacker = options.attacker ?? "https://evil.example";
  const site = options.site ?? "http://app.test";
  const form = { "content-type": "application/x-www-form-urlencoded", cookie };
  return {
    name: "cross-site-posts",
    requests: [
      {
        ...base,
        headers: {
          ...form,
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "navigate",
          origin: attacker,
        },
        body: "to=attacker&amount=1000",
      },
      {
        ...base,
        headers: {
          ...form,
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "navigate",
          origin: site,
        },
        body: "to=friend&amount=10",
      },
      {
        ...base,
        headers: { ...form, origin: attacker },
        body: "to=attacker&amount=1000",
      },
      {
        ...base,
        headers: { ...form, origin: site },
        body: "to=friend&amount=10",
      },
    ],
  };
}

// ── Fakes for the attacks above ─────────────────────────────────────────────

/**
 * A crawler resolver from fixed records, for verifying crawlers in tests
 * with no DNS (`createSecurity`'s `resolver`): `reverse` maps an address to
 * its PTR names, `forward` a name to its addresses. An address or a name it
 * does not know rejects with `ENOTFOUND`, as a resolver does.
 */
export function staticCrawlerResolver(
  records: {
    /** PTR names by address. */
    readonly reverse?: Readonly<Record<string, readonly string[]>>;
    /** Addresses by name. */
    readonly forward?: Readonly<Record<string, readonly string[]>>;
  } = {},
): CrawlerResolver {
  const notFound = (what: string) =>
    Promise.reject(
      Object.assign(new Error(`ENOTFOUND ${what}`), { code: "ENOTFOUND" }),
    );
  return Object.freeze({
    reverse: (address: string) => {
      const names = records.reverse?.[address];
      return names === undefined ? notFound(address) : Promise.resolve(names);
    },
    lookup: (name: string) => {
      const addresses = records.forward?.[name];
      return addresses === undefined
        ? notFound(name)
        : Promise.resolve(addresses);
    },
  });
}
