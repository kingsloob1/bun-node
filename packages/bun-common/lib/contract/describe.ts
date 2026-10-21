/**
 * Reading a contract back: the rows an OpenAPI or AsyncAPI generator, a
 * route model or a typed client walks (plan §4.1.5), and the merge of
 * layered contracts (plan Q-C11).
 */
import type { LoggerLike } from "../logging";
import type {
  AnyContract,
  Contract,
  ContractDef,
  ContractEncoding,
  ContractKind,
  ContractMeta,
  ContractWire,
  PartDecl,
  Schema,
  Side,
  SideSpec,
  TransportSpec,
} from "./model";
import { resolveLogger } from "../logging";
import { isDocumented, isImplicit, jsonSchemaOf, kindOf } from "./schemas";
import { isSchema, makeContract, SIDES } from "./transport";

/** One schema in a contract, located. */
export interface ContractEntry {
  /** The side it belongs to. */
  side: Side;
  /** The transport's key field (`"status"`, `"type"`), on a keyed side. */
  keyName?: string;
  /** The key (`"200"`, `"chat.post"`), on a keyed side, always as a string. */
  key?: string;
  /** The part. */
  part: string;
  /** The declared media type, on a media-typed part. */
  mediaType?: string;
  /** What kind of value the row is (plan §4.12 M4); `"value"` unless a response helper said otherwise. */
  kind: ContractKind;
  /** How the part travels on the wire (plan §4.12 m3), from the transport's declaration. */
  encoding: ContractEncoding;
  /** The layer the row came from, after `mergeContracts`; absent on an unmerged contract. */
  origin?: string;
  /** The schema, or `null` for a part declared absent (a 204's body). */
  schema: Schema | null;
  /** The schema's vendor (`"zod"`); `"bun-common/documented"` for `documented()`. */
  vendor?: string;
  /**
   * `true` on a row the framework declared rather than the app: a
   * validator's own failure status under `onFailure: "respond"` (plan §4.12
   * m5). Absent otherwise.
   */
  implicit?: true;
}

/**
 * A contract flattened for generators: what the transport is, which sides
 * and keys it declares (even a key with no parts, `202: {}`, so "nothing
 * declared" and "declared empty" differ, plan §4.12 B1), and one row per
 * `(side, key, part, mediaType)`: `describeContract`'s return type.
 */
export interface ContractDescription {
  /** The transport's name. */
  transport: string;
  /** What the wire does to values, for client types to apply (plan Q-C5). */
  wire: ContractWire;
  /** The contract's documentation metadata. */
  meta: ContractMeta;
  /** The sides the contract declares; a side it leaves out is absent here. */
  sides: {
    /** The inbound side, when declared. */
    inbound?: {
      /** Always `true`: the side is declared, perhaps empty. */
      declared: true;
      /** The declared keys in canonical order, on a keyed side. */
      keys?: string[];
    };
    /** The outbound side, when declared. */
    outbound?: {
      /** Always `true`: the side is declared, perhaps empty. */
      declared: true;
      /** The declared keys in canonical order, on a keyed side. */
      keys?: string[];
    };
  };
  /**
   * The rows. Treat them as unordered; they are emitted in a canonical order
   * (plan §4.12 m1): inbound then outbound; numeric keys ascending, then
   * other keys in code-unit order; parts as the transport lists them; media
   * types in code-unit order.
   */
  entries: ContractEntry[];
}

/** Where `mergeContracts` keeps each part's origin, by {@link unitId}. */
const ORIGINS: unique symbol = Symbol.for("bun-validate.origins");

/** A canonical integer key (`"200"`), sorted numerically. */
const INTEGER_KEY = /^(?:0|[1-9]\d*)$/;

/** Code-unit order, so the order never depends on a locale. */
const byCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** Keys in canonical order: integers ascending, then the rest in code-unit order. */
function canonicalKeys(keys: readonly string[]): string[] {
  const numeric = keys.filter((k) => INTEGER_KEY.test(k));
  const other = keys.filter((k) => !INTEGER_KEY.test(k));
  return [
    ...numeric.sort((a, b) => Number(a) - Number(b)),
    ...other.sort(byCodeUnit),
  ];
}

/** The identity of one merge unit: a side, a key and a part. */
function unitId(side: Side, key: string | undefined, part: string): string {
  return `${side}\u0000${key ?? ""}\u0000${part}`;
}

/** A side's declarations, as `[key, parts]` pairs (`key` absent on an unkeyed side). */
function variants(
  spec: SideSpec,
  def: unknown,
): [string | undefined, Record<string, unknown>][] {
  if (typeof def !== "object" || def === null) return [];
  return spec.key === undefined
    ? [[undefined, def as Record<string, unknown>]]
    : Object.entries(def as Record<string, Record<string, unknown>>);
}

