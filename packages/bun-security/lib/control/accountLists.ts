/**
 * Account list entries in the control plane (the user's decision,
 * 2026-11-17, PR-U3): a policy's `lists[].user` and `lists[].apiKey` are
 * the app's own ids, so the control plane never stores or serves them. It
 * keys each with the fleet's secret (`bans.secret`) as the engines key a
 * request's subject, `HMAC(secret, "user|" + id)`, and keeps the key as
 * `userHash` or `apiKeyHash`, which the engines match as they are.
 *
 * - **On a write** (a draft saved, a publish): every raw id is keyed; the
 *   ids typed come back once, in the draft-save answer (`entered`), and
 *   reach no store write, audit entry, live event or log. A malformed id or
 *   key, an entry naming two accounts, or an id of a kind the control plane
 *   does not key is a `400` naming the entry, never echoing the value.
 * - **On a read**: a policy stored before this change may still hold raw
 *   ids; each is keyed before it leaves the control plane. So are the diffs
 *   of audit entries written then.
 */
import { boundKey } from "../engine/identity";
import { ACCOUNT_ID_RE, ACCOUNT_KEY_RE } from "../policy/schema";
import type { Keyring } from "../sensitive/keys";
import type { EnteredListEntryDto } from "./contract/types";
import { ApiProblem } from "./problems";

/** A JSON object. */
type JsonObject = Record<string, unknown>;

/** How a control plane keys account ids. */
export interface ListKeying {
  /** The fleet's keyring (`bans.secret`); `undefined` when it holds none. */
  readonly keys: Keyring | undefined;
  /** Which account kinds it keys (`bans.users`, `bans.apiKeys`). */
  readonly kinds: { readonly user: boolean; readonly apiKey: boolean };
}

/** A policy with its account ids keyed, and the ids typed. */
export interface KeyedPolicy {
  /** The policy, every `lists[].user`/`apiKey` replaced by its key. */
  readonly policy: JsonObject;
  /** What was typed, by entry; empty when nothing was keyed. */
  readonly entered: readonly EnteredListEntryDto[];
}

/** The raw field of each account kind and the field its key goes in. */
const ACCOUNT_FIELDS = [
  { raw: "user", keyed: "userHash" },
  { raw: "apiKey", keyed: "apiKeyHash" },
] as const;

/** Whether `value` is a plain JSON object. */
function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `id`'s key under `keys`, as the engines key the kind's subject. */
function keyOf(keys: Keyring, kind: "user" | "apiKey", id: string): string {
  return kind === "user" ? keys.user(boundKey(id)) : keys.apiKey(boundKey(id));
}

/** `entry` with its `raw` field replaced, in place, by `keyed` holding `key`. */
function replaced(
  entry: JsonObject,
  raw: string,
  keyed: string,
  key: unknown,
): JsonObject {
  const out: JsonObject = {};
  for (const [field, value] of Object.entries(entry)) {
    if (field === raw) out[keyed] = key;
    else out[field] = value;
  }
  return out;
}

/** A `400` about `lists[index]`. */
function refused(index: number, message: string): ApiProblem {
  return new ApiProblem(400, "invalid_request", `lists[${index}]${message}`);
}

/**
 * Keys every raw account id in `policy.lists` for a write; see the
 * module's description. Anything else in the policy (a malformed `lists`,
 * an entry that is not an object) is left to the policy's validation.
 */
