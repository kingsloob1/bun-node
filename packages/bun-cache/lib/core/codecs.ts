/**
 * The value codecs (plan §3.10): `"structured"` (the default, `bun:jsc`),
 * `"json"`, `"raw"`, and custom codecs with ids 128–255. The id is stored per
 * entry, so entries written by different codecs decode with their own.
 */
import { deserialize, serialize } from "bun:jsc";
import type { Codec } from "./types";

/** The built-in codec ids. Ids 0–127 are reserved for the package. */
export const CODEC_IDS = {
  /** `bun:jsc` structured clone (the default). */
  structured: 1,
  /** JSON. */
  json: 2,
  /** `Uint8Array` and `string`, unchanged. */
  raw: 3,
} as const;

/** The id range a custom codec may use (§3.10). */
export const CUSTOM_CODEC_RANGE = { min: 128, max: 255 } as const;

/** `"structured"`: `bun:jsc`'s `serialize`/`deserialize`. Round-trips `Date`, `Map`, `Set`, `Uint8Array`, `BigInt`, `NaN`, `RegExp`, `Error`; class instances become plain objects; cycles throw. */
export const structuredCodec: Codec = {
  id: CODEC_IDS.structured,
  encode(value: unknown): Uint8Array {
    const bytes = serialize(value);
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  },
  decode(bytes: Uint8Array): unknown {
    return deserialize(bytes);
  },
};

/** `"json"`: UTF-8 JSON. `Date` becomes a string, `Map`/`Set`/`Uint8Array` become objects, `BigInt` throws. */
export const jsonCodec: Codec = {
  id: CODEC_IDS.json,
  encode(value: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(value));
  },
  decode(bytes: Uint8Array): unknown {
    return JSON.parse(new TextDecoder().decode(bytes));
  },
};

/** `"raw"`: `Uint8Array` passes through; a `string` is its UTF-8 bytes (the header's `rawString` flag remembers which). */
export const rawCodec: Codec = {
  id: CODEC_IDS.raw,
  encode(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) {
      return value;
    }
    if (typeof value === "string") {
      return new TextEncoder().encode(value);
    }
    throw new TypeError(
      `the "raw" codec stores Uint8Array and string, not ${
        value === null ? "null" : typeof value
      }`,
    );
  },
  decode(bytes: Uint8Array): unknown {
    return bytes;
  },
};

/** The built-in codecs by id. */
const BUILT_INS: ReadonlyMap<number, Codec> = new Map(
  [structuredCodec, jsonCodec, rawCodec].map((codec) => [codec.id, codec]),
);

/**
 * Resolves a `codec` option to its {@link Codec}. A custom codec's id must be
 * in 128–255 (0–127 are the package's), or a `TypeError` is thrown.
 */
export function resolveCodec(
  option: "structured" | "json" | "raw" | Codec | undefined,
): Codec {
  if (option === undefined || option === "structured") {
    return structuredCodec;
  }
  if (option === "json") {
    return jsonCodec;
  }
  if (option === "raw") {
    return rawCodec;
  }
  if (
    !Number.isInteger(option.id) ||
    option.id < CUSTOM_CODEC_RANGE.min ||
    option.id > CUSTOM_CODEC_RANGE.max
  ) {
    throw new TypeError(
      `a custom codec's id must be an integer in ${CUSTOM_CODEC_RANGE.min}–${CUSTOM_CODEC_RANGE.max} (0–127 are reserved), not ${String(
        option.id,
      )}`,
    );
  }
  if (BUILT_INS.has(option.id)) {
    throw new TypeError(`codec id ${option.id} belongs to a built-in codec`);
  }
  return option;
}

/**
 * The codec for an entry's codec id: a built-in, or the cache's configured
 * custom codec. `undefined` when the id is unknown — the entry is then a miss
 * (§3.2).
 */
export function codecById(
  id: number,
  custom: Codec | undefined,
): Codec | undefined {
  return BUILT_INS.get(id) ?? (custom?.id === id ? custom : undefined);
}
