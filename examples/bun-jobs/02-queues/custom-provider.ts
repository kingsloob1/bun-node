/**
 * Writing a compute provider: `defineComputeProvider` from
 * `@kingsleyweb/bun-jobs/provider`, used as a queue's summoner, and tested
 * with the conformance kit from `@kingsleyweb/bun-jobs/provider/testing`.
 *
 * ```bash
 * bun 02-queues/custom-provider.ts
 * ```
 *
 * The platform is "Nimbus", made up: `02-queues/helpers/nimbus-platform.ts`
 * is its fake, `fakePlatform()` routes answering the way the platform would.
 * The provider talks to it over HTTP, through its call context's `fetch`. When
 * the fake starts a unit, this tour starts a real worker process for it —
 * `02-queues/helpers/summoned-entry.ts`, with the unit's arguments — so a job
 * added here is worked by a worker the provider summoned. Summoning needs a
 * backend another process can reach, so on the memory driver this runs on a
 * temporary SQLite file.
 *
 * The points that are easy to get wrong:
 *
 * - **An asynchronous config is waited for, not assumed.** A schema that
 *   answers with a promise (here: reading the token from a secret store)
 *   leaves the provider's `ready` pending; an attempt waits for it, at most
 *   `summonTimeout`. A rejection or that timeout is a **failed attempt**, with
 *   the error's code or `ready timed out` as its detail, and the next check
 *   validates again.
 * - **Declared secrets are redacted by value.** What the provider logs through
 *   `ctx.logger` has them replaced wherever they appear, prose included, where
 *   no pattern would find them; and a `describe()` fact holding one is
 *   dropped from the facts the status route serves.
 * - **The error's kind decides how it counts**, not its message: `auth` and
 *   `misconfigured` open the circuit on the first failure; `throttled` is
 *   `unavailable`, never counted, and holds the next attempt back at least its
 *   `retryAfterMs`; `transient` (and anything not a `ProviderError`) is
 *   counted like any failure.
 * - **The detail is the platform's code only when it looks like one.** A
 *   `platformCode` of prose — a gateway's error text — shows as
 *   `PROVIDER_<KIND>` instead, and the conformance kit warns about it.
 * - **Every platform call goes through `ctx.fetch`.** The kit routes it to the
 *   fake and fails a provider that calls the global `fetch`.
 * - **The kit needs a backend two processes share**: it refuses the memory
 *   driver up front, and each run needs a fake of its own, since it reads
 *   every request the fake received.
 */
import type { Summoner, SummonEventPayload } from "@kingsleyweb/bun-jobs";
import type {
  ProviderCallContext,
  SummonCapabilities,
  SummonResult,
} from "@kingsleyweb/bun-jobs/provider";
import type { Subprocess } from "bun";
import type { RunBody } from "./helpers/nimbus-platform";
import process from "node:process";
import { createTestLogger } from "@kingsleyweb/bun-common";
import { BunJobs } from "@kingsleyweb/bun-jobs";
import {
  COMPUTE_PROVIDER_API,
  defineComputeProvider,
  JobsError,
  ProviderError,
  toStandardSchema,
} from "@kingsleyweb/bun-jobs/provider";
import {
  assertConformance,
  runProviderConformance,
} from "@kingsleyweb/bun-jobs/provider/testing";
import { crossProcessDriver, exampleNamespace } from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { nimbusPlatform } from "./helpers/nimbus-platform";

title("Writing a compute provider");

/** A generous ceiling for a child's start-up and anything a slow server stretches. */
const WAIT = { timeout: 30_000, interval: 20 };
/** Every trigger off: the controller checks only when told to. */
const ONE_SHOT = { onAdd: false, events: false, poll: false } as const;
/** A policy whose failures cost 1 ms of backoff, so the next check is never held back by it. */
const QUICK = { cooldown: 0, backoff: { initial: 1, max: 1 } } as const;
/**
 * How long an attempt waits for `invoices`' provider to be ready. Well above
 * what a ready secret store and a local call take, since it also bounds the
 * summon call itself.
 */
