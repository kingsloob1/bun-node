/**
 * A draft's impact estimate (ui.md §4.4, PR-CP7): the stored events of a
 * window replayed through each affected service's published effective
 * policy and the same with the scope's draft in its place, on throwaway
 * engines, and what changes counted.
 *
 * The user's decisions of 2026-11-17:
 * - stateless layers only: every rule labelled `exact`, `partial` or
 *   `not-evaluated` (`ruleLabels`), no rate-limit estimate;
 * - an event's account subjects are taken as the keys they are (the
 *   engine's internal pre-keyed identity), so account lists are exact;
 * - sampled allows are counted as sampled, never scaled, and their rates
 *   reported;
 * - bounded: 7 days at most, 50,000 events, 10 s, 200 services; stopped
 *   when the caller goes away; nothing stored;
 * - redacted per event as CP5 decided: a caller without `events:read` on an
 *   event's service sees its rules as a viewer does and no account subject
 *   counts from it; a service the caller cannot read analytics for is
 *   skipped.
 */
import type { RequestFacts } from "../engine/facts";
import type { IntelLookup, IntelRecord } from "../intel/types";
import type { SecurityEvent } from "../store/types";
import type { RuleImpactDto, RuleLabelDto } from "./contract/ruleTest";
import type { PolicyScopeId } from "./contract/types";
import type { Operator } from "./options";
import type { ControlPlane } from "./plane";
import type { Security } from "../engine/security";
import { requestFacts } from "../engine/facts";
import { withInternal } from "../engine/internal";
import { RULE_TEST_LIMITS } from "./contract/ruleTest";
import { viewerRule } from "./live/view";
import { ApiProblem } from "./problems";
import { labelOfHit, ruleLabels } from "./ruleLabels";
import { effectiveFor, throwawayEngine } from "./ruleTest";

/** What an estimate takes. */
export interface ImpactRun {
  /** The scope whose draft is compared with its published policy. */
  readonly scope: PolicyScopeId;
  /** The window's start, epoch ms. */
  readonly from: number;
  /** The window's end, epoch ms. */
  readonly to: number;
  /** Who asks: decides what each event shows. */
  readonly operator: Operator;
  /** Aborted when the caller goes away. */
  readonly signal?: AbortSignal;
  /** The fleet secret, for account list entries. */
  readonly secret?: string | Uint8Array;
  /** The policy to estimate at {@link scope} in place of its draft (an approval's). */
  readonly candidate?: Readonly<Record<string, unknown>>;
  /** Test seams: the bounds. Default {@link RULE_TEST_LIMITS}'s. */
  readonly bounds?: {
    /** The most events read. */
    readonly maxEvents?: number;
    /** The longest run, ms. */
    readonly maxDurationMs?: number;
    /** The most services replayed. */
    readonly maxServices?: number;
  };
}

/** A decision's class. */
type DecisionClass = "allow" | "challenge" | "refuse";

/** The class of an action. */
function classOf(action: string): DecisionClass {
  if (action === "block" || action === "ban" || action === "drop")
    return "refuse";
  if (action === "challenge") return "challenge";
  return "allow";
}

/** An event's facts, from what it kept (its redacted sample, its route, its keyed subjects). */
function factsOf(event: SecurityEvent): RequestFacts {
  const sample = (
    typeof event.sample === "object" && event.sample !== null
      ? event.sample
      : {}
  ) as {
    method?: unknown;
    path?: unknown;
    query?: unknown;
    headers?: unknown;
  };
  const [routeMethod, routePath] = (event.route ?? "").split(" ", 2);
  const method =
    typeof sample.method === "string" ? sample.method : routeMethod || "GET";
  let path =
    typeof sample.path === "string" && sample.path.startsWith("/")
      ? sample.path
      : routePath || "/";
  if (path.startsWith("//")) path = `/${path.replace(/^\/+/, "")}`;
  const query =
    typeof sample.query === "object" && sample.query !== null
      ? new URLSearchParams(
          Object.entries(sample.query as Record<string, unknown>).map(
            ([k, v]): [string, string] => [
              k,
              typeof v === "string" ? v : JSON.stringify(v),
            ],
          ),
        ).toString()
      : "";
  const headers: Record<string, string> = {};
  if (typeof sample.headers === "object" && sample.headers !== null) {
    for (const [name, value] of Object.entries(
      sample.headers as Record<string, unknown>,
    )) {
      if (typeof value === "string") headers[name] = value;
    }
  }
  const peer = (event.subjects?.ip ?? "").replace(/\/\d+$/, "");
  const identity = {
    ...(event.subjects?.user === undefined
      ? {}
      : { user: event.subjects.user }),
    ...(event.subjects?.apiKey === undefined
      ? {}
      : { apiKey: event.subjects.apiKey }),
    ...(event.subjects?.username === undefined
      ? {}
      : { username: event.subjects.username }),
  };
  const init = {
    peer,
    service: event.service,
    ...(event.route === undefined ? {} : { routeKey: event.route }),
    ...(Object.keys(identity).length === 0 ? {} : { identity }),
  };
  let facts: RequestFacts;
  try {
    facts = requestFacts(
      new Request(
        `http://service.invalid${path}${query === "" ? "" : `?${query}`}`,
        { method, headers },
      ),
      init,
    );
  } catch {
    // A sample a Request refuses (a redacted header value, an odd method): its route alone.
    facts = requestFacts(
      new Request(`http://service.invalid${routePath || "/"}`, {
        method: "GET",
      }),
      init,
    );
  }
  return withInternal(facts, { prekeyed: true });
}

