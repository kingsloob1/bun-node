import type { SummonResult } from "../../summon/types";
import type { ProviderCallContext } from "../context";
import type { ProviderCheck, SummonCapabilities } from "../define";
import type { ProviderErrorKind } from "../errors";
import type { FactProblem } from "../redact";
import type { FakePlatform, FakeRequestRecord } from "./fake";
import type { KitRun } from "./run";
import { SUMMON_ARGS } from "../../summon/args";
import { CODE_SHAPED } from "../../summon/controller";
import { dedupeKeyFor } from "../../summon/marker";
import { ProviderError, providerErrorFacts } from "../errors";
import { factProblem } from "../redact";
import { describeThrown, DIRECT_QUEUE, KIT_TIMERS } from "./run";
import { trackTimers } from "./scan";

/**
 * The summon kit's direct check groups (plugins §12.2): each calls the facet
 * with the kit's context, against the fake, and reads what the fake saw.
 * Internal; `runProviderConformance` runs them in order.
 */

/** A positive whole number. */
function positiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Whether a character-class body compiles, and the printable ASCII it allows. */
function charsetOf(charset: string): string[] | undefined {
  let pattern: RegExp;
  try {
    pattern = new RegExp(`^[${charset}]$`);
  } catch {
    return undefined;
  }
  const allowed: string[] = [];
  for (let code = 0x21; code <= 0x7e; code++) {
    const char = String.fromCharCode(code);
    if (pattern.test(char)) {
      allowed.push(char);
    }
  }
  return allowed;
}

/** What is wrong with a declaration, or `undefined` when it is well-formed. */
function malformed(capabilities: SummonCapabilities): string | undefined {
  const c = capabilities as Partial<SummonCapabilities>;
  if (!["launch", "scale", "wake"].includes(c.style as string)) {
    return `style is ${JSON.stringify(c.style)}`;
  }
  if (!["argv", "none"].includes(c.passes as string)) {
    return `passes is ${JSON.stringify(c.passes)}`;
  }
  if (!positiveInt(c.bootBudgetMs)) {
    return "bootBudgetMs is not a positive whole number";
  }
  const shutdown = c.shutdown;
  if (
    typeof shutdown !== "object" ||
    shutdown === null ||
    !["SIGTERM", "SIGINT", "none"].includes(shutdown.signal) ||
    !Number.isSafeInteger(shutdown.graceMs) ||
    shutdown.graceMs < 0
  ) {
    return "shutdown is not { signal, graceMs }";
  }
  if (
    shutdown.graceMaxMs !== undefined &&
    (!Number.isSafeInteger(shutdown.graceMaxMs) ||
      shutdown.graceMaxMs < shutdown.graceMs)
  ) {
    return "shutdown.graceMaxMs is below graceMs";
  }
  if (c.maxLifetimeMs !== null && !positiveInt(c.maxLifetimeMs)) {
    return "maxLifetimeMs is neither null nor a positive whole number";
  }
  if (typeof c.enforcesLifetime !== "boolean") {
    return "enforcesLifetime is not a boolean";
  }
  if (c.maxCountPerCall !== undefined && !positiveInt(c.maxCountPerCall)) {
    return "maxCountPerCall is not a positive whole number";
  }
  if (c.poolSize !== undefined && !positiveInt(c.poolSize)) {
    return "poolSize is not a positive whole number";
  }
  const dedupe = c.dedupe;
  if (typeof dedupe !== "object" || dedupe === null) {
    return "dedupe is missing";
  }
  if (dedupe.kind === "token" || dedupe.kind === "name") {
    if (!positiveInt(dedupe.maxLength)) {
      return "dedupe.maxLength is not a positive whole number";
    }
    if (typeof dedupe.charset !== "string" || dedupe.charset === "") {
      return "dedupe.charset is not a character-class body";
    }
    if (dedupe.kind === "token") {
      if (typeof dedupe.scope !== "string" || dedupe.scope === "") {
        return "dedupe.scope is not a string";
      }
      if (typeof dedupe.strict !== "boolean") {
        return "dedupe.strict is not a boolean";
      }
      if (dedupe.ttlMs !== undefined && !positiveInt(dedupe.ttlMs)) {
        return "dedupe.ttlMs is not a positive whole number";
      }
    }
  } else if (dedupe.kind !== "none") {
    return `dedupe.kind is ${JSON.stringify((dedupe as { kind?: unknown }).kind)}`;
  }
  return undefined;
}