const READY_WAIT = 1_500;

const config = crossProcessDriver();
const namespace = exampleNamespace("provider");
const ENTRY = new URL("./helpers/summoned-entry.ts", import.meta.url).pathname;

/* ------------------------------------------------------------------ */
/* The provider                                                        */
/* ------------------------------------------------------------------ */

/** What a user configures Nimbus with. */
interface NimbusInput {
  /** The API's base URL: the fake's, here. */
  url: string;
  /** The region, a fact the status route shows. */
  region: string;
  /** The API token, or a function reading it from a secret store. */
  apiToken: string | (() => Promise<string>);
}

/** The validated config the facets receive: the token, resolved. */
interface NimbusConfig {
  /** The API's base URL. */
  url: string;
  /** The region. */
  region: string;
  /** The API token: a declared secret. */
  apiToken: string;
}

/**
 * Validates a config and resolves its token. Always a promise, so the
 * provider's `ready` settles later: with a function for the token, only once
 * the secret store has answered, and rejecting with what the store threw.
 */
async function resolveConfig(
  input: unknown,
): Promise<
  { value: NimbusConfig } | { issues: { message: string; path: string[] }[] }
> {
  const given = (input ?? {}) as Partial<NimbusInput>;
  const issues: { message: string; path: string[] }[] = (
    ["url", "region"] as const
  )
    .filter((field) => typeof given[field] !== "string")
    .map((field) => ({ message: `${field} is required`, path: [field] }));
  if (
    typeof given.apiToken !== "string" &&
    typeof given.apiToken !== "function"
  ) {
    issues.push({
      message: "apiToken is required: a string, or a function reading one",
      path: ["apiToken"],
    });
  }
  if (issues.length > 0) {
    return { issues };
  }
  const apiToken =
    typeof given.apiToken === "function"
      ? await given.apiToken()
      : given.apiToken!;
  return {
    value: { url: given.url!, region: given.region!, apiToken },
  };
}

/** A failed platform answer as a `ProviderError` whose kind says how it counts. */
async function toProviderError(response: Response): Promise<ProviderError> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string };
  };
  const code = body.error?.code;
  const kind =
    response.status === 429
      ? "throttled"
      : code === "QuotaExceeded"
        ? "quota"
        : response.status === 401 || response.status === 403
          ? "auth"
          : response.status === 404
            ? "misconfigured"
            : response.status === 409
              ? "conflict"
              : "transient";
  return new ProviderError(`nimbus answered ${response.status}`, kind, {
    // Passed on as it came: a gateway's prose included, which the detail
    // then shows as PROVIDER_<KIND>.
    ...(code === undefined ? {} : { platformCode: code }),
    status: response.status,
    // Retry-After is in seconds.
    ...(kind === "throttled" || kind === "quota"
      ? {
          retryAfterMs:
            Number(response.headers.get("retry-after") ?? 1) * 1_000,
        }
      : {}),
  });
}

/**
 * Defines the Nimbus provider. `globalFetch` plants the one bug the
 * conformance step looks for: platform calls through the global `fetch`
 * rather than `ctx.fetch`.
 */