export function keyListsForWrite(
  policy: JsonObject,
  keying: ListKeying,
): KeyedPolicy {
  if (!Array.isArray(policy.lists)) return { policy, entered: [] };
  const entered: EnteredListEntryDto[] = [];
  const lists = policy.lists.map((entry: unknown, index: number) => {
    if (!isObject(entry)) return entry;
    const named = (
      ["user", "userHash", "apiKey", "apiKeyHash"] as const
    ).filter((field) => entry[field] !== undefined);
    if (named.length > 1) {
      throw refused(
        index,
        ` names more than one account (${named.join(", ")}): give exactly one of user, userHash, apiKey, apiKeyHash`,
      );
    }
    for (const { raw, keyed } of ACCOUNT_FIELDS) {
      const given = entry[keyed];
      if (
        given !== undefined &&
        !(typeof given === "string" && ACCOUNT_KEY_RE.test(given))
      ) {
        throw refused(
          index,
          `.${keyed} must be ${raw === "user" ? "a user's" : "an API key's"} key: 32 lower-case hex characters (its HMAC under bans.secret)`,
        );
      }
      const id = entry[raw];
      if (id === undefined) continue;
      if (!(typeof id === "string" && ACCOUNT_ID_RE.test(id))) {
        throw refused(
          index,
          `.${raw} must be ${raw === "user" ? "a user id" : "an API key id"} (1-256 characters, no spaces)`,
        );
      }
      if (keying.keys === undefined || !keying.kinds[raw]) {
        throw refused(
          index,
          `.${raw}: this control plane keys no ${raw === "user" ? "user ids (bans.users: false" : "API key ids (bans.apiKeys: false"}, or no bans.secret), so it cannot store the entry; give ${keyed} instead`,
        );
      }
      entered.push({ index, [raw]: id });
      return replaced(entry, raw, keyed, keyOf(keying.keys, raw, id));
    }
    return entry;
  });
  return entered.length === 0
    ? { policy, entered }
    : { policy: { ...policy, lists }, entered };
}

/**
 * `policy` with every raw account id left in its `lists` keyed (a policy
 * stored before the control plane keyed them); as it is when it holds none,
 * or when the control plane has no keyring to key them with.
 */
export function keyListsForRead(
  policy: JsonObject,
  keys: Keyring | undefined,
): JsonObject {
  if (keys === undefined || !Array.isArray(policy.lists)) return policy;
  const lists = keyedEntries(policy.lists, keys);
  return lists === policy.lists ? policy : { ...policy, lists };
}

/** `entries` with each raw account id keyed; the same array when none was. */
function keyedEntries(entries: readonly unknown[], keys: Keyring): unknown[] {
  let changed = false;
  const out = entries.map((entry) => {
    const keyed = keyedEntry(entry, keys);
    if (keyed !== entry) changed = true;
    return keyed;
  });
  return changed ? out : (entries as unknown[]);
}

/** One entry with its raw account id keyed; the same value when it has none. */
function keyedEntry(entry: unknown, keys: Keyring): unknown {
  if (!isObject(entry)) return entry;
  for (const { raw, keyed } of ACCOUNT_FIELDS) {
    const id = entry[raw];
    if (typeof id === "string")
      return replaced(entry, raw, keyed, keyOf(keys, raw, id));
  }
  return entry;
}

/** Whether `policy`'s lists still name an account by its id. */
export function holdsAccountIds(policy: unknown): boolean {
  if (!isObject(policy) || !Array.isArray(policy.lists)) return false;
  return policy.lists.some(
    (entry: unknown) =>
      isObject(entry) &&
      (entry.user !== undefined || entry.apiKey !== undefined),
  );
}

/** A diff path under one list entry (`lists[id=…]…`): its bracket and the rest. */
const ENTRY_PATH = /^lists\[([^\]]*)\](.*)$/;

/** An entry's default key in a path (`id=user:u_1|/a`): its kind, id and paths. */
const DEFAULT_KEY = /^id=(user|apiKey):([^|]*)((?:\|.*)?)$/;

/**
 * One policy change (`diffPolicies`) with its raw account ids keyed: in its
 * path (`lists[id=user:<id>]` → `lists[id=user:<key>]`, `.user` →
 * `.userHash`) and in its values (an entry, a list of entries, an id).
 */
