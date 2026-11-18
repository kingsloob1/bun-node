/**
 * How exactly the impact estimate (PR-CP7) can evaluate each rule over
 * stored events (the user's decision, 2026-11-17: stateless layers only,
 * every rule labelled, no rate-limit estimate).
 *
 * A stored event keeps its method, route, address, country, ASN and keyed
 * account subjects exactly; its path, query and headers only as redacted
 * samples; no body, no content length, no cookie values, no session or
 * tenant, no address classes, and none of the state limits, counted rules,
 * scores and bans read. So:
 *
 * - `exact`: list entries (addresses, ranges, countries, ASNs, and accounts
 *   when the control plane holds the fleet secret), request rules reading
 *   only the method, route, client address, country or ASN;
 * - `partial`: request rules and shape checks reading the path, query,
 *   headers or cookies (their redacted values may differ from the request's);
 * - `not-evaluated`: anything reading the body or its length (`shape.body`),
 *   a session, tenant or account id in a request rule, an address class,
 *   and every stateful layer (limits, counted rules, the ladder, bans,
 *   concurrency, sign-in defences, bot signals, challenges, crawlers'
 *   verification, canaries, API-key anomalies).
 */
import type { RuleEvaluability, RuleLabelDto } from "./contract/ruleTest";
import type { RequestRule, RuleCondition } from "../rules/types";
import { MANAGED_RULE_IDS, MANAGED_RULES } from "../rules/managed";

/** The stricter of two labels. */
function worse(a: RuleEvaluability, b: RuleEvaluability): RuleEvaluability {
  const order: RuleEvaluability[] = ["exact", "partial", "not-evaluated"];
  return order[Math.max(order.indexOf(a), order.indexOf(b))]!;
}

/** What a request rule's condition reads, and the label that leaves it. */
function conditionLabel(condition: RuleCondition): {
  label: RuleEvaluability;
  why: Set<string>;
} {
  const why = new Set<string>();
  const walk = (c: RuleCondition): RuleEvaluability => {
    if ("all" in c) return c.all.map(walk).reduce(worse, "exact");
    if ("any" in c) return c.any.map(walk).reduce(worse, "exact");
    if ("not" in c) return walk(c.not);
    if (
      "method" in c ||
      "routeKey" in c ||
      "client" in c ||
      "country" in c ||
      "asn" in c
    )
      return "exact";
    if (
      "path" in c ||
      "rawPath" in c ||
      "query" in c ||
      "queryParam" in c ||
      "header" in c ||
      "anyHeader" in c ||
      "cookie" in c ||
      "headerCount" in c
    ) {
      why.add("reads the path, query, headers or cookies, kept only redacted");
      return "partial";
    }
    if ("contentLength" in c) {
      why.add("reads the body's length, which events do not keep");
      return "not-evaluated";
    }
    if ("class" in c) {
      why.add("reads the address's classes, which events do not keep");
      return "not-evaluated";
    }
    why.add(
      "reads a session, tenant or account id, which events keep only keyed or not at all",
    );
    return "not-evaluated";
  };
  return { label: walk(condition), why };
}

/** A label. */
function label(
  rule: string,
  value: RuleEvaluability,
  why?: string,
): RuleLabelDto {
  return {
    rule,
    label: value,
    ...(why === undefined || value === "exact" ? {} : { why }),
  };
}

