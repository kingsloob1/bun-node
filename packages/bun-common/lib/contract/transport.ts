/**
 * Declaring transports and contracts, and carrying contracts at runtime.
 */
import type {
  AnyContract,
  Carries,
  Contract,
  ContractDef,
  ContractMeta,
  Side,
  SideSpec,
  StrictDef,
  Transport,
  TransportSpec,
} from "./model";
import { compileMediaMap } from "./media";
import { CONTRACT } from "./model";
import { opaqueMediaType } from "./schemas";

/** The two sides, in canonical order. */
export const SIDES: readonly Side[] = ["inbound", "outbound"];

/** Whether `value` is a Standard Schema (it has a `~standard` object with a `validate` function). */
export function isSchema(
  value: unknown,
): value is { "~standard": { validate: unknown } } {
  if (typeof value !== "object" && typeof value !== "function") return false;
  if (value === null) return false;
  const props = (value as { "~standard"?: unknown })["~standard"];
  return (
    typeof props === "object" &&
    props !== null &&
    typeof (props as { validate?: unknown }).validate === "function"
  );
}

/** Whether `value` is a plain object (an object literal, or one with a null prototype). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Checks one side of a transport declaration; throws a `TypeError` naming the mistake. */
function checkSideSpec(name: string, side: Side, spec: SideSpec): void {
  const where = `defineTransport("${name}").${side}`;
  if (!Array.isArray(spec.parts)) {
    throw new TypeError(`${where}: "parts" must be an array of part names`);
  }
  const seen = new Set<string>();
  for (const part of spec.parts) {
    if (typeof part !== "string" || part.length === 0) {
      throw new TypeError(
        `${where}: every part name must be a non-empty string`,
      );
    }
    if (seen.has(part)) {
      throw new TypeError(`${where}: the part "${part}" is listed twice`);
    }
    seen.add(part);
  }
  if (spec.key !== undefined) {
    if (typeof spec.key !== "string" || spec.key.length === 0) {
      throw new TypeError(`${where}: "key" must be a non-empty string`);
    }
    if (seen.has(spec.key)) {
      throw new TypeError(
        `${where}: the key "${spec.key}" cannot also be a part`,
      );
    }
  }
  for (const part of spec.media ?? []) {
    if (!seen.has(part)) {
      throw new TypeError(`${where}: media part "${part}" is not a part`);
    }
  }
  for (const part of Object.keys(spec.encodings ?? {})) {
    if (!seen.has(part)) {
      throw new TypeError(`${where}: the encoding for "${part}" names no part`);
    }
  }
}

/** Checks one message shape's part declarations against its side. */
function checkParts(where: string, spec: SideSpec, parts: unknown): void {
  if (!isPlainObject(parts)) {
    throw new TypeError(`${where}: expected an object of parts`);
  }
  for (const [part, decl] of Object.entries(parts)) {
    if (!spec.parts.includes(part)) {
      throw new TypeError(
        `${where}: "${part}" is not a part (${spec.parts.join(", ")})`,
      );
    }
    if (decl === undefined || decl === null || isSchema(decl)) continue;
    if (!(spec.media ?? []).includes(part)) {
      throw new TypeError(
        `${where}: "${part}" must be a Standard Schema or null`,
      );
    }
    if (!isPlainObject(decl)) {
      throw new TypeError(
        `${where}: "${part}" must be a Standard Schema, a media map or null`,
      );
    }
    for (const [mediaType, schema] of Object.entries(decl)) {
      if (schema !== null && !isSchema(schema)) {
        throw new TypeError(
          `${where}: "${part}" media type "${mediaType}" must be a Standard Schema or null`,
        );
      }
      const own = opaqueMediaType(schema);
      if (own !== undefined) {
        throw new TypeError(
          `${where}: "${part}" media type "${mediaType}": opaque(${JSON.stringify(own)}) names a second media type; inside a media map write opaque()`,
        );
      }
    }
    // Every key a media type, no two tying once bare (plan Q-C14).
    compileMediaMap(decl, `${where}: "${part}"`);
  }
}

/** Checks a contract's declaration against its transport; throws a `TypeError` naming the mistake. */
export function checkContractDef(spec: TransportSpec, def: unknown): void {
  if (!isPlainObject(def)) {
    throw new TypeError(`${spec.name}.contract(): expected an object of sides`);
  }
  for (const [side, sideDef] of Object.entries(def)) {
    if (sideDef === undefined) continue;
    const s =
      side === "inbound" || side === "outbound" ? spec[side] : undefined;
    if (s === undefined) {
      throw new TypeError(`${spec.name}.contract(): no ${side} side`);
    }
    const where = `${spec.name}.contract().${side}`;
    if (s.key === undefined) {
      checkParts(where, s, sideDef);
      continue;
    }
    if (!isPlainObject(sideDef)) {
      throw new TypeError(`${where}: expected an object keyed by ${s.key}`);
    }
    for (const [key, parts] of Object.entries(sideDef)) {
      checkParts(`${where}[${JSON.stringify(key)}]`, s, parts);
    }
  }
}

