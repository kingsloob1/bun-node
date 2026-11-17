/**
 * Policy inheritance (control-plane.md §2.2): a service's effective policy
 * is its layers merged in order, built-in defaults ← global ← each ancestor
 * group, outermost first ← the service.
 *
 * - Objects merge by key; scalars and unkeyed arrays replace.
 * - Rules, limits, counted rules, list entries, identifier patterns,
 *   canaries and custom crawlers are keyed by `id` (a list entry or a
 *   pattern without one by its subject): a lower scope overrides an
 *   inherited item by its key (its fields merged over the inherited ones,
 *   so `{ id, mode: "off" }` disables it) and adds its own.
 * - An item marked `locked: true` cannot be overridden or disabled from
 *   below: the override is dropped and reported as an issue naming the
 *   scope that locked it.
 * - Lists union: a lower allow entry never removes a deny above it. A
 *   list entry with no `scope` of its own takes its layer's.
 *
 * Every field and keyed item is reported with the scope it came from.
 */
import type { PolicyScopeId } from "./contract/types";

/** A JSON object. */
type JsonObject = Record<string, unknown>;

/** One layer of a merge: a scope's policy. */
export interface PolicyLayer {
  /** The scope it came from (`global`, `group:payments`, `service:checkout`). */
  readonly scope: PolicyScopeId;
  /** Its policy: a partial policy. */
  readonly policy: Readonly<JsonObject>;
}

/** An item a lower scope tried to override although a higher one locked it. */
export interface LockedOverride {
  /** Where (`limits[id=per-ip]`). */
  readonly path: string;
  /** The scope that locked it. */
  readonly lockedBy: PolicyScopeId;
  /** The scope that tried. */
  readonly scope: PolicyScopeId;
}

/** What {@link mergePolicies} answers. */
export interface MergedPolicy {
  /** The effective policy. */
  readonly policy: JsonObject;
  /** Each field's and keyed item's origin, by path. */
  readonly origins: Readonly<Record<string, PolicyScopeId>>;
  /** Overrides of locked items, dropped. */
  readonly locked: readonly LockedOverride[];
}

/** The arrays merged by key, by their path in the policy. */
const KEYED: Readonly<
  Record<string, (item: JsonObject) => string | undefined>
> = {
  lists: (item) => (typeof item.id === "string" ? item.id : listKey(item)),
  limits: idOf,
  countedRules: idOf,
  "requestRules.rules": idOf,
  "identifiers.patterns": (item) =>
    typeof item.id === "string"
      ? item.id
      : `${String(item.kind)}:${String(item.pattern)}`,
  "deception.canaries": idOf,
  "crawlers.custom": idOf,
  "serviceIdentity.services": idOf,
};

/** An item's `id`. */
function idOf(item: JsonObject): string | undefined {
  return typeof item.id === "string" ? item.id : undefined;
}

/** A list entry's key when it has no id: its subject, scope and paths. */
function listKey(item: JsonObject): string {
  for (const subject of ["ip", "user", "apiKey", "country", "asn"]) {
    if (item[subject] !== undefined) {
      const paths = Array.isArray(item.paths)
        ? `|${(item.paths as unknown[]).join(",")}`
        : "";
      return `${subject}:${String(item[subject])}${paths}`;
    }
  }
  return JSON.stringify(item);
}

/** Whether `value` is a plain JSON object. */
function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A deep copy of a JSON value. */
function copy<T>(value: T): T {
  return structuredClone(value);
}