function defineNimbus(options: { globalFetch?: boolean } = {}) {
  /** The `fetch` a call uses. */
  const fetcher = (ctx: ProviderCallContext): typeof fetch =>
    options.globalFetch === true ? globalThis.fetch : ctx.fetch;

  return defineComputeProvider<NimbusConfig, NimbusInput>({
    name: "bun-jobs-provider-nimbus",
    version: "0.2.0",
    kind: "nimbus",
    displayName: "Nimbus",
    apiVersion: {
      core: COMPUTE_PROVIDER_API.core,
      summon: COMPUTE_PROVIDER_API.summon,
    },
    config: toStandardSchema<NimbusInput, NimbusConfig>(resolveConfig),
    secrets: ["apiToken"],
    describe: (resolved) => ({
      region: resolved.region,
      endpoint: resolved.url,
      // A sign-in link a careless edit builds with the token in it: dropped
      // from the facts, since it holds a declared secret.
      console: `${resolved.url}/console?session=${resolved.apiToken}`,
    }),
    validate: async (resolved, ctx) => {
      const response = await fetcher(ctx)(`${resolved.url}/v1/whoami`, {
        headers: { authorization: `Bearer ${resolved.apiToken}` },
        signal: ctx.signal,
      });
      if (!response.ok) {
        throw await toProviderError(response);
      }
      const { account } = (await response.json()) as { account: string };
      return [
        { id: "credentials", status: "pass", detail: `account ${account}` },
      ];
    },
    summon: (resolved) => {
      const capabilities: SummonCapabilities = {
        style: "launch",
        // Nimbus remembers a run's token, and refuses one reused with other
        // parameters: so the body is a pure function of the key.
        dedupe: {
          kind: "token",
          maxLength: 64,
          charset: "A-Za-z0-9-",
          scope: "region",
          strict: true,
        },
        passes: "argv",
        bootBudgetMs: 60_000,
        shutdown: { signal: "SIGTERM", graceMs: 10_000 },
        maxLifetimeMs: 86_400_000,
        enforcesLifetime: true,
      };

      /** One platform call, and the debug line a provider might write for it. */
      const call = async (
        ctx: ProviderCallContext,
        method: string,
        path: string,
        body?: unknown,
      ): Promise<Response> => {
        const headers = { authorization: `Bearer ${resolved.apiToken}` };
        // The token in prose, where no pattern would find it: only its
        // declaration as a secret keeps it out of the log.
        ctx.logger.debug(
          `nimbus ${method} ${path} with session ${resolved.apiToken}`,
          { region: resolved.region, headers },
        );
        return await fetcher(ctx)(`${resolved.url}${path}`, {
          method,
          headers:
            body === undefined
              ? headers
              : { ...headers, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: ctx.signal,
        });
      };

      return {
        capabilities,
        summon: async (request, ctx): Promise<SummonResult> => {
          const body: RunBody = {
            token: request.dedupeKey,
            args: [...request.argv],
            count: request.count,
            lifetimeSeconds: Math.floor(request.maxLifetimeMs / 1_000),
          };
          const response = await call(ctx, "POST", "/v1/runs", body);
          if (!response.ok) {
            throw await toProviderError(response);
          }
          const answer = (await response.json()) as {
            handles?: string[];
            deduped?: boolean;
            failures?: { reason: string }[];
          };
          // A 200 with no capacity is an answer, not an error.
          if (answer.failures !== undefined && answer.failures.length > 0) {
            return {
              status: "unavailable",
              reason: answer.failures[0]!.reason,
            };
          }
          return answer.deduped === true
            ? { status: "deduped", handles: answer.handles ?? [] }
            : { status: "started", handles: answer.handles ?? [] };
        },
        status: async (handles, ctx) => {
          const response = await call(
            ctx,
            "GET",
            `/v1/runs?handles=${handles.map(encodeURIComponent).join(",")}`,
          );
          if (!response.ok) {
            throw await toProviderError(response);
          }
          return (
            (await response.json()) as {
              units: {
                handle: string;
                state: "pending" | "running" | "exited" | "unknown";
              }[];
            }
          ).units;
        },
        cancel: async (handles, ctx) => {
          const response = await call(ctx, "POST", "/v1/runs/cancel", {
            handles,
          });
          if (!response.ok) {
            throw await toProviderError(response);
          }
        },
      };
    },
  });
}

/** The provider, as its package would export it. */
const nimbus = defineNimbus();

/* ------------------------------------------------------------------ */
/* The platform, the workers it starts, and a secret store             */
/* ------------------------------------------------------------------ */

const { platform, runs } = await nimbusPlatform();

/**
 * Every worker process the fake's units started, killed if still alive when
 * the tour exits, so a failed run leaves none behind.
 */
const children = new Set<Subprocess>();
process.on("exit", () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});
/** The worker process each unit started, by handle. */
const workers = new Map<string, Subprocess>();