/** The capabilities group: the declaration is one a controller can act on. */
export function capabilityChecks(
  run: KitRun,
  limits: FakePlatform["limits"],
): void {
  const { capabilities, facet } = run;
  const problem = malformed(capabilities);
  run.set(
    "summon.capabilities.well-formed",
    problem === undefined ? "pass" : "fail",
    problem,
  );

  if (capabilities.style === "scale") {
    run.set(
      "summon.capabilities.scale-has-release",
      typeof facet.release === "function" ? "pass" : "fail",
      typeof facet.release === "function"
        ? undefined
        : "style is scale but the facet has no release(): nothing could set the count back to zero",
    );
  } else {
    run.set(
      "summon.capabilities.scale-has-release",
      "skip",
      `style is ${capabilities.style}`,
    );
  }

  if (capabilities.style === "wake") {
    run.set(
      "summon.capabilities.wake-has-pool-size",
      positiveInt(capabilities.poolSize) ? "pass" : "fail",
      positiveInt(capabilities.poolSize)
        ? undefined
        : "style is wake but poolSize is not declared",
    );
  } else {
    run.set(
      "summon.capabilities.wake-has-pool-size",
      "skip",
      `style is ${capabilities.style}`,
    );
  }

  const dedupe = capabilities.dedupe;
  if (dedupe.kind === "none") {
    run.set(
      "summon.capabilities.dedupe-charset",
      "skip",
      "dedupe kind is none",
    );
  } else {
    const allowed =
      typeof dedupe.charset === "string"
        ? charsetOf(dedupe.charset)
        : undefined;
    run.set(
      "summon.capabilities.dedupe-charset",
      allowed !== undefined && allowed.length > 0 ? "pass" : "fail",
      allowed === undefined
        ? `dedupe.charset ${JSON.stringify(dedupe.charset)} does not compile as a character class`
        : allowed.length === 0
          ? "dedupe.charset allows no printable character"
          : undefined,
    );
  }

  const findings: string[] = [];
  if (limits === undefined) {
    run.set(
      "summon.capabilities.platform-limits",
      "skip",
      "the fake declares no limits",
    );
  } else {
    if (
      limits.tokenMaxLength !== undefined &&
      dedupe.kind !== "none" &&
      dedupe.maxLength > limits.tokenMaxLength
    ) {
      findings.push(
        `dedupe.maxLength ${dedupe.maxLength} is above the platform's ${limits.tokenMaxLength}`,
      );
    }
    if (limits.maxDurationMs !== undefined) {
      if (capabilities.maxLifetimeMs === null) {
        findings.push(
          `maxLifetimeMs is null, but the platform caps a unit at ${limits.maxDurationMs} ms`,
        );
      } else if (capabilities.maxLifetimeMs > limits.maxDurationMs) {
        findings.push(
          `maxLifetimeMs ${capabilities.maxLifetimeMs} is above the platform's ${limits.maxDurationMs}`,
        );
      }
    }
    run.set(
      "summon.capabilities.platform-limits",
      findings.length === 0 ? "pass" : "fail",
      findings.length === 0 ? undefined : findings.join("; "),
    );
  }
}

/** How the describe check words each reason a fact would be dropped. */
const FACT_PROBLEMS: Readonly<Record<FactProblem, string>> = {
  "credential-key": "is named like a credential",
  "url-userinfo": "holds a URL with credentials in it",
  "credential-shape":
    "holds a credential shape the redactor knows (Bearer, a JWT, a sensitive word before : or =)",
};

/**
 * The describe group (should): facts are strings, none named like a
 * credential, none holding a URL with userinfo and none holding another
 * credential shape the pattern redactor knows — what the status route would
 * drop, by the same rule ({@link factProblem}).
 */
export function describeChecks(run: KitRun): void {
  let facts: Readonly<Record<string, string>>;
  try {
    facts = run.summoner.describe();
  } catch (error) {
    run.set(
      "summon.describe.facts",
      "fail",
      `describe() threw ${describeThrown(error)}`,
    );
    return;
  }
  run.scanned.push(facts);
  const problems: string[] = [];
  for (const [key, value] of Object.entries(facts)) {
    if (typeof value !== "string") {
      problems.push(`${key} is not a string`);
    }
    // The status route's own rule (`factProblem`, which `isServableFact`
    // calls), so the kit warns about exactly the facts it drops.
    const problem =
      typeof value === "string" ? factProblem(key, value) : undefined;
    if (problem !== undefined) {
      problems.push(`${key} ${FACT_PROBLEMS[problem]}`);
    }
  }
  run.set(
    "summon.describe.facts",
    problems.length === 0 ? "pass" : "fail",
    problems.length === 0 ? undefined : problems.join("; "),
  );
}