/** The labels of every rule a policy runs, keyed by rule. */
export function ruleLabels(
  policy: Record<string, unknown>,
  hasSecret: boolean,
): Map<string, RuleLabelDto> {
  const out = new Map<string, RuleLabelDto>();
  const add = (dto: RuleLabelDto) => out.set(dto.rule, dto);
  const lists = (policy.lists ?? []) as {
    user?: unknown;
    userHash?: unknown;
    apiKey?: unknown;
    apiKeyHash?: unknown;
  }[];
  if (lists.length > 0) {
    const accounts = lists.some(
      (entry) =>
        entry.user !== undefined ||
        entry.userHash !== undefined ||
        entry.apiKey !== undefined ||
        entry.apiKeyHash !== undefined,
    );
    add(
      label(
        "lists",
        accounts && !hasSecret ? "not-evaluated" : "exact",
        "its user and API-key entries need the fleet secret (bans.secret) to match keyed subjects",
      ),
    );
  }
  const requestRules = policy.requestRules as
    | {
        rules?: readonly RequestRule[];
        managed?: boolean | { exclude?: readonly string[] };
      }
    | undefined;
  for (const rule of requestRules?.rules ?? []) {
    const { label: value, why } = conditionLabel(rule.when);
    add(label(`rule:${rule.id}`, value, [...why].join("; ")));
  }
  const managed = requestRules?.managed;
  if (managed !== undefined && managed !== false) {
    const exclude = new Set(managed === true ? [] : (managed.exclude ?? []));
    for (const id of MANAGED_RULE_IDS) {
      if (exclude.has(id)) continue;
      const rule = MANAGED_RULES.get(id);
      if (rule === undefined) continue;
      const { label: value, why } = conditionLabel(rule.when);
      add(label(`probe:${id}`, value, [...why].join("; ")));
    }
  }
  for (const limit of (policy.limits ?? []) as { id?: string }[]) {
    if (typeof limit.id === "string")
      add(
        label(
          `limit:${limit.id}`,
          "not-evaluated",
          "a rate limit counts state no event keeps",
        ),
      );
  }
  for (const rule of (policy.countedRules ?? []) as { id?: string }[]) {
    if (typeof rule.id === "string")
      add(
        label(
          `counted:${rule.id}`,
          "not-evaluated",
          "a counted rule counts state no event keeps",
        ),
      );
  }
  const shape = policy.shape as Record<string, unknown> | false | undefined;
  if (shape !== undefined && shape !== false) {
    add(label("shape.method", "exact"));
    add(label("shape.path", "partial", "the path is kept only redacted"));
    add(label("shape.query", "partial", "the query is kept only redacted"));
    add(label("shape.headers", "partial", "headers are kept only redacted"));
    add(label("shape.host", "partial", "headers are kept only redacted"));
    add(
      label(
        "shape.body",
        "not-evaluated",
        "events keep no body and no body length",
      ),
    );
  }
  const stateful: [string, string, string][] = [
    ["ladder", "ladder", "the offence score is state no event keeps"],
    ["bans", "bans", "bans are state; the estimate does not replay them"],
    [
      "concurrency",
      "concurrency",
      "requests in flight are state no event keeps",
    ],
    ["login", "profiles", "sign-in defences count state no event keeps"],
    ["botSignals", "botSignals", "bot signals and challenges are not replayed"],
    ["crawlers", "crawlers", "crawler verification is not replayed"],
    [
      "deception",
      "deception",
      "canaries read credentials no event keeps; honeypot paths are kept only redacted",
    ],
    ["apiKeys", "apiKeys", "API-key anomalies count state no event keeps"],
  ];
  for (const [name, key, why] of stateful) {
    if (policy[key] !== undefined && policy[key] !== false)
      add(label(name, "not-evaluated", why));
  }
  return out;
}

/** The label of a hit's rule id, by its prefix, for a rule not listed (a list entry's own id, a ban). */
export function labelOfHit(
  rule: string,
  labels: ReadonlyMap<string, RuleLabelDto>,
): RuleLabelDto {
  const listed = labels.get(rule);
  if (listed !== undefined) return listed;
  const prefix = /^[a-z.]+/i.exec(rule)?.[0] ?? rule;
  if (
    [
      "limit",
      "counted",
      "ban",
      "ladder",
      "concurrency",
      "login",
      "botSignals",
      "crawler",
      "canary",
      "honeypot",
      "apiKey",
    ].some((p) => prefix.startsWith(p))
  )
    return label(
      rule,
      "not-evaluated",
      "a stateful layer the estimate does not replay",
    );
  if (prefix.startsWith("shape"))
    return labels.get(prefix) ?? label(rule, "partial");
  // A list entry's own id.
  return labels.get("lists") ?? label(rule, "exact");
}