/**
 * Flattens a contract into its declared sides and keys, and one row per
 * `(side, key, part, mediaType)` with its kind, wire encoding, origin, schema
 * and vendor. A generator reads only this; the core never converts a schema
 * to JSON Schema (`~standard.jsonSchema` is the schema's own).
 *
 * @param contract Any contract (a merged one gives each row its origin).
 */
export function describeContract(contract: AnyContract): ContractDescription {
  const origins = (contract as { [ORIGINS]?: ReadonlyMap<string, string> })[
    ORIGINS
  ];
  const sides: ContractDescription["sides"] = {};
  const entries: ContractEntry[] = [];
  for (const side of SIDES) {
    const spec = contract.transport[side];
    const def = (contract.def as Partial<Record<Side, unknown>> | undefined)?.[
      side
    ];
    if (spec === undefined || def === undefined) continue;
    const found = variants(spec, def);
    const byKey = new Map(found);
    const keys =
      spec.key === undefined
        ? [undefined]
        : canonicalKeys(found.map(([k]) => k as string));
    sides[side] =
      spec.key === undefined
        ? { declared: true }
        : { declared: true, keys: keys as string[] };
    for (const key of keys) {
      const parts = byKey.get(key) ?? {};
      for (const part of spec.parts) {
        const decl = parts[part] as PartDecl | undefined;
        if (decl === undefined) continue;
        const origin = origins?.get(unitId(side, key, part));
        const base = {
          side,
          ...(spec.key === undefined ? {} : { keyName: spec.key, key }),
          part,
          encoding: spec.encodings?.[part] ?? "body",
          ...(origin === undefined ? {} : { origin }),
        };
        if (decl === null) {
          entries.push({ ...base, kind: "value", schema: null });
        } else if (isSchema(decl)) {
          entries.push({
            ...base,
            kind: kindOf(decl),
            schema: decl,
            vendor: decl["~standard"].vendor,
            ...(isImplicit(decl) ? { implicit: true as const } : {}),
          });
        } else {
          for (const mediaType of Object.keys(decl).sort(byCodeUnit)) {
            const schema = decl[mediaType];
            entries.push({
              ...base,
              mediaType,
              kind: kindOf(schema),
              schema,
              vendor: schema["~standard"].vendor,
              ...(isImplicit(schema) ? { implicit: true as const } : {}),
            });
          }
        }
      }
    }
  }
  return {
    transport: contract.transport.name,
    wire: contract.transport.wire ?? "json",
    meta: contract.meta,
    sides,
    entries,
  };
}

/** One declaration of a merge unit, with the layer it came from. */
interface Candidate {
  /** The part's declaration. */
  decl: PartDecl;
  /** The layer's origin. */
  origin: string;
  /** Whether it checks anything (`documented()` does not). */
  checks: boolean;
  /** Whether the framework declared it (`markImplicit`), so any declared candidate wins over it. */
  implicit: boolean;
}

/** Whether a declaration is the framework's own: an implicit schema, or a media map of only implicit ones. */
function declImplicit(decl: PartDecl): boolean {
  if (decl === null) return false;
  if (isSchema(decl)) return isImplicit(decl);
  const schemas = Object.values(decl);
  return schemas.length > 0 && schemas.every((s) => isImplicit(s));
}

/** Whether a declaration checks anything at runtime. */
function declChecks(decl: PartDecl): boolean {
  if (decl === null) return true;
  if (isSchema(decl)) return !isDocumented(decl);
  return Object.values(decl).some((s) => !isDocumented(s));
}

/** JSON with sorted keys and no `$schema`, so two JSON Schemas compare by content. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort(byCodeUnit)) {
      if (k !== "$schema") sorted[k] = (v as Record<string, unknown>)[k];
    }
    return sorted;
  });
}

/** A declaration's JSON Schema documents by media type (`""` for a plain schema), or `undefined` where a member has none. */
function jsonDocs(decl: PartDecl): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  const one = (key: string, schema: Schema): void => {
    const converter = jsonSchemaOf(schema);
    try {
      out.set(
        key,
        converter === undefined
          ? undefined
          : canonicalJson(converter.input({ target: "draft-2020-12" })),
      );
    } catch {
      out.set(key, undefined);
    }
  };
  if (decl === null) out.set("", "null");
  else if (isSchema(decl)) one("", decl);
  else for (const [k, s] of Object.entries(decl)) one(k, s);
  return out;
}

/**
 * Merges the contracts of nested layers into the one that applies (plan
 * Q-C11, §4.12 M3). `layers` run **outermost first** (an adapter, then a
 * router, then a route), all for one transport. Per side, key and part:
 *
 * - **inbound**, the outermost layer declaring the part is the wire schema
 *   (it sees the raw value); a later one only refines what it produced, and
 *   each such refinement is logged as a warning;
 * - **outbound**, the innermost wins: a route over its router over the
 *   adapter;
 * - a checking schema wins over a `documented()` one wherever they sit, with
 *   a warning when the two JSON Schemas disagree (or cannot be compared);
 * - a part the app declares wins over one the framework declared on its own
 *   (an `implicit` row, plan §4.12 m5) wherever they sit, with no warning.
 *
 * Every part of the result records the origin it came from, which
 * `describeContract` puts on each row. The result is a contract like any
 * other, so it can be described or guarded.
 *
 * @param layers  The layers' contracts, outermost first, each with its origin (a layer's name or path).
 * @param options Where warnings go.
 * @param options.logger Receives the warnings; default bun-common's console logger.
 */