// What the platform does with a unit: runs the worker entry with the unit's
// arguments, which carry the summon's identity. The backend travels in the
// environment, as a platform's task definition would carry it.
platform.onStart((unit) => {
  const child = Bun.spawn({
    cmd: [process.execPath, ENTRY, ...unit.argv],
    env: {
      ...process.env,
      SUMMONED_DRIVER: JSON.stringify(config),
      SUMMONED_IDLE_FOR: "500",
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  children.add(child);
  workers.set(unit.handle, child);
});

/**
 * The token the secret stores hold: made up, for the made-up Nimbus. No
 * redaction pattern matches its shape, so only declaring it a secret keeps it
 * out of the logs.
 */
const TOKEN = "nmb_live_4f9c2a7e1d0b8c35";

/**
 * A secret store `invoices`' config reads its token from, in the state the
 * tour puts it in: `"down"` throws, `"slow"` answers only once released,
 * `"up"` answers at once.
 */
const store = {
  mode: "down" as "down" | "slow" | "up",
  /** How many times the token was read. */
  reads: 0,
  /** What a `"slow"` read waits for: released as the tour ends. */
  held: Promise.withResolvers<void>(),
  /** Reads the token. */
  read: async (): Promise<string> => {
    store.reads++;
    if (store.mode === "down") {
      throw new ProviderError("the secret store did not answer", "transient", {
        platformCode: "SecretStoreUnavailable",
      });
    }
    if (store.mode === "slow") {
      await store.held.promise;
    }
    return TOKEN;
  },
};

/* ------------------------------------------------------------------ */
step("Writing a provider: an asynchronous config, and a declared secret");

// The token comes from a store that takes a moment, so validation is a
// promise and the configured provider is not ready yet.
const emailsNimbus = nimbus({
  url: platform.url,
  region: "eu-west-1",
  apiToken: async () => {
    await Bun.sleep(20);
    return TOKEN;
  },
});
const factsBefore = emailsNimbus.describe();
await checkRejects(
  "before ready, its capabilities are unknown: reading them throws",
  () => emailsNimbus.summon.capabilities,
  { code: "CONFIG", message: /still being validated/ },
);
await emailsNimbus.ready;
const facts = emailsNimbus.describe();
show("describe() once ready", facts);
checkEqual(
  "describe() is {} until ready; then the facts, less the one holding the token",
  [factsBefore, facts],
  [{}, { region: "eu-west-1", endpoint: platform.url }],
);
const preflight = await emailsNimbus.validate();
checkEqual(
  "validate() asks the platform whether the credentials work, and starts nothing",
  [preflight, (await platform.units()).length],
  [[{ id: "credentials", status: "pass", detail: "account nimbus-test" }], 0],
);

// Its twin reads the token from the store above, which is down to begin with:
// that validation, started here, has already failed by the first check.
const invoicesNimbus = nimbus({
  url: platform.url,
  region: "eu-west-1",
  apiToken: store.read,
});

/**
 * What the controllers log, collected: the provider's own debug lines
 * through `ctx.logger` among them.
 */
const { logger, events: logged } = createTestLogger();

const jobs = new BunJobs({
  namespace,
  driver: config,
  logger,
  summon: {
    // On demand: the add triggers a check 50 ms after the last add, and a
    // poll notices the worker registering, kept well behind the add.
    emails: {
      summoner: emailsNimbus,
      triggers: { poll: 1_000, debounce: 50 },
      bootBudget: 30_000,
    },
    invoices: {
      summoner: invoicesNimbus,
      triggers: ONE_SHOT,
      ...QUICK,
      summonTimeout: READY_WAIT,
    },
    exports: {
      summoner: emailsNimbus,
      triggers: ONE_SHOT,
      ...QUICK,
      circuit: { failures: 3, resetAfter: 60_000 },
    },
    reports: {
      summoner: emailsNimbus,
      triggers: ONE_SHOT,
      ...QUICK,
      circuit: { failures: 3, resetAfter: 60_000 },
    },
    thumbnails: {
      summoner: emailsNimbus,
      triggers: ONE_SHOT,
      ...QUICK,
      circuit: { failures: 2, resetAfter: 60_000 },
    },
  },
});

/** What a controller reported, by queue, in order. */
function watch(queue: string): SummonEventPayload[] {
  const events: SummonEventPayload[] = [];
  jobs.summonController(queue).on("summon", (event) => events.push(event));
  return events;
}

/** One attempt's outcomes, each with its detail where it has one. */
function outcomes(events: SummonEventPayload[]): string[] {
  return events.map((event) =>
    event.detail === undefined
      ? event.outcome
      : `${event.outcome}: ${event.detail}`,
  );
}

/* ------------------------------------------------------------------ */
step("As a summoner: an add summons a real worker through the platform");

const emailEvents = watch("emails");
const emails = jobs.queue("emails");
for (const to of ["ada", "grace", "edsger"]) {
  await emails.add("quick", { to });
}
await waitFor(
  "the summoned worker to register",
  () => emailEvents.some((event) => event.outcome === "registered"),
  WAIT,
);
show("summon events", emailEvents);
const attempt = emailEvents[0]!;
const units = await platform.units();
checkEqual(
  "one attempt, started by the add through Nimbus, then registered by its worker",
  [outcomes(emailEvents), attempt.kind, attempt.reason, attempt.handles],
  [["started", "registered"], "nimbus", "add", ["unit-1"]],
);
show("what Nimbus was sent", runs[0]);
check(
  "Nimbus got the attempt's dedupe key as its token, and its argv as the unit's arguments",
  runs.length === 1 &&
    /^[A-Z0-9-]{1,64}$/i.test(runs[0]!.token) &&
    runs[0]!.args.includes(`--bun-jobs-summon-id=${attempt.id}`) &&
    Bun.deepEquals(units[0]?.argv, runs[0]!.args),
  { runs, units },
);
await waitFor(
  "the three jobs to be done",
  async () => (await emails.count()).completed === 3,
  WAIT,
);
checkEqual(
  "the worker works the queue, then exits 0 once idle",
  [await workers.get("unit-1")?.exited, (await emails.count()).completed],
  [0, 3],
);
const emailStatus = await jobs.summonController("emails").status();
checkEqual(
  "the status names the provider, with the facts less the one holding the token",
  [
    emailStatus.summoner?.provider.name,
    emailStatus.summoner?.provider.kind,
    emailStatus.summoner?.facts,
  ],
  [
    "bun-jobs-provider-nimbus",
    "nimbus",
    { region: "eu-west-1", endpoint: platform.url },
  ],
);
const debugLine = logged.find((event) =>
  event.message.startsWith("nimbus POST /v1/runs"),
);
show("the provider's debug line, as logged", {
  message: debugLine?.message,
  fields: debugLine?.fields,
});
check(
  "its ctx.logger line is logged with the token redacted, in the prose and the header",
  debugLine !== undefined &&
    debugLine.message === "nimbus POST /v1/runs with session [REDACTED]" &&
    !Bun.inspect(debugLine).includes(TOKEN),
  debugLine,
);
await checkRejects(
  "a hand-built summoner is refused: it lacks the brand defineComputeProvider gives",
  () =>
    jobs.summonController("handmade", {
      summoner: {
        provider: emailsNimbus.provider,
        config: emailsNimbus.config,
        ready: emailsNimbus.ready,
        summon: emailsNimbus.summon,
        describe: emailsNimbus.describe,
        validate: emailsNimbus.validate,
      } as unknown as Summoner,
    }),
  { code: "CONFIG", message: /hand-built/ },
);

// From here on the fake starts no process: the units it records stay pending.
platform.onStart(undefined);

/* ------------------------------------------------------------------ */
step(
  "A config that is not ready: a failed attempt, validated again next check",
);

const invoiceEvents = watch("invoices");
const invoices = jobs.summonController("invoices");
await jobs.queue("invoices").add("send", {});
const readsBefore = store.reads;

const down = await invoices.check();
const afterDown = await invoices.status();
const readsAfterDown = store.reads;

store.mode = "slow";
await Bun.sleep(10);
const slowFrom = Date.now();
const slow = await invoices.check();
const slowTook = Date.now() - slowFrom;
const afterSlow = await invoices.status();
const readsAfterSlow = store.reads;

store.mode = "up";
await Bun.sleep(10);
const up = await invoices.check();
show("invoices' attempts", outcomes(invoiceEvents));
checkEqual(
  "the store down: failed with the error's code, counted, and the store read again by the check",
  [
    down.action === "summoned" ? down.outcome : down.action,
    afterDown.last?.detail,
    afterDown.failures,
    readsAfterDown - readsBefore,
  ],
  ["failed", "SecretStoreUnavailable", 1, 1],
);
checkEqual(
  "the store slow: failed with ready timed out, counted, read once more",
  [
    slow.action === "summoned" ? slow.outcome : slow.action,
    afterSlow.last?.detail,
    afterSlow.failures,
    readsAfterSlow - readsAfterDown,
  ],
  ["failed", "ready timed out", 2, 1],
);
check(
  `and not before summonTimeout (${READY_WAIT} ms) had passed`,
  slowTook >= READY_WAIT,
  { slowTook },
);
checkEqual(
  "the store up: the next check validates again and summons, no platform call made before",
  [
    up.action === "summoned" ? up.outcome : up.action,
    outcomes(invoiceEvents),
    runs.length,
  ],
  [
    "started",
    ["failed: SecretStoreUnavailable", "failed: ready timed out", "started"],
    2,
  ],
);
checkEqual(
  "the two not-ready failures in a row are warned about once",
  logged.filter((event) =>
    event.message.startsWith("the summoner's provider is not ready"),
  ).length,
  1,
);

/* ------------------------------------------------------------------ */
step("Provider errors: misconfigured opens the circuit at once");

const exportEvents = watch("exports");
const exportsController = jobs.summonController("exports");
await jobs.queue("exports").add("csv", {});
platform.inject("misconfigured");
const refused = await exportsController.check();
const opened = await exportsController.status();
await Bun.sleep(10);
const heldOpen = await exportsController.check();
show("status()", {
  failures: opened.failures,
  circuitOpenUntil: opened.circuitOpenUntil,
  last: opened.last,
});
checkEqual(
  "one misconfigured answer: failed, failures raised to circuit.failures (3), the next check held back",
  [
    refused.action === "summoned" ? refused.outcome : refused.action,
    opened.failures,
    opened.circuitOpenUntil !== undefined &&
      opened.circuitOpenUntil > Date.now() + 30_000,
    heldOpen.action === "skipped" ? heldOpen.reason : heldOpen.action,
  ],
  ["failed", 3, true, "circuit-open"],
);
checkEqual(
  "its detail is the platform's code, RegionNotFound, on the status and the event",
  [opened.last?.detail, outcomes(exportEvents)],
  ["RegionNotFound", ["failed: RegionNotFound"]],
);
check(
  "and an error names the provider and says the circuit is open at once",
  logged.some(
    (event) =>
      event.level === "error" &&
      event.message.includes("bun-jobs-provider-nimbus") &&
      event.message.includes("PROVIDER_MISCONFIGURED") &&
      event.message.includes("open at once"),
  ),
);

/* ------------------------------------------------------------------ */
step("For contrast, transient: counted once, the circuit still closed");

const reportEvents = watch("reports");
const reportsController = jobs.summonController("reports");
await jobs.queue("reports").add("render", {});
platform.inject("transient");
const flaky = await reportsController.check();
const afterFlaky = await reportsController.status();
checkEqual(
  "a transient answer: failed, one failure of three, the circuit closed",
  [
    flaky.action === "summoned" ? flaky.outcome : flaky.action,
    afterFlaky.failures,
    afterFlaky.circuitOpenUntil ?? null,
  ],
  ["failed", 1, null],
);
checkEqual(
  "the gateway's prose is no code: the detail is PROVIDER_TRANSIENT instead",
  [afterFlaky.last?.detail, outcomes(reportEvents)],
  ["PROVIDER_TRANSIENT", ["failed: PROVIDER_TRANSIENT"]],
);

/* ------------------------------------------------------------------ */
step("throttled: never counted, and the next attempt waits out retryAfterMs");

const thumbEvents = watch("thumbnails");
const thumbs = jobs.summonController("thumbnails");
await jobs.queue("thumbnails").add("resize", {});
// Retry-After: 1 — one second.
platform.inject("throttled", { retryAfterMs: 1_000 });
const throttledFrom = Date.now();
const throttled = await thumbs.check();
const afterThrottle = await thumbs.status();
const tooSoon = await thumbs.check();
// Two more throttles, asking for no wait: the backoff alone then applies.
platform.inject("throttled", { retryAfterMs: 0, times: 2 });
let retriedAt = 0;
await waitFor(
  "the next attempt, once the wait is over",
  async () => {
    const next = await thumbs.check();
    retriedAt = Date.now();
    return next.action === "summoned";
  },
  { timeout: 30_000, interval: 50 },
);
await Bun.sleep(10);
await thumbs.check();
const afterThree = await thumbs.status();
show("status() after three throttles", {
  failures: afterThree.failures,
  circuitOpenUntil: afterThree.circuitOpenUntil,
  last: afterThree.last,
});
checkEqual(
  "throttled: unavailable, no failure counted, and the next check held back",
  [
    throttled.action === "summoned" ? throttled.outcome : throttled.action,
    afterThrottle.failures,
    tooSoon.action === "skipped" ? tooSoon.reason : tooSoon.action,
  ],
  ["unavailable", 0, "backoff"],
);
check(
  "the backoff runs at least retryAfterMs (1,000 ms), and so does the wait for the next attempt",
  (afterThrottle.backoffUntil ?? 0) - throttledFrom >= 1_000 &&
    retriedAt - throttledFrom >= 1_000,
  {
    backoffMs: (afterThrottle.backoffUntil ?? 0) - throttledFrom,
    retriedAfterMs: retriedAt - throttledFrom,
  },
);
checkEqual(
  "three in a row, with circuit.failures 2: still no failure counted, the circuit closed",
  [
    outcomes(thumbEvents),
    afterThree.failures,
    afterThree.circuitOpenUntil ?? null,
  ],
  [
    [
      "unavailable: Throttled",
      "unavailable: Throttled",
      "unavailable: Throttled",
    ],
    0,
    null,
  ],
);
checkEqual(
  "the only sign of it is one warn, once circuit.failures throttles ran in a row",
  logged
    .filter((event) => event.message.startsWith("the platform has throttled"))
    .map((event) => event.message.split(";")[0]),
  ["the platform has throttled 2 summon attempts in a row"],
);

/* ------------------------------------------------------------------ */
step("Conformance: the kit checks the provider against its fake");

// A fake of its own: the kit reads every request the fake received, and
// takes over what starts a unit.
const kit = await nimbusPlatform();
/** A config for a kit fake: a plain token, which the kit swaps for a canary it then looks for. */
function kitConfig(url: string): NimbusInput {
  return { url, region: "eu-west-1", apiToken: "nmb_test_0123456789" };
}
/** Configs the schema must refuse, with the path each issue names. */
function invalidConfigs(url: string) {
  return [
    { config: { url, apiToken: "nmb_test_0123456789" }, path: "region" },
    { config: { region: "eu-west-1", apiToken: "x".repeat(16) }, path: "url" },
  ];
}

await checkRejects(
  "the kit refuses the memory driver up front: its handoff needs two processes",
  () =>
    runProviderConformance(nimbus, {
      config: kitConfig(kit.platform.url),
      platform: kit.platform,
      driver: { type: "memory" },
    }),
  { code: "CONFIG", message: /cannot be shared with another process/ },
);
const report = await runProviderConformance(nimbus, {
  config: kitConfig(kit.platform.url),
  invalidConfigs: invalidConfigs(kit.platform.url),
  platform: kit.platform,
  driver: config,
});
/** The ids of a report's checks with `status`. */
function idsWith(
  checks: typeof report.checks,
  status: "pass" | "fail" | "warn" | "skip",
): string[] {
  return checks.filter((one) => one.status === status).map((one) => one.id);
}
const statusOf = Object.fromEntries(
  report.checks.map((one) => [one.id, one.status]),
);
show(report.subject, {
  passed: idsWith(report.checks, "pass").length,
  failed: idsWith(report.checks, "fail"),
  warned: idsWith(report.checks, "warn"),
  skipped: idsWith(report.checks, "skip"),
});
const sample = [
  "summon.routing.through-ctx-fetch",
  "summon.dedupe.same-key-one-unit",
  "summon.errors.auth",
  "summon.errors.throttled",
  "summon.timeouts.rejects-on-abort",
  "summon.secrets.no-leak",
  "summon.handoff.released",
  "summon.cas.one-call",
];
show(
  "a few of its checks",
  sample.map((id) => `${id}: ${statusOf[id]}`),
);
checkEqual(
  "it conforms: no check failed, among them routing, dedupe, the error kinds, secrets and the handoff",
  [report.ok, idsWith(report.checks, "fail"), sample.map((id) => statusOf[id])],
  [true, [], sample.map(() => "pass")],
);
checkEqual(
  "one should warns: the gateway's prose as a platformCode",
  idsWith(report.checks, "warn"),
  ["summon.errors.platform-code"],
);
let conformed = true;
try {
  assertConformance(report);
} catch {
  conformed = false;
}
check("assertConformance passes: a should warning never fails it", conformed);

/* ------------------------------------------------------------------ */
step("A provider that calls the global fetch does not conform");

const brokenKit = await nimbusPlatform();
const broken = await runProviderConformance(
  defineNimbus({ globalFetch: true }),
  {
    config: kitConfig(brokenKit.platform.url),
    invalidConfigs: invalidConfigs(brokenKit.platform.url),
    platform: brokenKit.platform,
    driver: config,
  },
);
const brokenFailed = broken.checks.filter((one) => one.status === "fail");
show(
  "failed",
  brokenFailed.map((one) => `${one.id}: ${one.detail}`),
);
checkEqual(
  "exactly the routing check fails",
  [broken.ok, brokenFailed.map((one) => one.id)],
  [false, ["summon.routing.through-ctx-fetch"]],
);
const thrown = await checkRejects(
  "assertConformance throws CONFORMANCE_FAILED, naming it",
  () => assertConformance(broken),
  { code: "CONFORMANCE_FAILED", message: /summon\.routing\.through-ctx-fetch/ },
);
checkEqual(
  "its context lists the failed ids",
  thrown instanceof JobsError ? thrown.context : undefined,
  { failed: ["summon.routing.through-ctx-fetch"] },
);

/* ------------------------------------------------------------------ */
step("Clean up");

// Releases the read the timeout left waiting: its late answer changes nothing.
store.held.resolve();
check(
  "no log line, from any step, carries the token",
  !Bun.inspect(logged).includes(TOKEN),
);
// The one worker the fake started has exited on its own by now. One still
// running means a check above went wrong: it is stopped here.
const running = [...children].filter(
  (child) => child.exitCode === null && child.signalCode === null,
);
checkEqual("every worker the platform started has exited", running.length, 0);
for (const child of running) {
  child.kill("SIGKILL");
}
await platform.close();
await kit.platform.close();
await brokenKit.platform.close();
await jobs.purge();
await jobs.close();
summary();