/**
 * Builds a contract object without checking its declaration (the caller
 * has). It carries itself, so `getContract(contract)` is the contract.
 */
export function makeContract<T extends TransportSpec, D>(
  spec: T,
  def: D,
  meta: ContractMeta,
): Contract<T, D> {
  const contract = { transport: spec, def, meta } as Contract<T, D>;
  return attachContract(contract, contract);
}

/**
 * Declares a transport by its part and key names (plan §4.1.1); typing,
 * validation and document rows follow from it. A key that is also a part, a
 * media part or encoding that names no part, and a repeated part are
 * `TypeError`s.
 *
 * @param spec The transport's name and sides.
 *
 * @example
 * ```ts
 * const udp = defineTransport({
 *   name: "udp",
 *   inbound: { key: "type", parts: ["payload"] },
 *   outbound: { key: "type", parts: ["payload"] },
 * });
 * const chat = udp.contract({
 *   inbound: { "chat.post": { payload: z.object({ text: z.string() }) } },
 *   outbound: { "chat.ack": { payload: z.object({ seq: z.number() }) } },
 * });
 * ```
 */
export function defineTransport<const T extends TransportSpec>(
  spec: T,
): Transport<T> {
  if (typeof spec?.name !== "string" || spec.name.length === 0) {
    throw new TypeError('defineTransport(): "name" must be a non-empty string');
  }
  if (
    spec.wire !== undefined &&
    spec.wire !== "json" &&
    spec.wire !== "identity"
  ) {
    throw new TypeError(
      `defineTransport("${spec.name}"): "wire" is "json" or "identity"`,
    );
  }
  for (const side of SIDES) {
    const s = spec[side];
    if (s !== undefined) checkSideSpec(spec.name, side, s);
  }
  const contract = <const D extends ContractDef<T>>(
    def: D & StrictDef<T, D>,
    meta: ContractMeta = {},
  ): Contract<T, D> => {
    checkContractDef(spec, def);
    return makeContract(spec, def as D, meta);
  };
  return { spec, contract };
}

/**
 * The reflect-metadata polyfill's API, when it is loaded (a Nest application's
 * always is). bun-common neither imports nor types it: the structural view
 * keeps this module usable where the polyfill is absent.
 */
const reflectMeta = Reflect as unknown as {
  getMetadata?: (key: unknown, target: object) => unknown;
  defineMetadata?: (key: unknown, value: unknown, target: object) => void;
};

/**
 * Makes `contract` reachable from `target` through {@link getContract}: a
 * non-enumerable property, so code that enumerates the target sees nothing
 * new. Attaching again replaces it. Returns `target`, typed as carrying it.
 *
 * When the reflect-metadata polyfill is loaded, the contract is ALSO written
 * as metadata under the same symbol, so a framework that copies metadata when
 * it wraps a handler (NestJS's `RouterExplorer.copyMetadataToCallback`) keeps
 * it attached to the wrapper — without one, a Nest controller method's
 * contract would stay behind on the unwrapped method, invisible to
 * `listRoutes` and the document generators.
 *
 * @param target   What carries the contract: a handler, a layer, a definition.
 * @param contract The contract to carry.
 */
export function attachContract<X extends object, C>(
  target: X,
  contract: C,
): X & Carries<C> {
  Object.defineProperty(target, CONTRACT, {
    value: contract,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  reflectMeta.defineMetadata?.(CONTRACT, contract, target);
  return target as X & Carries<C>;
}

/**
 * The contract `carrier` carries: typed when its type says which, otherwise
 * `AnyContract | undefined` (anything without one, primitives included).
 *
 * Reads the own property first, then — when the reflect-metadata polyfill is
 * loaded — the metadata under the same symbol (what a framework's metadata
 * copy carries onto a wrapped handler; see {@link attachContract}).
 *
 * @param carrier A handler, a layer, a definition, or a contract itself.
 */
export function getContract<C>(carrier: Carries<C>): C;
export function getContract(carrier: unknown): AnyContract | undefined;
export function getContract(carrier: unknown): unknown {
  if (
    (typeof carrier !== "object" && typeof carrier !== "function") ||
    carrier === null
  ) {
    return undefined;
  }
  return (
    (carrier as Partial<Carries<unknown>>)[CONTRACT] ??
    reflectMeta.getMetadata?.(CONTRACT, carrier)
  );
}

/**
 * Copies the contract `inner` carries onto `wrapper`, for middleware that
 * wraps another (`deferred(validate(schemas))`) and would otherwise hide its
 * contract from a route listing (plan §4.12 M5). A no-op when `inner` carries
 * none. Returns `wrapper`.
 *
 * @param wrapper The function or object registered in `inner`'s place.
 * @param inner   What it wraps.
 */
export function forwardContract<W extends object, I>(
  wrapper: W,
  inner: I,
): W & (I extends Carries<infer C> ? Carries<C> : unknown) {
  const contract = getContract(inner);
  if (contract !== undefined) attachContract(wrapper, contract);
  return wrapper as W & (I extends Carries<infer C> ? Carries<C> : unknown);
}