/** Merges `layers` in order; see the module's description. */
export function mergePolicies(layers: readonly PolicyLayer[]): MergedPolicy {
  const origins: Record<string, PolicyScopeId> = {};
  const locked: LockedOverride[] = [];
  const policy: JsonObject = {};
  /** Which scope locked each keyed item, by its path. */
  const lockedBy = new Map<string, PolicyScopeId>();

  const mergeKeyed = (
    inherited: JsonObject[],
    own: JsonObject[],
    path: string,
    scope: PolicyScopeId,
    keyOf: (item: JsonObject) => string | undefined,
  ): JsonObject[] => {
    const out = [...inherited];
    const at = new Map<string, number>();
    out.forEach((item, index) => {
      const key = keyOf(item);
      if (key !== undefined) at.set(key, index);
    });
    for (const raw of own) {
      if (!isObject(raw)) continue;
      const item = copy(raw);
      if (path === "lists" && item.scope === undefined)
        item.scope = scopeKind(scope);
      const key = keyOf(item);
      const itemPath = `${path}[${key === undefined ? out.length : `id=${key}`}]`;
      const index = key === undefined ? undefined : at.get(key);
      if (index === undefined) {
        if (key !== undefined) at.set(key, out.length);
        out.push(item);
        origins[itemPath] = scope;
        if (item.locked === true) lockedBy.set(itemPath, scope);
        continue;
      }
      const holder = lockedBy.get(itemPath);
      if (holder !== undefined && holder !== scope) {
        locked.push({ path: itemPath, lockedBy: holder, scope });
        continue;
      }
      out[index] = { ...out[index], ...item };
      origins[itemPath] = scope;
      if (item.locked === true) lockedBy.set(itemPath, scope);
    }
    return out;
  };

  const mergeInto = (
    target: JsonObject,
    source: JsonObject,
    at: string,
    scope: PolicyScopeId,
  ): void => {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      const path = at === "" ? key : `${at}.${key}`;
      const keyOf = KEYED[path];
      if (keyOf !== undefined && Array.isArray(value)) {
        target[key] = mergeKeyed(
          Array.isArray(target[key]) ? (target[key] as JsonObject[]) : [],
          value as JsonObject[],
          path,
          scope,
          keyOf,
        );
        continue;
      }
      if (isObject(value)) {
        // Walked leaf by leaf, so each field records its own origin.
        if (!isObject(target[key])) target[key] = {};
        mergeInto(target[key] as JsonObject, value, path, scope);
        continue;
      }
      target[key] = copy(value);
      origins[path] = scope;
    }
  };

  for (const layer of layers) mergeInto(policy, layer.policy, "", layer.scope);
  return { policy, origins, locked };
}

/** The list-entry scope a policy scope is (`global`, `group`, `service`). */
function scopeKind(scope: PolicyScopeId): string {
  return scope === "global"
    ? "global"
    : scope.startsWith("group:")
      ? "group"
      : "service";
}

/** One difference between two policies, as {@link diffPolicies} reports it. */
export interface PolicyChange {
  /** Where (`limits[id=per-ip].limit`, `ladder.halfLife`). */
  readonly path: string;
  /** Before (absent: added). */
  readonly before?: unknown;
  /** After (absent: removed). */
  readonly after?: unknown;
}

/**
 * The differences between two policies, field by field, keyed arrays
 * matched by key (so a reordered list is no change).
 */
export function diffPolicies(before: unknown, after: unknown): PolicyChange[] {
  const changes: PolicyChange[] = [];
  const walk = (
    a: unknown,
    b: unknown,
    path: string,
    keyOf?: (item: JsonObject) => string | undefined,
  ): void => {
    if (keyOf !== undefined && Array.isArray(a) && Array.isArray(b)) {
      const index = (list: unknown[]) =>
        new Map(
          list
            .filter(isObject)
            .map((item, at) => [keyOf(item) ?? `#${at}`, item] as const),
        );
      const left = index(a);
      const right = index(b);
      for (const [key, item] of left) {
        walk(item, right.get(key), `${path}[id=${key}]`);
      }
      for (const [key, item] of right) {
        if (!left.has(key))
          changes.push({ path: `${path}[id=${key}]`, after: item });
      }
      return;
    }
    if (isObject(a) && isObject(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const child = path === "" ? key : `${path}.${key}`;
        const stripped = child.replaceAll(/\[[^\]]*\]/g, "");
        walk(a[key], b[key], child, KEYED[stripped]);
      }
      return;
    }
    if (a === undefined && b === undefined) return;
    if (a === undefined) {
      changes.push({ path, after: b });
    } else if (b === undefined) {
      changes.push({ path, before: a });
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes.push({ path, before: a, after: b });
    }
  };
  walk(before ?? {}, after ?? {}, "");
  return changes;
}