export function mergeContracts<T extends TransportSpec>(
  layers: readonly {
    /** The layer's contract. */
    readonly contract: Contract<T, unknown>;
    /** What the layer is (`"adapter"`, `"router /users"`, `"GET /users/:id"`), recorded on each row it wins. */
    readonly origin: string;
  }[],
  options: {
    /** Receives the merge's warnings. */
    readonly logger?: LoggerLike;
  } = {},
): Contract<T, ContractDef<T>> {
  if (layers.length === 0) {
    throw new TypeError("mergeContracts(): expected at least one layer");
  }
  const transport = layers[0].contract.transport;
  for (const layer of layers) {
    if (layer.contract.transport.name !== transport.name) {
      throw new TypeError(
        `mergeContracts(): every layer must be for one transport ("${transport.name}", not "${layer.contract.transport.name}")`,
      );
    }
  }
  let logger: ReturnType<typeof resolveLogger> | undefined;
  const warn = (message: string, fields: Record<string, unknown>): void => {
    logger ??= resolveLogger(options.logger);
    logger.warn(message, { transport: transport.name, ...fields });
  };

  const def: Partial<Record<Side, Record<string, unknown>>> = {};
  const origins = new Map<string, string>();
  for (const side of SIDES) {
    const spec = transport[side];
    if (spec === undefined) continue;
    // unit → candidates in layer order; keys in first-seen order.
    const units = new Map<string, Candidate[]>();
    const keys = new Map<string | undefined, Set<string>>();
    let declared = false;
    for (const layer of layers) {
      const sideDef = (layer.contract.def as Partial<Record<Side, unknown>>)?.[
        side
      ];
      if (sideDef === undefined) continue;
      declared = true;
      for (const [key, parts] of variants(spec, sideDef)) {
        if (!keys.has(key)) keys.set(key, new Set());
        for (const part of spec.parts) {
          const decl = parts[part] as PartDecl | undefined;
          if (decl === undefined) continue;
          keys.get(key)!.add(part);
          const id = unitId(side, key, part);
          const list = units.get(id) ?? [];
          list.push({
            decl,
            origin: layer.origin,
            checks: declChecks(decl),
            implicit: declImplicit(decl),
          });
          units.set(id, list);
        }
      }
    }
    if (!declared) continue;
    const merged: Record<string, Record<string, unknown>> = {};
    for (const [key, parts] of keys) {
      const out: Record<string, unknown> = {};
      for (const part of spec.parts) {
        if (!parts.has(part)) continue;
        const id = unitId(side, key, part);
        // A part the app declares wins over the framework's implicit one
        // wherever they sit, and is never compared with it.
        const all = units.get(id)!;
        const declared = all.filter((c) => !c.implicit);
        const candidates = declared.length > 0 ? declared : all;
        const checking = candidates.filter((c) => c.checks);
        const pool = checking.length > 0 ? checking : candidates;
        const winner = side === "inbound" ? pool[0] : pool[pool.length - 1];
        out[part] = winner.decl;
        origins.set(id, winner.origin);
        const where = {
          side,
          ...(key === undefined ? {} : { key }),
          part,
        };
        if (side === "inbound" && checking.length > 1) {
          warn("contract part refined by an inner layer", {
            ...where,
            wire: winner.origin,
            refinedBy: checking.slice(1).map((c) => c.origin),
          });
        }
        if (winner.checks) {
          const wanted = jsonDocs(winner.decl);
          for (const doc of candidates.filter((c) => !c.checks)) {
            const given = jsonDocs(doc.decl);
            const comparable = [...given].every(
              ([k, v]) => v !== undefined && wanted.get(k) !== undefined,
            );
            const agrees =
              comparable &&
              given.size === wanted.size &&
              [...given].every(([k, v]) => wanted.get(k) === v);
            if (!agrees) {
              warn(
                comparable
                  ? "documented schema disagrees with the validator, which wins"
                  : "documented schema cannot be compared with the validator, which wins",
                { ...where, validator: winner.origin, documented: doc.origin },
              );
            }
          }
        }
      }
      merged[key ?? ""] = out;
    }
    def[side] = spec.key === undefined ? merged[""] : merged;
  }
  const meta = Object.assign(
    {},
    ...layers.map((l) => l.contract.meta),
  ) as ContractMeta;
  const contract = makeContract(transport, def as ContractDef<T>, meta);
  Object.defineProperty(contract, ORIGINS, {
    value: origins,
    enumerable: false,
  });
  return contract;
}
