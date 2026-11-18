/**
 * A request rule as the editor holds it (layers.md L7) and back to the
 * policy's JSON: its id, action, mode, weight, refusal status and code, a
 * ban's length, crawlers, whether it is locked, and its condition. Fields
 * the editor does not show are kept from the rule read.
 */
import type { ConditionNode } from "./conditionModel";
import { conditionJson, newMatch, parseCondition } from "./conditionModel";

/** A rule as the policy holds it (data: its fields are checked here). */
export type RuleJson = Readonly<Record<string, unknown>>;

/** The actions. */
export const RULE_ACTIONS = [
  "block",
  "challenge",
  "ban",
  "drop",
  "log",
] as const;

/** The modes. */
export const RULE_MODES = ["enforce", "dryRun", "off"] as const;

/** A rule's id: letters, digits, `_`, `.` and `-`, 1 to 64. */
export const RULE_ID = /^[\w.-]{1,64}$/;

/** The editor's fields, as typed. */
export interface RuleForm {
  /** Its id. */
  id: string;
  /** What a hit does. */
  action: (typeof RULE_ACTIONS)[number];
  /** Enforced, a dry run, or off. */
  mode: (typeof RULE_MODES)[number];
  /** The offence weight, 0 to 100; empty for the default. */
  weight: string;
  /** The refusal's status, 400 to 599; empty for 403. */
  status: string;
  /** The refusal's problem code; empty for the default. */
  code: string;
  /** A ban's length (`1h`, `30m`, `7d`); empty for the ladder's; `lifted` until lifted. */
  duration: string;
  /** A verified crawler held to it (`apply`) or not (`skip`); empty for the default. */
  crawlers: "" | "apply" | "skip";
  /** Locked for the scopes below. */
  locked: boolean;
  /** The condition. */
  when: ConditionNode;
}

/** An empty rule: block a path by glob. */
export function newRule(): RuleForm {
  return {
    id: "",
    action: "block",
    mode: "dryRun",
    weight: "",
    status: "",
    code: "",
    duration: "",
    crawlers: "",
    locked: false,
    when: newMatch(),
  };
}

/** A string field, or empty. */
function text(value: unknown): string {
  return typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : "";
}

/** The editor's form for a rule read. */
export function ruleForm(rule: RuleJson): RuleForm {
  const action = (RULE_ACTIONS as readonly unknown[]).includes(rule.action)
    ? (rule.action as RuleForm["action"])
    : "block";
  const mode = (RULE_MODES as readonly unknown[]).includes(rule.mode)
    ? (rule.mode as RuleForm["mode"])
    : "enforce";
  return {
    id: text(rule.id),
    action,
    mode,
    weight: text(rule.weight),
    status: text(rule.status),
    code: text(rule.code),
    duration: rule.duration === null ? "lifted" : text(rule.duration),
    crawlers:
      rule.crawlers === "apply" || rule.crawlers === "skip"
        ? rule.crawlers
        : "",
    locked: rule.locked === true,
    when: parseCondition(rule.when),
  };
}

/** The rule's JSON (keeping `base`'s other fields), or the first reason it cannot be. */
export function ruleJson(
  form: RuleForm,
  base: RuleJson = {},
): { rule: Record<string, unknown> } | { error: string } {
  const id = form.id.trim();
  if (!RULE_ID.test(id))
    return { error: "An id is 1 to 64 letters, digits, _, . and -" };
  const when = conditionJson(form.when);
  if ("error" in when) return when;
  const {
    weight: _w,
    status: _s,
    code: _c,
    duration: _d,
    crawlers: _cr,
    locked: _l,
    ...kept
  } = base;
  const out: Record<string, unknown> = {
    ...kept,
    id,
    when: when.json,
    action: form.action,
    mode: form.mode,
  };
  if (form.weight.trim() !== "") {
    const weight = Number(form.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > 100)
      return { error: "The weight is a number from 0 to 100" };
    out.weight = weight;
  }
  if (form.status.trim() !== "") {
    const status = Number(form.status);
    if (!Number.isInteger(status) || status < 400 || status > 599)
      return { error: "The status is a whole number from 400 to 599" };
    out.status = status;
  }
  if (form.code.trim() !== "") out.code = form.code.trim();
  if (form.action === "ban") {
    if (form.duration === "lifted") out.duration = null;
    // Any duration bun-common reads (`30m`, `1h30m`, `7d`): the control
    // plane checks it on save and says what it refused.
    else if (form.duration.trim() !== "") out.duration = form.duration.trim();
  }
  if (form.crawlers !== "") out.crawlers = form.crawlers;
  if (form.locked) out.locked = true;
  return { rule: out };
}

/** A policy's own request rules. */
export function rulesOf(policy: Readonly<Record<string, unknown>>): RuleJson[] {
  const section = policy.requestRules;
  if (typeof section !== "object" || section === null) return [];
  const rules = (section as { rules?: unknown }).rules;
  return Array.isArray(rules)
    ? rules.filter(
        (rule): rule is RuleJson => typeof rule === "object" && rule !== null,
      )
    : [];
}

/** `policy` with its request rules replaced by `rules` (its other request-rule settings kept). */
export function withRules(
  policy: Readonly<Record<string, unknown>>,
  rules: readonly RuleJson[],
): Record<string, unknown> {
  const section =
    typeof policy.requestRules === "object" && policy.requestRules !== null
      ? (policy.requestRules as Record<string, unknown>)
      : {};
  return { ...policy, requestRules: { ...section, rules: [...rules] } };
}

/** `policy` with the rule `previousId` (or a new one when `null`) set to `rule`. */
export function putRule(
  policy: Readonly<Record<string, unknown>>,
  previousId: string | null,
  rule: RuleJson,
):
  | { readonly ok: true; readonly policy: Record<string, unknown> }
  | { readonly ok: false; readonly error: string } {
  const rules = rulesOf(policy);
  const clash = rules.some(
    (item) => item.id === rule.id && item.id !== previousId,
  );
  if (clash)
    return { ok: false, error: `A rule “${String(rule.id)}” exists already` };
  const at =
    previousId === null
      ? -1
      : rules.findIndex((item) => item.id === previousId);
  const next = [...rules];
  if (at === -1) next.push(rule);
  else next[at] = rule;
  return { ok: true, policy: withRules(policy, next) };
}

/** `policy` without the rule `id`. */
export function removeRule(
  policy: Readonly<Record<string, unknown>>,
  id: string,
): Record<string, unknown> {
  return withRules(
    policy,
    rulesOf(policy).filter((rule) => rule.id !== id),
  );
}