/** The validate group: passes against the healthy fake, fails with `auth` injected, starts nothing. */
export async function validateChecks(
  run: KitRun,
  validate:
    | ((context: ProviderCallContext) => Promise<readonly ProviderCheck[]>)
    | undefined,
): Promise<void> {
  if (validate === undefined) {
    for (const id of [
      "summon.validate.healthy",
      "summon.validate.auth-fails",
      "summon.validate.starts-nothing",
    ]) {
      run.set(id, "skip", "the provider has no validate()");
    }
    return;
  }
  const before = run.unitCount();
  run.internals.clearFaults();
  const healthy = await run.call(async (context) => await validate(context));
  if (!healthy.ok) {
    run.set(
      "summon.validate.healthy",
      "fail",
      `validate() threw ${describeThrown(healthy.error)} against the healthy fake`,
    );
  } else {
    const failed = healthy.value.filter((check) => check.status === "fail");
    run.set(
      "summon.validate.healthy",
      failed.length === 0 ? "pass" : "fail",
      failed.length === 0
        ? undefined
        : `validate() reported ${failed.map((check) => check.id).join(", ")} failing against the healthy fake`,
    );
  }

  run.platform.inject("auth", { times: 5 });
  const rejected = await run.call(async (context) => await validate(context));
  run.internals.clearFaults();
  run.set(
    "summon.validate.auth-fails",
    !rejected.ok || rejected.value.some((check) => check.status === "fail")
      ? "pass"
      : "fail",
    !rejected.ok || rejected.value.some((check) => check.status === "fail")
      ? undefined
      : "validate() reported no failure while the fake answered every call as auth",
  );
  const started = run.unitCount() - before;
  run.set(
    "summon.validate.starts-nothing",
    started === 0 ? "pass" : "fail",
    started === 0 ? undefined : `validate() started ${started} unit(s)`,
  );
}

/** The requests the fake received from index `from` on. */
function requestsSince(run: KitRun, from: number): FakeRequestRecord[] {
  return run.internals.requests.slice(from);
}

/** A result's handles, or `[]`. */
function handlesOf(result: SummonResult): string[] {
  return "handles" in result && Array.isArray(result.handles)
    ? result.handles
    : [];
}

/** The dedupe group: the token sent is the key, and the same key starts one unit. */
export async function dedupeChecks(run: KitRun): Promise<void> {
  const { dedupe } = run.capabilities;
  if (dedupe.kind === "none") {
    run.set("summon.dedupe.token-is-key", "skip", "dedupe kind is none");
    run.set("summon.dedupe.same-key-one-unit", "skip", "dedupe kind is none");
    return;
  }
  // A request id whose key is at the maximum length and uses every character
  // the declaration allows.
  const allowed = charsetOf(dedupe.charset) ?? [];
  let body = "";
  while (allowed.length > 0 && body.length < dedupe.maxLength) {
    body += allowed[body.length % allowed.length];
  }
  const id = `sm_${body}`;
  const request = run.request({ id });
  const key = dedupeKeyFor(dedupe)(id);

  const tokensBefore = run.internals.tokens.length;
  const unitsBefore = run.unitCount();
  const first = await run.call(
    async (context) => await run.facet.summon(request, context),
  );
  const sent = run.internals.tokens.slice(tokensBefore);
  if (!first.ok) {
    run.set(
      "summon.dedupe.token-is-key",
      "fail",
      `summon threw ${describeThrown(first.error)} for a ${key.length}-character key`,
    );
  } else if (sent.length === 0) {
    run.set(
      "summon.dedupe.token-is-key",
      "fail",
      "the fake saw no token: its route must pass the platform's token to start() or recall()",
    );
  } else {
    const wrong = sent.filter((token) => token !== key);
    run.set(
      "summon.dedupe.token-is-key",
      wrong.length === 0 ? "pass" : "fail",
      wrong.length === 0
        ? undefined
        : `sent a ${wrong[0]!.length}-character token that is not request.dedupeKey (${key.length} characters; maxLength ${dedupe.maxLength})`,
    );
  }

  const unitsAfterFirst = run.unitCount();
  const second = await run.call(
    async (context) => await run.facet.summon(request, context),
  );
  const startedBySecond = run.unitCount() - unitsAfterFirst;
  if (!first.ok || !second.ok) {
    run.set(
      "summon.dedupe.same-key-one-unit",
      "fail",
      `summon threw ${describeThrown(second.ok ? (first as { error: unknown }).error : second.error)}`,
    );
  } else if (
    startedBySecond !== 0 ||
    // A scale platform answers a repeated count as it did the first.
    (run.capabilities.style !== "scale" &&
      !["deduped", "already-running"].includes(second.value.status))
  ) {
    run.set(
      "summon.dedupe.same-key-one-unit",
      "fail",
      `the second call with one key answered ${second.value.status} and started ${startedBySecond} more unit(s) (first started ${unitsAfterFirst - unitsBefore})`,
    );
  } else {
    run.set("summon.dedupe.same-key-one-unit", "pass");
  }
}