function keyedChange(change: JsonObject, keys: Keyring): JsonObject {
  const path = change.path as string;
  let out = change;
  const set = (field: string, value: unknown) => {
    if (out === change) out = { ...change };
    out[field] = value;
  };
  let rest = path === "lists" ? "" : undefined;
  const match = ENTRY_PATH.exec(path);
  if (match !== null) {
    const [, bracket, tail] = match as unknown as [string, string, string];
    const named = DEFAULT_KEY.exec(bracket);
    if (named !== null) {
      const [, kind, id, paths] = named as unknown as [
        string,
        "user" | "apiKey",
        string,
        string,
      ];
      // A key (32 hex) is left alone: it cannot be told from an id that looks like one.
      if (!ACCOUNT_KEY_RE.test(id))
        set(
          "path",
          `lists[id=${kind}:${keyOf(keys, kind, id)}${paths}]${tail}`,
        );
    }
    rest = tail;
  }
  if (rest === undefined) return out;
  for (const side of ["before", "after"] as const) {
    const value = change[side];
    if (value === undefined) continue;
    if (rest === "") {
      const keyed = Array.isArray(value)
        ? keyedEntries(value, keys)
        : keyedEntry(value, keys);
      if (keyed !== value) set(side, keyed);
    } else if (
      (rest === ".user" || rest === ".apiKey") &&
      typeof value === "string"
    ) {
      set(side, keyOf(keys, rest === ".user" ? "user" : "apiKey", value));
    }
  }
  if (rest === ".user" || rest === ".apiKey") {
    const at = (out.path as string).lastIndexOf(".");
    set("path", `${(out.path as string).slice(0, at)}${rest}Hash`);
  }
  return out;
}

/**
 * An audit entry's body with the raw account ids of an entry written
 * before the control plane keyed them keyed (its `before`/`after`: a
 * policy, a policy's diff); the same object when there were none. Only
 * what is shown changes: the stored entry, its hash and the export are as
 * written.
 */
export function keyAuditBody(
  body: JsonObject,
  keys: Keyring | undefined,
): JsonObject {
  if (keys === undefined) return body;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      let changed = false;
      const out = value.map((item) => {
        const next = walk(item);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? out : value;
    }
    if (!isObject(value)) return value;
    let out = value;
    if (typeof value.path === "string" && value.path.startsWith("lists")) {
      out = keyedChange(value, keys);
    }
    for (const [field, child] of Object.entries(out)) {
      const next =
        field === "lists" && Array.isArray(child)
          ? keyedEntries(child, keys)
          : walk(child);
      if (next !== child) {
        if (out === value) out = { ...value };
        out[field] = next;
      }
    }
    return out;
  };
  return walk(body) as JsonObject;
}

// ── Canaries and request-rule conditions (the user's decision, 2026-11-17) ──
//
// The same rule as list entries: `deception.canaries[].user`/`apiKey` and a
// request rule's `{ user | apiKey: matcher }` condition are keyed when a
// draft is saved or a policy published (a condition only when it matches
// whole ids, `equals` or `in`: a pattern over raw ids cannot be keyed, and
// is refused); a read keys what a policy stored before still holds; and a
// policy shown to an operator never holds a raw id (what cannot be keyed is
// shown as `unkeyed`).

/** Where in a policy a `400` points. */
function refusedAt(at: string, message: string): ApiProblem {
  return new ApiProblem(400, "invalid_request", `${at}${message}`);
}

/** The ids a whole-value matcher names (`equals`: one, `in`: each); `undefined` for any other matcher. */
function exactIds(matcher: unknown): string[] | undefined {
  if (!isObject(matcher) || Object.keys(matcher).length !== 1) return undefined;
  if (typeof matcher.equals === "string") return [matcher.equals];
  if (
    Array.isArray(matcher.in) &&
    matcher.in.length > 0 &&
    matcher.in.every((id) => typeof id === "string")
  ) {
    return matcher.in as string[];
  }
  return undefined;
}

/** `condition` (a rule's `when`) with every node passed through `node`, children first; the same object when nothing changed. */
function mapCondition(
  condition: unknown,
  at: string,
  node: (value: JsonObject, at: string) => JsonObject,
): unknown {
  if (!isObject(condition)) return condition;
  let out = condition;
  for (const op of ["all", "any"] as const) {
    const children = condition[op];
    if (!Array.isArray(children)) continue;
    let changed = false;
    const mapped = children.map((child: unknown, i: number) => {
      const next = mapCondition(child, `${at}.${op}[${i}]`, node);
      if (next !== child) changed = true;
      return next;
    });
    if (changed) out = { ...out, [op]: mapped };
  }
  if (condition.not !== undefined) {
    const next = mapCondition(condition.not, `${at}.not`, node);
    if (next !== condition.not) out = { ...out, not: next };
  }
  return node(out, at);
}