/** One service's two engines and what the caller may see of its events. */
interface Replay {
  /** Under the published policy. */
  readonly before: Security;
  /** Under the draft. */
  readonly after: Security;
  /** Whether the caller sees its events whole (`events:read`). */
  readonly detail: boolean;
}

/** Estimates a draft's impact; see the module's description. */
export async function estimateImpact(
  plane: ControlPlane,
  run: ImpactRun,
): Promise<RuleImpactDto> {
  const started = performance.now();
  const maxEvents = run.bounds?.maxEvents ?? RULE_TEST_LIMITS.maxEvents;
  const maxDuration =
    run.bounds?.maxDurationMs ?? RULE_TEST_LIMITS.maxDurationMs;
  const maxServices = run.bounds?.maxServices ?? RULE_TEST_LIMITS.maxServices;
  const listEvents = plane.store.listEvents;
  if (listEvents === undefined) {
    throw new ApiProblem(
      404,
      "not_found",
      `the "${plane.store.name}" store keeps no events`,
    );
  }
  // The draft must exist (a 404 otherwise), unless a candidate replaces it.
  if (run.candidate === undefined) await plane.policyAt(run.scope, "draft");
  // Each event's country and ASN, as the engines' intel.
  let current: IntelRecord = { classes: [] };
  const intel: IntelLookup = {
    lookup: () => current,
    provides: () => ({ country: true, asn: true, classes: new Set<string>() }),
  };
  const all = (await plane.servicesUnder(run.scope)).map((s) => s.id).sort();
  const skipped: { service: string; reason: string }[] = [];
  const replays = new Map<string, Replay>();
  const labels = new Map<string, RuleLabelDto>();
  const engines: Security[] = [];
  const now = () => plane.now();
  try {
    for (const service of all) {
      if (replays.size >= maxServices) {
        skipped.push({
          service,
          reason: `past the ${maxServices} services an estimate replays`,
        });
        continue;
      }
      const scope = `service:${service}`;
      if (!(await plane.can(run.operator, "analytics:read", scope))) {
        skipped.push({ service, reason: "no analytics:read on it" });
        continue;
      }
      try {
        const published = await effectiveFor(plane, service, undefined);
        const drafted = await effectiveFor(
          plane,
          service,
          run.scope,
          run.candidate,
        );
        const before = throwawayEngine(
          published.policy,
          run.secret,
          intel,
          now,
        );
        engines.push(before);
        const after = throwawayEngine(drafted.policy, run.secret, intel, now);
        engines.push(after);
        for (const policy of [published.policy, drafted.policy]) {
          for (const [rule, dto] of ruleLabels(
            policy,
            run.secret !== undefined,
          )) {
            const known = labels.get(rule);
            if (known === undefined || worseLabel(dto, known))
              labels.set(rule, dto);
          }
        }
        replays.set(service, {
          before,
          after,
          detail: await plane.can(run.operator, "events:read", scope),
        });
      } catch (error) {
        if (error instanceof ApiProblem) {
          skipped.push({ service, reason: error.message });
          continue;
        }
        throw error;
      }
    }
    const transitions = new Map<string, number>();
    const rules = new Map<
      string,
      { newlyHit: number; noLongerHit: number; samples: string[] }
    >();
    const routes = new Map<string, number>();
    const subjects = new Map<string, Set<string>>();
    const rates = new Set<number>();
    let read = 0;
    let allows = 0;
    let stoppedBy: "events" | "time" | null = null;
    const services = [...replays.keys()];
    let cursor: string | undefined;
    const touch = (
      rule: string,
      field: "newlyHit" | "noLongerHit",
      id: string,
    ) => {
      let entry = rules.get(rule);
      if (entry === undefined) {
        entry = { newlyHit: 0, noLongerHit: 0, samples: [] };
        rules.set(rule, entry);
      }
      entry[field] += 1;
      if (
        entry.samples.length < RULE_TEST_LIMITS.samplesPerRule &&
        !entry.samples.includes(id)
      )
        entry.samples.push(id);
    };
    const countSubject = (kind: string, value: string | undefined) => {
      if (value === undefined) return;
      let set = subjects.get(kind);
      if (set === undefined) {
        set = new Set();
        subjects.set(kind, set);
      }
      if (set.size < 100_000) set.add(value);
    };
    outer: while (services.length > 0) {
      run.signal?.throwIfAborted();
      const page = await listEvents({
        services,
        from: run.from,
        to: run.to,
        limit: 500,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const event of page.items) {
        if (read >= maxEvents) {
          stoppedBy = "events";
          break outer;
        }
        if (performance.now() - started > maxDuration) {
          stoppedBy = "time";
          break outer;
        }
        if (read % 100 === 0) run.signal?.throwIfAborted();
        const replay = replays.get(event.service);
        if (replay === undefined) continue;
        read += 1;
        if (event.action === "allow") {
          allows += 1;
          if (event.sampleRate !== undefined) rates.add(event.sampleRate);
        }
        current = {
          ...(event.country === undefined ? {} : { country: event.country }),
          ...(event.asn === undefined ? {} : { asn: event.asn }),
          classes: [],
        };
        const facts = factsOf(event);
        const before = await replay.before.explain(facts, { now: event.at });
        const after = await replay.after.explain(facts, { now: event.at });
        const show = (rule: string) =>
          replay.detail ? rule : viewerRule(rule);
        const was = new Set(before.decision.hits.map((hit) => hit.rule));
        const is = new Set(after.decision.hits.map((hit) => hit.rule));
        for (const rule of is)
          if (!was.has(rule)) touch(show(rule), "newlyHit", event.id);
        for (const rule of was)
          if (!is.has(rule)) touch(show(rule), "noLongerHit", event.id);
        for (const rule of [...was, ...is])
          if (!labels.has(rule)) labels.set(rule, labelOfHit(rule, labels));
        const from = classOf(before.decision.action);
        const to = classOf(after.decision.action);
        if (from === to) continue;
        transitions.set(
          `${from}>${to}`,
          (transitions.get(`${from}>${to}`) ?? 0) + 1,
        );
        const route = event.route ?? "(unknown)";
        routes.set(route, (routes.get(route) ?? 0) + 1);
        countSubject("ip", event.subjects?.ip);
        if (replay.detail) {
          countSubject("user", event.subjects?.user);
          countSubject("apiKey", event.subjects?.apiKey);
          countSubject("username", event.subjects?.username);
        }
      }
      cursor = page.next;
      if (cursor === undefined) break;
    }
    return {
      scope: run.scope,
      window: { from: run.from, to: run.to },
      services: { replayed: services, skipped },
      events: { read, stoppedBy },
      sampledAllows: { read: allows, rates: [...rates].sort((a, b) => a - b) },
      transitions: [...transitions].map(([key, count]) => {
        const [from, to] = key.split(">") as [DecisionClass, DecisionClass];
        return { from, to, count };
      }),
      rules: [...rules]
        .map(([rule, entry]) => ({ rule, ...entry }))
        .sort(
          (a, b) => b.newlyHit + b.noLongerHit - (a.newlyHit + a.noLongerHit),
        ),
      routes: [...routes]
        .sort((a, b) => b[1] - a[1])
        .slice(0, RULE_TEST_LIMITS.maxRoutes)
        .map(([route, changed]) => ({ route, changed })),
      subjects: Object.fromEntries(
        [...subjects].map(([kind, set]) => [kind, set.size]),
      ),
      // Labels shown as the caller may see rule ids: a viewer's rules for an account redacted.
      labels: [...labels.values()]
        .map((dto) => ({ ...dto, rule: viewerRule(dto.rule) }))
        .filter(
          (dto, i, list) =>
            list.findIndex((other) => other.rule === dto.rule) === i,
        )
        .sort((a, b) => a.rule.localeCompare(b.rule)),
    };
  } finally {
    for (const engine of engines) engine.close();
  }
}

/** Whether `a` labels less exactly than `b`. */
function worseLabel(a: RuleLabelDto, b: RuleLabelDto): boolean {
  const order = ["exact", "partial", "not-evaluated"];
  return order.indexOf(a.label) > order.indexOf(b.label);
}