/** A request record, less what a platform requires to vary: date and signature headers. */
function comparable(record: FakeRequestRecord): string {
  const headers = Object.entries(record.headers)
    .filter(
      ([name, value]) =>
        !/^(?:date|x-date|x-amz-date|x-ms-date|x-goog-date)$/.test(name) &&
        !(name === "authorization" && /signature=/i.test(value)),
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([record.method, record.path, headers, record.body]);
}

/** The purity group: one request twice gives byte-identical platform requests. */
export async function purityChecks(run: KitRun): Promise<void> {
  const request = run.request();
  const from = run.internals.requests.length;
  const first = await run.call(
    async (context) => await run.facet.summon(request, context),
  );
  const middle = run.internals.requests.length;
  const second = await run.call(
    async (context) => await run.facet.summon(request, context),
  );
  const one = requestsSince(run, from).slice(0, middle - from);
  const two = requestsSince(run, middle);
  if (!first.ok || !second.ok) {
    run.set(
      "summon.purity.identical-requests",
      "fail",
      `summon threw ${describeThrown(first.ok ? (second as { error: unknown }).error : first.error)}`,
    );
    return;
  }
  // The first call of each is the one that must match: a deduped second
  // call may legitimately stop after it.
  const a = one[0];
  const b = two[0];
  if (a === undefined || b === undefined) {
    run.set(
      "summon.purity.identical-requests",
      "fail",
      "a call made no platform request",
    );
    return;
  }
  run.set(
    "summon.purity.identical-requests",
    comparable(a) === comparable(b) ? "pass" : "fail",
    comparable(a) === comparable(b)
      ? undefined
      : `two calls for one request sent different ${a.method} ${a.path} requests: ${difference(a, b)}`,
  );
}

/** Which part of two requests differs. */
function difference(a: FakeRequestRecord, b: FakeRequestRecord): string {
  if (a.method !== b.method || a.path !== b.path) {
    return "method or URL";
  }
  if (a.body !== b.body) {
    return "body";
  }
  return "headers";
}

/** The concurrency group: distinct ids start distinct units; one id starts one. */
export async function concurrencyChecks(run: KitRun): Promise<void> {
  const { style, dedupe, passes } = run.capabilities;
  if (style === "scale") {
    run.set(
      "summon.concurrency.distinct-ids",
      "skip",
      "style is scale: it sets a count (see summon.scale)",
    );
  } else {
    const n =
      style === "wake" ? Math.min(16, run.capabilities.poolSize ?? 16) : 16;
    const requests = Array.from({ length: n }, () => run.request());
    const before = run.unitCount();
    const outcomes = await Promise.all(
      requests.map(
        async (request) =>
          await run.call(
            async (context) => await run.facet.summon(request, context),
          ),
      ),
    );
    const thrown = outcomes.find((outcome) => !outcome.ok);
    const started = run.unitCount() - before;
    const problems: string[] = [];
    if (thrown !== undefined) {
      problems.push(
        `a call threw ${describeThrown((thrown as { error: unknown }).error)}`,
      );
    }
    if (started !== n) {
      problems.push(`${n} concurrent calls started ${started} units`);
    }
    if (thrown === undefined && passes === "argv") {
      // Each call's handles must name the unit its own request started.
      outcomes.forEach((outcome, index) => {
        const request = requests[index]!;
        const result = (outcome as { value: SummonResult }).value;
        for (const handle of handlesOf(result)) {
          const unit = run.internals.unit(handle);
          const carried = unit?.argv.find((arg) =>
            arg.startsWith(`${SUMMON_ARGS.id}=`),
          );
          // A unit carrying another request's id: its handles were crossed.
          // (One carrying none is the handoff's to find.)
          if (
            carried !== undefined &&
            carried !== `${SUMMON_ARGS.id}=${request.id}`
          ) {
            problems.push(
              `call ${index + 1} answered handle ${handle}, a unit started with another request's arguments`,
            );
          }
        }
      });
    }
    run.set(
      "summon.concurrency.distinct-ids",
      problems.length === 0 ? "pass" : "fail",
      problems.length === 0 ? undefined : problems.slice(0, 3).join("; "),
    );
  }

  if (style === "scale") {
    run.set(
      "summon.concurrency.same-id-one-unit",
      "skip",
      "style is scale: it sets a count (see summon.scale)",
    );
    return;
  }
  if (dedupe.kind === "none") {
    run.set(
      "summon.concurrency.same-id-one-unit",
      "skip",
      "dedupe kind is none",
    );
    return;
  }
  const request = run.request();
  const before = run.unitCount();
  const outcomes = await Promise.all(
    Array.from(
      { length: 8 },
      async () =>
        await run.call(
          async (context) => await run.facet.summon(request, context),
        ),
    ),
  );
  const thrown = outcomes.find((outcome) => !outcome.ok);
  const started = run.unitCount() - before;
  run.set(
    "summon.concurrency.same-id-one-unit",
    thrown === undefined && started === 1 ? "pass" : "fail",
    thrown !== undefined
      ? `a call threw ${describeThrown((thrown as { error: unknown }).error)}`
      : started === 1
        ? undefined
        : `8 concurrent calls with one id started ${started} units`,
  );
}

/** The status group: `status` knows the handles `summon` answered; `cancel` stops a pending unit. */
export async function statusChecks(run: KitRun): Promise<void> {
  const { status, cancel } = run.facet;
  if (status === undefined && cancel === undefined) {
    run.set("summon.status.knows-handles", "skip", "the facet has no status()");
    run.set(
      "summon.status.cancel-stops-pending",
      "skip",
      "the facet has no cancel()",
    );
    return;
  }
  const request = run.request();
  const summoned = await run.call(
    async (context) => await run.facet.summon(request, context),
  );
  const handles = summoned.ok ? handlesOf(summoned.value) : [];
  if (!summoned.ok || handles.length === 0) {
    const detail = summoned.ok
      ? "summon answered no handles"
      : `summon threw ${describeThrown(summoned.error)}`;
    run.set(
      "summon.status.knows-handles",
      summoned.ok ? "skip" : "fail",
      detail,
    );
    run.set(
      "summon.status.cancel-stops-pending",
      summoned.ok ? "skip" : "fail",
      detail,
    );
    return;
  }

  if (status === undefined) {
    run.set("summon.status.knows-handles", "skip", "the facet has no status()");
  } else {
    const answer = await run.call(
      async (context) => await status(handles, context),
    );
    if (!answer.ok) {
      run.set(
        "summon.status.knows-handles",
        "fail",
        `status() threw ${describeThrown(answer.error)}`,
      );
    } else {
      const unknown = handles.filter(
        (handle) =>
          !answer.value.some(
            (unit) => unit.handle === handle && unit.state !== "unknown",
          ),
      );
      run.set(
        "summon.status.knows-handles",
        unknown.length === 0 ? "pass" : "fail",
        unknown.length === 0
          ? undefined
          : `status() did not know ${unknown.length} of ${handles.length} handle(s) summon had just answered`,
      );
    }
  }

  if (cancel === undefined) {
    run.set(
      "summon.status.cancel-stops-pending",
      "skip",
      "the facet has no cancel()",
    );
    return;
  }
  const cancelled = await run.call(
    async (context) => await cancel(handles, context),
  );
  const still = handles.filter(
    (handle) => run.internals.unit(handle)?.state !== "exited",
  );
  let reported: string | undefined;
  if (cancelled.ok && still.length === 0 && status !== undefined) {
    const answer = await run.call(
      async (context) => await status(handles, context),
    );
    if (
      !answer.ok ||
      answer.value.some(
        (unit) => unit.state === "pending" || unit.state === "running",
      )
    ) {
      reported = "status() still reports a cancelled unit as live";
    }
  }
  run.set(
    "summon.status.cancel-stops-pending",
    cancelled.ok && still.length === 0 && reported === undefined
      ? "pass"
      : "fail",
    !cancelled.ok
      ? `cancel() threw ${describeThrown(cancelled.error)}`
      : still.length > 0
        ? `cancel() left ${still.length} of ${handles.length} pending unit(s) running on the fake`
        : reported,
  );
}

/** The scale group: a target set twice is one count; release sets zero. */
export async function scaleChecks(run: KitRun): Promise<void> {
  const { release } = run.facet;
  const live = (): number => run.internals.liveCount();
  // Start from zero, so the count read afterwards is this group's.
  const before = live();
  if (before > 0 && release !== undefined) {
    await run.call(
      async (context) =>
        await release(
          { namespace: run.namespace, queue: DIRECT_QUEUE, target: 0 },
          context,
        ),
    );
  }
  const base = live();
  const first = await run.call(
    async (context) =>
      await run.facet.summon(run.request({ count: 2, target: 2 }), context),
  );
  const second = await run.call(
    async (context) =>
      await run.facet.summon(run.request({ count: 2, target: 2 }), context),
  );
  const counted = live() - base;
  run.set(
    "summon.scale.target-idempotent",
    first.ok && second.ok && counted === 2 ? "pass" : "fail",
    !first.ok || !second.ok
      ? `summon threw ${describeThrown(first.ok ? (second as { error: unknown }).error : first.error)}`
      : counted === 2
        ? undefined
        : `summon with target 2, twice, left a count of ${counted}`,
  );
  if (release === undefined) {
    run.set(
      "summon.scale.release-to-zero",
      "fail",
      "the facet has no release()",
    );
    return;
  }
  const released = await run.call(
    async (context) =>
      await release(
        { namespace: run.namespace, queue: DIRECT_QUEUE, target: 0 },
        context,
      ),
  );
  run.set(
    "summon.scale.release-to-zero",
    released.ok && live() === 0 ? "pass" : "fail",
    !released.ok
      ? `release() threw ${describeThrown(released.error)}`
      : live() === 0
        ? undefined
        : `release({ target: 0 }) left a count of ${live()}`,
  );
}

/** The lifetime group: with `enforcesLifetime`, the request carries `maxLifetimeMs`. */
export async function lifetimeChecks(run: KitRun): Promise<void> {
  if (!run.capabilities.enforcesLifetime) {
    run.set("summon.lifetime.enforced", "skip", "enforcesLifetime is false");
    return;
  }
  // A figure no other field would carry by chance.
  const cap = run.capabilities.maxLifetimeMs;
  const lifetime = cap === null ? 5_432_000 : Math.min(5_432_000, cap);
  const from = run.internals.requests.length;
  const outcome = await run.call(
    async (context) =>
      await run.facet.summon(run.request({ maxLifetimeMs: lifetime }), context),
  );
  const forms = new Set([
    String(lifetime),
    String(Math.floor(lifetime / 1_000)),
    String(Math.ceil(lifetime / 1_000)),
  ]);
  // The summon argument carries the figure too; only the platform's own
  // field counts, so that argument is taken out first.
  const argument = `${SUMMON_ARGS.maxLifetimeMs}=${lifetime}`;
  const strip = (text: string): string =>
    text.replaceAll(argument, "").replaceAll(encodeURIComponent(argument), "");
  const carried = requestsSince(run, from).some((record) =>
    [...forms].some(
      (form) =>
        strip(record.body).includes(form) ||
        strip(record.path).includes(form) ||
        Object.values(record.headers).some((value) =>
          strip(value).includes(form),
        ),
    ),
  );
  run.set(
    "summon.lifetime.enforced",
    outcome.ok && carried ? "pass" : "fail",
    !outcome.ok
      ? `summon threw ${describeThrown(outcome.error)}`
      : carried
        ? undefined
        : `no platform request carried maxLifetimeMs ${lifetime} (as ms or seconds)`,
  );
}

/** The faults the errors group injects: each `ProviderErrorKind`, and a 200 with no capacity. */
const ERROR_FAULTS: readonly (ProviderErrorKind | "capacity-200")[] = [
  "transient",
  "throttled",
  "quota",
  "auth",
  "misconfigured",
  "conflict",
  "capacity-200",
];

/** "a" or "an", for a fault's name. */
function article(fault: string): string {
  return /^[aeiou]/.test(fault) ? "an" : "a";
}

/** The wait the fake asks a throttled answer for, in ms: well above the verdict controller's own backoff. */
export const RETRY_AFTER_MS = 2_000;

/** What a real controller made of one fault, from one check (`handoff.ts`). */
export interface ControllerVerdict {
  /** The check's outcome, or its action when it summoned nothing. */
  outcome: string;
  /** `status().failures` after it. */
  failures: number;
  /** Whether the circuit is open after it. */
  circuitOpen: boolean;
  /** How long from the check's start its backoff runs, in ms (`0` when none). */
  backoffMs: number;
  /** `status().last.detail` after it, when there is one. */
  detail?: string;
}

/**
 * The policy the verdict controller runs under (`verdictProbe` in
 * `handoff.ts`): a backoff of 100 ms, so the platform's retry-after is what a
 * throttled or quota backoff must honour, and a circuit reset of 10 minutes,
 * which with the backoff bounds the controller's clamp on a retry-after.
 */
export const VERDICT_POLICY = {
  /** `backoff.initial` and `backoff.max`, in ms. */
  backoffMs: 100,
  /** `circuit.failures`. */
  circuitFailures: 5,
  /** `circuit.resetAfter`, in ms. */
  resetAfterMs: 600_000,
} as const;

/** The longest wait the verdict controller may take: the larger of `backoff.max` and `circuit.resetAfter`. */
const LONGEST_WAIT_MS = Math.max(
  VERDICT_POLICY.backoffMs,
  VERDICT_POLICY.resetAfterMs,
);

/** Slack on a measured backoff, in ms: the check's own duration. */
const BACKOFF_SLACK_MS = 1_000;

/** The longest wait a provider may sanely ask for, in ms: a day. */
const MAX_SANE_RETRY_AFTER_MS = 86_400_000;

/** Runs one check of a real controller with a fault injected, or says why it cannot. */
export type VerdictProbe = (
  fault: ProviderErrorKind | "capacity-200",
) => Promise<ControllerVerdict | string>;

/**
 * What the controller must make of each kind (plugins §6.5, as PR-p2 built
 * it), for one attempt under a circuit of 5 and a 100 ms backoff: an empty
 * answer means it did.
 */
function verdictProblems(
  fault: ProviderErrorKind | "capacity-200",
  verdict: ControllerVerdict,
  /** The retry-after the provider's error carried, if any. */
  carried: number | undefined,
): string[] {
  const problems: string[] = [];
  const expectOutcome = (outcome: string): void => {
    if (verdict.outcome !== outcome) {
      problems.push(
        `the controller recorded ${verdict.outcome}, not ${outcome}`,
      );
    }
  };
  const expectCounted = (counted: boolean): void => {
    if (counted !== verdict.failures > 0) {
      problems.push(
        counted
          ? "the controller did not count it toward the circuit"
          : `the controller counted it toward the circuit (failures ${verdict.failures})`,
      );
    }
  };
  const expectOpen = (open: boolean): void => {
    if (open !== verdict.circuitOpen) {
      problems.push(
        open
          ? "the controller did not open the circuit at once"
          : "the controller opened the circuit",
      );
    }
  };
  // At least the platform's wait, and never past the clamp.
  const expectBackoff = (atLeast: boolean): void => {
    if (atLeast && verdict.backoffMs < RETRY_AFTER_MS - 50) {
      problems.push(
        `the controller backed off ${verdict.backoffMs} ms, under the platform's retry-after of ${RETRY_AFTER_MS} ms`,
      );
    }
    if (verdict.backoffMs > LONGEST_WAIT_MS + BACKOFF_SLACK_MS) {
      problems.push(
        `the controller backed off ${verdict.backoffMs} ms, past its clamp of ${LONGEST_WAIT_MS} ms (the larger of backoff.max and circuit.resetAfter)`,
      );
    }
  };
  switch (fault) {
    case "throttled":
      expectOutcome("unavailable");
      expectCounted(false);
      expectOpen(false);
      expectBackoff(true);
      break;
    case "quota":
      expectOutcome("unavailable");
      expectCounted(true);
      expectOpen(false);
      expectBackoff(carried !== undefined);
      break;
    case "auth":
    case "misconfigured":
      expectOutcome("failed");
      expectOpen(true);
      break;
    case "conflict":
    case "transient":
      expectOutcome("failed");
      expectCounted(true);
      expectOpen(false);
      break;
    case "capacity-200":
      expectOutcome("unavailable");
      break;
  }
  return problems;
}

/**
 * The errors group. For each fault the fake injects:
 *
 * - **the provider's answer**: a thrown `ProviderError` (an `instanceof`,
 *   not a look-alike) of that kind, `throttled` carrying `retryAfterMs` (and
 *   `quota` when it does) between half the platform's wait and a day; and
 *   `unavailable`, returned, for a 200 with no capacity;
 * - **the controller's verdict** on it, from one check of a real
 *   `SummonController` (when `probe` is given): `throttled` is `unavailable`,
 *   not counted, and backs off at least the platform's retry-after but no
 *   longer than its clamp; `quota` is `unavailable` and counted, with the
 *   same bounds when it carried one; `auth` and `misconfigured` are `failed` and
 *   open the circuit at once; `conflict` and `transient` are `failed` and
 *   counted. A plain throw is `transient` to the controller, and fails the
 *   provider's half: it must map the failure.
 */
export async function errorChecks(
  run: KitRun,
  probe: VerdictProbe | undefined,
  probeSkipped?: string,
): Promise<void> {
  /** Every ProviderError the group's faults produced, for the platform-code check. */
  const thrown: ProviderError[] = [];
  for (const fault of ERROR_FAULTS) {
    const id = `summon.errors.${fault}`;
    if (!run.wanted(id)) {
      continue;
    }
    run.internals.clearFaults();
    run.platform.inject(fault, { times: 5, retryAfterMs: RETRY_AFTER_MS });
    const outcome = await run.call(
      async (context) => await run.facet.summon(run.request(), context),
    );
    const consumed = run.internals.pendingFaults() < 5;
    run.internals.clearFaults();
    const problems: string[] = [];
    if (!consumed) {
      problems.push("the provider made no platform request");
    } else if (fault === "capacity-200") {
      if (!outcome.ok) {
        problems.push(
          `a 200 with no capacity threw ${describeThrown(outcome.error)}: it is an answer, not an error`,
        );
      } else if (outcome.value.status !== "unavailable") {
        problems.push(
          `a 200 with no capacity answered ${outcome.value.status}, not unavailable`,
        );
      }
    } else if (outcome.ok) {
      problems.push(
        `${article(fault)} ${fault} fault answered ${outcome.value.status} instead of throwing ProviderError(${fault})`,
      );
    } else if (!(outcome.error instanceof ProviderError)) {
      problems.push(
        providerErrorFacts(outcome.error) === undefined
          ? `${article(fault)} ${fault} fault threw ${describeThrown(outcome.error)}, not a ProviderError: map it (a plain throw is transient to the controller)`
          : `${article(fault)} ${fault} fault threw ${describeThrown(outcome.error)}, shaped like a ProviderError but not one: throw the class from ./provider`,
      );
    } else if (outcome.error.kind !== fault) {
      problems.push(
        `${article(fault)} ${fault} fault threw ProviderError(${outcome.error.kind})`,
      );
    } else if (fault === "throttled" || fault === "quota") {
      // Throttled must carry the platform's wait; quota may, and then sanely.
      const wait = outcome.error.retryAfterMs;
      if (wait === undefined || wait <= 0) {
        if (fault === "throttled") {
          problems.push(
            "ProviderError(throttled) carries no retryAfterMs though the platform sent one",
          );
        }
      } else if (wait < RETRY_AFTER_MS / 2) {
        problems.push(
          `ProviderError(${fault}) carries retryAfterMs ${wait}, far under the platform's ${RETRY_AFTER_MS} ms (a Retry-After is in seconds)`,
        );
      } else if (wait > MAX_SANE_RETRY_AFTER_MS) {
        problems.push(
          `ProviderError(${fault}) carries retryAfterMs ${wait}, over a day for a platform that asked ${RETRY_AFTER_MS} ms (the controller clamps it)`,
        );
      }
    }
    if (outcome.ok === false && outcome.error instanceof ProviderError) {
      thrown.push(outcome.error);
    }

    let verdictNote: string | undefined;
    if (consumed && probe !== undefined) {
      run.platform.inject(fault, { times: 5, retryAfterMs: RETRY_AFTER_MS });
      const verdict = await probe(fault);
      run.internals.clearFaults();
      // When the provider's own answer was already wrong, what the
      // controller then did follows from it: context, not a second fault.
      const answered = problems.length === 0;
      const said = (text: string): string =>
        answered
          ? text
          : text.replace(/^the controller /, "the controller then ");
      const carried =
        !outcome.ok && outcome.error instanceof ProviderError
          ? outcome.error.retryAfterMs
          : undefined;
      if (typeof verdict === "string") {
        problems.push(verdict);
      } else {
        problems.push(...verdictProblems(fault, verdict, carried).map(said));
        // The detail rule: the platform's code when it is code-shaped, else
        // the kind's code. Checked when the provider threw the right kind.
        if (
          !outcome.ok &&
          outcome.error instanceof ProviderError &&
          outcome.error.kind === fault
        ) {
          const code = outcome.error.platformCode;
          const expected =
            code !== undefined && CODE_SHAPED.test(code)
              ? code
              : outcome.error.code;
          if (verdict.detail !== expected) {
            problems.push(
              said(
                `the controller's detail was ${JSON.stringify(verdict.detail)}, not ${JSON.stringify(expected)}`,
              ),
            );
          }
        }
      }
    } else if (probe === undefined) {
      verdictNote = `the controller's verdict was not checked: ${probeSkipped ?? "no controller"}`;
    }
    run.set(
      id,
      problems.length === 0 ? "pass" : "fail",
      problems.length === 0 ? verdictNote : problems.join("; "),
    );
  }
  // A should: a platformCode that is not code-shaped still works, but the
  // controller shows `PROVIDER_<KIND>` in its place, losing the platform's.
  const prose = thrown.filter(
    (error) =>
      error.platformCode !== undefined && !CODE_SHAPED.test(error.platformCode),
  );
  run.set(
    "summon.errors.platform-code",
    prose.length === 0 ? "pass" : "fail",
    prose.length === 0
      ? thrown.length === 0
        ? "no ProviderError was thrown to read"
        : undefined
      : `${prose.length} ProviderError platformCode(s) are not code-shaped (1-64 characters of letters, digits, _ . : -), so the controller shows ${prose[0]!.code} instead`,
  );
}

/** When the kit aborts a slow call, in ms after it starts. */
const ABORT_AFTER_MS = 500;

/** How long after the abort a call may take to reject, in ms. */
const REJECT_WITHIN_MS = 1_000;

/** The timeouts group: a slow platform, an aborted signal, a prompt rejection, no timer left. */
export async function timeoutChecks(run: KitRun): Promise<void> {
  run.internals.clearFaults();
  run.platform.inject("slow", { times: 5 });
  const abort = new AbortController();
  const context = run.context(abort.signal);
  let abortedAt = 0;
  let settled: { at: number; rejected: boolean; error?: unknown } | undefined;
  const request = run.request();
  const timers = trackTimers();
  let left: number;
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The abort timer is created inside the tracked call, so what the abort
    // makes the provider do (its listeners) is tracked too.
    const started = timers.run(() => ({
      abortTimer: KIT_TIMERS.setTimeout(() => {
        abortedAt = Date.now();
        abort.abort(new Error("the conformance kit's timeout"));
      }, ABORT_AFTER_MS),
      call: (async () => await run.facet.summon(request, context))(),
    }));
    abortTimer = started.abortTimer;
    const watched = started.call.then(
      (value) => {
        run.scanned.push(value);
        settled = { at: Date.now(), rejected: false };
      },
      (error: unknown) => {
        run.scanned.push(error);
        settled = { at: Date.now(), rejected: true, error };
      },
    );
    await Promise.race([
      watched,
      new Promise<void>((resolve) => {
        KIT_TIMERS.setTimeout(resolve, ABORT_AFTER_MS + REJECT_WITHIN_MS + 250);
      }),
    ]);
    // Let whatever the rejection scheduled run before counting what is left.
    await new Promise<void>((resolve) => {
      KIT_TIMERS.setTimeout(resolve, 100);
    });
    left = timers.pending();
  } finally {
    // The globals are the process's, not the kit's: always given back.
    timers.restore();
    KIT_TIMERS.clearTimeout(abortTimer);
    run.internals.releaseHolds();
    run.internals.clearFaults();
  }

  const result = settled as
    | { at: number; rejected: boolean; error?: unknown }
    | undefined;
  if (result === undefined) {
    run.set(
      "summon.timeouts.rejects-on-abort",
      "fail",
      `still pending ${REJECT_WITHIN_MS} ms after ctx.signal aborted: pass the signal to ctx.fetch`,
    );
  } else if (!result.rejected) {
    run.set(
      "summon.timeouts.rejects-on-abort",
      "fail",
      "resolved after ctx.signal aborted, instead of rejecting",
    );
  } else if (result.at - abortedAt > REJECT_WITHIN_MS) {
    run.set(
      "summon.timeouts.rejects-on-abort",
      "fail",
      `rejected ${result.at - abortedAt} ms after ctx.signal aborted`,
    );
  } else {
    run.set("summon.timeouts.rejects-on-abort", "pass");
  }
  run.set(
    "summon.timeouts.no-timer-left",
    left === 0 ? "pass" : "fail",
    left === 0
      ? undefined
      : `${left} timer(s) the call created were still pending after it settled`,
  );
}