/** `policy` with every request rule's conditions passed through `node`. */
function mapRuleConditions(
  policy: JsonObject,
  node: (value: JsonObject, at: string, index: number) => JsonObject,
): JsonObject {
  const rules = isObject(policy.requestRules)
    ? policy.requestRules.rules
    : undefined;
  if (!Array.isArray(rules)) return policy;
  let changed = false;
  const mapped = rules.map((rule: unknown, index: number) => {
    if (!isObject(rule)) return rule;
    const when = mapCondition(
      rule.when,
      `requestRules.rules[${index}].when`,
      (value, at) => node(value, at, index),
    );
    if (when === rule.when) return rule;
    changed = true;
    return { ...rule, when };
  });
  return changed
    ? {
        ...policy,
        requestRules: { ...(policy.requestRules as JsonObject), rules: mapped },
      }
    : policy;
}

/** `policy` with each canary passed through `fn`. */
function mapCanaries(
  policy: JsonObject,
  fn: (canary: JsonObject, index: number) => JsonObject,
): JsonObject {
  const canaries = isObject(policy.deception)
    ? policy.deception.canaries
    : undefined;
  if (!Array.isArray(canaries)) return policy;
  let changed = false;
  const mapped = canaries.map((canary: unknown, index: number) => {
    if (!isObject(canary)) return canary;
    const next = fn(canary, index);
    if (next !== canary) changed = true;
    return next;
  });
  return changed
    ? {
        ...policy,
        deception: { ...(policy.deception as JsonObject), canaries: mapped },
      }
    : policy;
}

/** The `400` when `keying` cannot key a `raw` id at `at`. */
function requireKeying(
  keying: ListKeying,
  raw: "user" | "apiKey",
  keyed: string,
  at: string,
): Keyring {
  if (keying.keys === undefined || !keying.kinds[raw]) {
    throw refusedAt(
      at,
      `.${raw}: this control plane keys no ${raw === "user" ? "user ids (bans.users: false" : "API key ids (bans.apiKeys: false"}, or no bans.secret), so it cannot store it; give ${keyed} instead`,
    );
  }
  return keying.keys;
}

/** Checks a raw id typed at `at`. */
function checkTypedId(id: unknown, raw: "user" | "apiKey", at: string): string {
  if (!(typeof id === "string" && ACCOUNT_ID_RE.test(id))) {
    throw refusedAt(
      at,
      `.${raw} must be ${raw === "user" ? "a user id" : "an API key id"} (1-256 characters, no spaces)`,
    );
  }
  return id;
}

/**
 * `policy` with every canary's and every request-rule condition's raw
 * account id keyed for a write, the ids typed added to `entered`. A `400`
 * (never echoing the value) for a malformed id, a canary naming two
 * accounts, an account condition that is not `equals` or `in`, or a kind
 * the control plane does not key.
 */
export function keyOthersForWrite(
  policy: JsonObject,
  keying: ListKeying,
  entered: EnteredListEntryDto[],
): JsonObject {
  const canaried = mapCanaries(policy, (canary, index) => {
    const at = `deception.canaries[${index}]`;
    const named = (
      ["user", "userHash", "apiKey", "apiKeyHash"] as const
    ).filter((field) => canary[field] !== undefined);
    if (named.length > 1) {
      throw refusedAt(
        at,
        ` names more than one account (${named.join(", ")}): give exactly one of user, userHash, apiKey, apiKeyHash`,
      );
    }
    for (const { raw, keyed } of ACCOUNT_FIELDS) {
      if (canary[raw] === undefined) continue;
      const id = checkTypedId(canary[raw], raw, at);
      const keys = requireKeying(keying, raw, keyed, at);
      entered.push({ section: "canaries", index, [raw]: id });
      return replaced(canary, raw, keyed, keyOf(keys, raw, id));
    }
    return canary;
  });
  return mapRuleConditions(canaried, (node, at, index) => {
    for (const { raw, keyed } of ACCOUNT_FIELDS) {
      if (node[raw] === undefined) continue;
      const ids = exactIds(node[raw]);
      if (ids === undefined) {
        throw refusedAt(
          at,
          `.${raw}: an account condition the control plane stores matches whole ids: give { equals } or { in } (or ${keyed} with keys); a pattern over ids cannot be keyed`,
        );
      }
      for (const id of ids) checkTypedId(id, raw, at);
      const keys = requireKeying(keying, raw, keyed, at);
      for (const id of ids) {
        entered.push({ section: "requestRules", index, path: at, [raw]: id });
      }
      const matched = ids.map((id) => keyOf(keys, raw, id));
      return replaced(
        node,
        raw,
        keyed,
        "equals" in (node[raw] as JsonObject)
          ? { equals: matched[0] }
          : { in: matched },
      );
    }
    return node;
  });
}

