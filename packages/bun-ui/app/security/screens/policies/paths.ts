/**
 * Reading and changing a policy by path, and what a field shows on a
 * scope's editor (ui.md §3, control-plane.md §2.2): the value set on the
 * scope itself, else the value it inherits and the scope it comes from
 * (the effective policy's `origins`), and for a keyed item (a limit, a
 * counted rule) whether a scope above locked it (the effective policy's
 * `locked`). Changes are immutable: each returns a new policy.
 */

/** A path into a policy: keys and array indexes. */
export type PolicyPath = readonly (string | number)[];

/** A JSON object. */
export type JsonObject = Record<string, unknown>;

/** Whether `value` is a plain JSON object. */
export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value at `path`, or `undefined`. */
export function getAt(root: unknown, path: PolicyPath): unknown {
  let at: unknown = root;
  for (const part of path) {
    if (typeof part === "number") {
      if (!Array.isArray(at)) return undefined;
      at = at[part];
    } else {
      if (!isObject(at)) return undefined;
      at = at[part];
    }
  }
  return at;
}

/**
 * `root` with `value` at `path` (objects made on the way); `undefined`
 * removes the key, and an object left empty by it is removed too.
 */
export function setAt(
  root: JsonObject,
  path: PolicyPath,
  value: unknown,
): JsonObject {
  const put = (node: unknown, depth: number): unknown => {
    if (depth === path.length) return value;
    const part = path[depth];
    if (typeof part === "number") {
      const list = Array.isArray(node) ? [...(node as unknown[])] : [];
      const next = put(list[part], depth + 1);
      if (next === undefined) list.splice(part, 1);
      else list[part] = next;
      return list;
    }
    const object: JsonObject = isObject(node) ? { ...node } : {};
    const next = put(object[part], depth + 1);
    if (next === undefined) delete object[part];
    else object[part] = next;
    // An object a removal emptied goes too (not the root).
    return depth > 0 && Object.keys(object).length === 0 && value === undefined
      ? undefined
      : object;
  };
  return (put(root, 0) as JsonObject | undefined) ?? {};
}

/** A path as the effective policy's `origins` name it: `trustCheck.threshold`. */
export function dotted(path: PolicyPath): string {
  return path.map(String).join(".");
}

/** A keyed item's path as `origins` and `locked` name it: `limits[id=per-ip]`. */
export function keyedPath(section: string, key: string): string {
  return `${section}[id=${key}]`;
}

/** The effective policy a field's inheritance is read from. */
export interface EffectiveView {
  /** The merged policy. */
  readonly policy: Readonly<JsonObject>;
  /** Each field's or keyed item's path → the scope it came from. */
  readonly origins: Readonly<Record<string, string>>;
  /** Each locked item's path → the scope that locked it. */
  readonly locked: Readonly<Record<string, string>>;
}

/**
 * Where a field's published value came from: its own path's origin, else
 * (an object whose leaves were merged one by one) its first leaf's.
 */
export function originOf(
  effective: EffectiveView,
  path: string,
): string | undefined {
  const own = effective.origins[path];
  if (own !== undefined) return own;
  const prefix = `${path}.`;
  for (const [key, scope] of Object.entries(effective.origins)) {
    if (key.startsWith(prefix) || key.startsWith(`${path}[`)) return scope;
  }
  return undefined;
}

/** What a field shows on a scope's editor. */
export type FieldState =
  | {
      /** Set on this scope. */
      readonly kind: "own";
      /** Its value here. */
      readonly value: unknown;
      /** What it would inherit without it, when known. */
      readonly inherited?: { readonly value: unknown; readonly origin: string };
    }
  | {
      /** Inherited from a scope above. */
      readonly kind: "inherited";
      /** The value it inherits. */
      readonly value: unknown;
      /** The scope it comes from. */
      readonly origin: string;
    }
  | {
      /** Not set anywhere: the built-in default applies. */
      readonly kind: "default";
    };

/**
 * What `path` shows on `scope`'s editor, from the working policy (the
 * draft being edited) and the published effective policy (`undefined` on
 * global, which inherits nothing). A value the effective policy took from
 * this scope itself is not inherited: once removed here, it is the
 * default until published.
 */
export function fieldState(
  working: JsonObject,
  effective: EffectiveView | undefined,
  scope: string,
  path: PolicyPath,
): FieldState {
  const own = getAt(working, path);
  const origin =
    effective === undefined ? undefined : originOf(effective, dotted(path));
  const inherited =
    effective !== undefined && origin !== undefined && origin !== scope
      ? { value: getAt(effective.policy, path), origin }
      : undefined;
  if (own !== undefined) {
    return inherited === undefined
      ? { kind: "own", value: own }
      : { kind: "own", value: own, inherited };
  }
  if (inherited !== undefined) return { kind: "inherited", ...inherited };
  return { kind: "default" };
}

/**
 * The scope that locked a keyed item, when it is one above `scope` (a lock
 * set on `scope` itself binds only the scopes below it).
 */
export function lockedAbove(
  effective: EffectiveView | undefined,
  scope: string,
  path: string,
): string | undefined {
  const by = effective?.locked[path];
  return by === undefined || by === scope ? undefined : by;
}