/**
 * `policy` with every raw account id its canaries and request-rule
 * conditions still hold keyed (a policy stored before the control plane
 * keyed them); a condition that is not `equals` or `in` stays as it is
 * (the engines key it at match time) and is shown `unkeyed`
 * ({@link redactAccountIds}).
 */
export function keyOthersForRead(
  policy: JsonObject,
  keys: Keyring | undefined,
): JsonObject {
  if (keys === undefined) return policy;
  const canaried = mapCanaries(policy, (canary) => {
    for (const { raw, keyed } of ACCOUNT_FIELDS) {
      const id = canary[raw];
      if (typeof id === "string")
        return replaced(canary, raw, keyed, keyOf(keys, raw, id));
    }
    return canary;
  });
  return mapRuleConditions(canaried, (node) => {
    for (const { raw, keyed } of ACCOUNT_FIELDS) {
      const ids = exactIds(node[raw]);
      if (ids === undefined) continue;
      const matched = ids.map((id) => keyOf(keys, raw, id));
      return replaced(
        node,
        raw,
        keyed,
        "equals" in (node[raw] as JsonObject)
          ? { equals: matched[0] }
          : { in: matched },
      );
    }
    return node;
  });
}

/**
 * `policy` as an operator sees it when a raw account id could not be keyed
 * (no keyring, or a condition that is not `equals` or `in`): each list
 * entry, canary and condition still naming one shows `unkeyed: "user"` (or
 * `"apiKey"`) in its place. A raw id never leaves the control plane in
 * what it shows.
 */
export function redactAccountIds(policy: JsonObject): JsonObject {
  const redact = (value: JsonObject): JsonObject => {
    for (const { raw } of ACCOUNT_FIELDS) {
      if (value[raw] !== undefined) return replaced(value, raw, "unkeyed", raw);
    }
    return value;
  };
  let out = policy;
  if (Array.isArray(out.lists)) {
    let changed = false;
    const lists = out.lists.map((entry: unknown) => {
      if (!isObject(entry)) return entry;
      const next = redact(entry);
      if (next !== entry) changed = true;
      return next;
    });
    if (changed) out = { ...out, lists };
  }
  out = mapCanaries(out, redact);
  return mapRuleConditions(out, redact);
}

/** Whether `policy`'s canaries or request-rule conditions still name an account by an id the control plane could key. */
export function othersHoldAccountIds(policy: unknown): boolean {
  if (!isObject(policy)) return false;
  let found = false;
  mapCanaries(policy, (canary) => {
    if (typeof canary.user === "string" || typeof canary.apiKey === "string")
      found = true;
    return canary;
  });
  // Only a condition that can be keyed: a pattern stays raw for good.
  mapRuleConditions(policy, (node) => {
    if (
      exactIds(node.user) !== undefined ||
      exactIds(node.apiKey) !== undefined
    )
      found = true;
    return node;
  });
  return found;
}

/** `policy` as shown: its account ids keyed where they can be, the rest `unkeyed`. */
export function showPolicyWith(
  policy: JsonObject,
  keys: Keyring | undefined,
): JsonObject {
  return redactAccountIds(
    keyOthersForRead(keyListsForRead(policy, keys), keys),
  );
}

/** A path segment naming a raw account field (`.user`, `.apiKey`), not its keyed form. */
const RAW_SEGMENT = /\.(user|apiKey)(?=$|[.[])/;

/** A list entry's default key in a path naming a raw id (`lists[id=user:<id>…]`), for redaction. */
const RAW_ENTRY_KEY = /\[id=(user|apiKey):(?![\da-f]{32}[|\]])[^|\]]*/g;

/** One diff change of a canary, a rule or a list entry, as shown (see {@link showAuditBody}). */
function shownChange(
  change: JsonObject,
  keys: Keyring | undefined,
): JsonObject {
  const path = change.path as string;
  const raw = RAW_SEGMENT.exec(path);
  const kind = raw?.[1] as "user" | "apiKey" | undefined;
  const keyedValue = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (ACCOUNT_KEY_RE.test(value)) return value;
      return keys === undefined || kind === undefined
        ? "[unkeyed]"
        : keyOf(keys, kind, value);
    }
    if (Array.isArray(value)) return value.map(keyedValue);
    return value;
  };
  const shownValue = (value: unknown): unknown => {
    if (kind !== undefined) {
      // A value under `.user` / `.apiKey`: an id, a list of ids, or a whole-value matcher.
      if (isObject(value)) {
        const ids = exactIds(value);
        if (ids === undefined) return { unkeyed: kind };
        const matched = ids.map((id) => keyedValue(id));
        return "equals" in value ? { equals: matched[0] } : { in: matched };
      }
      return keyedValue(value);
    }
    // A whole canary, rule, condition or list entry (or a list of them).
    if (Array.isArray(value)) return value.map(shownValue);
    if (!isObject(value)) return value;
    if (path.startsWith("deception.canaries")) {
      const shown = showPolicyWith({ deception: { canaries: [value] } }, keys);
      return ((shown.deception as JsonObject).canaries as unknown[])[0];
    }
    if (path.startsWith("requestRules")) {
      const asRule = isObject(value.when) ? value : { when: value };
      const shown = (
        (
          showPolicyWith({ requestRules: { rules: [asRule] } }, keys)
            .requestRules as JsonObject
        ).rules as JsonObject[]
      )[0]!;
      return isObject(value.when) ? shown : shown.when;
    }
    if (path.startsWith("lists"))
      return (showPolicyWith({ lists: [value] }, keys).lists as unknown[])[0];
    return value;
  };
  let out: JsonObject = { ...change };
  for (const side of ["before", "after"] as const) {
    if (change[side] !== undefined) out[side] = shownValue(change[side]);
  }
  let shownPath = path;
  if (kind !== undefined && keys !== undefined)
    shownPath = shownPath.replace(RAW_SEGMENT, (_m, k: string) => `.${k}Hash`);
  if (keys === undefined)
    shownPath = shownPath.replace(RAW_ENTRY_KEY, "[id=$1:[unkeyed]");
  if (shownPath !== path) out = { ...out, path: shownPath };
  return out;
}

/**
 * An audit entry's body as an operator sees it: list entries keyed as
 * {@link keyAuditBody} keys them, then every canary, request-rule
 * condition and list entry still holding a raw account id (in a policy or
 * a policy's diff) keyed where it can be and shown `unkeyed` (`[unkeyed]`
 * for a value) where it cannot. The stored entry, its hash and the export
 * are as written.
 */
export function showAuditBody(
  body: JsonObject,
  keys: Keyring | undefined,
): JsonObject {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      let changed = false;
      const out = value.map((item) => {
        const next = walk(item);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? out : value;
    }
    if (!isObject(value)) return value;
    let out: JsonObject = value;
    if (
      typeof value.path === "string" &&
      /^(?:lists|deception\.canaries|requestRules)/.test(value.path)
    ) {
      out = shownChange(value, keys);
    } else if (
      Array.isArray(value.lists) ||
      isObject(value.deception) ||
      isObject(value.requestRules)
    ) {
      out = showPolicyWith(value, keys);
    }
    for (const [field, child] of Object.entries(out)) {
      if (field === "before" || field === "after" || field === "path") continue;
      const next = walk(child);
      if (next !== child) {
        if (out === value) out = { ...value };
        out[field] = next;
      }
    }
    for (const side of ["before", "after"] as const) {
      const child = out[side];
      if (child === undefined || typeof out.path === "string") continue;
      const next = walk(child);
      if (next !== child) {
        if (out === value) out = { ...value };
        out[side] = next;
      }
    }
    return out;
  };
  return walk(keyAuditBody(body, keys)) as JsonObject;
}
