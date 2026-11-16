/**
 * A MaxMind DB (`.mmdb`) reader (layers.md L5, the user's Q8 decision: our
 * own, no dependency), written from the published format specification,
 * MaxMind DB File Format 2.0 (maxmind.github.io/MaxMind-DB):
 *
 * - **the search tree**: `node_count` nodes of two records each, records of
 *   24, 28 or 32 bits; a record below `node_count` is the next node, equal
 *   to it means "no data", above it points into the data section
 *   (`record - node_count - 16` bytes from its start);
 * - **the data section** after 16 zero bytes, values in the format's typed
 *   encoding (a control byte with the type and size, pointers to shared
 *   values);
 * - **the metadata** after the last `\xAB\xCD\xEFMaxMind.com`, a map in the
 *   same encoding: `node_count`, `record_size`, `ip_version`,
 *   `database_type`, `build_epoch`, …
 *
 * An IPv4 address in an IPv6 database is looked up under `::/96`, where
 * MaxMind's and DB-IP's databases put IPv4. The file is read once into
 * memory; a lookup walks at most 128 nodes and decodes one record.
 *
 * The file is trusted as an operator's input, but read defensively: every
 * offset is bounds-checked, pointers never chain, and nesting is bounded,
 * so a corrupt file throws {@link MmdbError} rather than hanging or
 * overflowing the stack.
 */
import { parseAddress } from "../ip/address";
import type { ParsedAddress } from "../ip/address";

/** A decoded value: what the format's types decode to. */
export type MmdbValue =
  | string
  | number
  | bigint
  | boolean
  | Uint8Array
  | readonly MmdbValue[]
  | { readonly [key: string]: MmdbValue };

/** The database's metadata (the format's required fields, and its description). */
export interface MmdbMetadata {
  /** Nodes in the search tree. */
  readonly nodeCount: number;
  /** Bits per record: 24, 28 or 32. */
  readonly recordSize: 24 | 28 | 32;
  /** `4` or `6`: the tree's address family. */
  readonly ipVersion: 4 | 6;
  /** What the database holds (`"GeoLite2-Country"`, `"GeoLite2-ASN"`, `"DBIP-Country-Lite"`, …). */
  readonly databaseType: string;
  /** The languages its names are given in. */
  readonly languages: readonly string[];
  /** The format's major version: always `2`. */
  readonly binaryFormatMajorVersion: number;
  /** The format's minor version. */
  readonly binaryFormatMinorVersion: number;
  /** When it was built, Unix seconds. */
  readonly buildEpoch: number;
  /** Its description, by language. */
  readonly description: Readonly<Record<string, string>>;
}

/** A lookup's result: the record, and the prefix length it was found under. */
export interface MmdbResult {
  /** The record. */
  readonly record: MmdbValue;
  /** The network's prefix length, in the address's own family (`/24` for IPv4 in an IPv6 tree, not `/120`). */
  readonly prefixLength: number;
}

/** A malformed or unreadable database. */
export class MmdbError extends Error {
  constructor(
    /** What is wrong with it. */
    message: string,
  ) {
    super(`mmdb: ${message}`);
    this.name = "MmdbError";
  }
}

/** The metadata section's marker. */
const MARKER = Uint8Array.from([
  0xab, 0xcd, 0xef, 0x4d, 0x61, 0x78, 0x4d, 0x69, 0x6e, 0x64, 0x2e, 0x63, 0x6f,
  0x6d,
]);

/** How far from the end the metadata may start (the spec's 128 KiB). */
const METADATA_WINDOW = 128 * 1024;

/** The data section's separator. */
const SEPARATOR = 16;

/** The deepest a map or array may nest. */
const MAX_DEPTH = 64;

/** UTF-8, strict about nothing (the spec says strings are UTF-8). */
const DECODER = new TextDecoder("utf-8");

/** The typed-value decoder over one buffer. */
class Decoder {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** The byte at `offset`, bounds-checked. */
  #byte(offset: number): number {
    const value = this.#bytes[offset];
    if (value === undefined)
      throw new MmdbError(`read past the end at ${offset}`);
    return value;
  }

  /** Throws unless `count` bytes from `offset` are inside the buffer. */
  #need(offset: number, count: number): void {
    if (offset < 0 || offset + count > this.#bytes.length) {
      throw new MmdbError(
        `a value runs past the end (${count} bytes at ${offset})`,
      );
    }
  }

  /** An unsigned big-endian integer of `size` bytes (at most 16). */
  #unsigned(offset: number, size: number): number | bigint {
    this.#need(offset, size);
    if (size <= 6) {
      let value = 0;
      for (let i = 0; i < size; i++)
        value = value * 256 + (this.#bytes[offset + i] ?? 0);
      return value;
    }
    let value = 0n;
    for (let i = 0; i < size; i++) {
      value = (value << 8n) | BigInt(this.#bytes[offset + i] ?? 0);
    }
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  }

  /**
   * Decodes the value at `offset`; pointers resolve against `base`.
   * Answers the value and the offset after it.
   */
  decode(offset: number, base: number, depth = 0): [MmdbValue, number] {
    if (depth > MAX_DEPTH) throw new MmdbError("values nest too deeply");
    const control = this.#byte(offset);
    let at = offset + 1;
    let type = control >> 5;
    if (type === 1) {
      const size = (control >> 3) & 3;
      const low = control & 7;
      let pointer: number;
      if (size === 0) {
        pointer = (low << 8) | this.#byte(at);
        at += 1;
      } else if (size === 1) {
        this.#need(at, 2);
        pointer =
          ((low << 16) | (this.#byte(at) << 8) | this.#byte(at + 1)) + 2048;
        at += 2;
      } else if (size === 2) {
        this.#need(at, 3);
        pointer =
          low * 0x1000000 +
          ((this.#byte(at) << 16) |
            (this.#byte(at + 1) << 8) |
            this.#byte(at + 2)) +
          526336;
        at += 3;
      } else {
        this.#need(at, 4);
        pointer = this.#view.getUint32(at);
        at += 4;
      }
      const target = base + pointer;
      if (this.#byte(target) >> 5 === 1) {
        throw new MmdbError(`a pointer at ${offset} points to another pointer`);
      }
      return [this.decode(target, base, depth + 1)[0], at];
    }
    if (type === 0) {
      type = 7 + this.#byte(at);
      at += 1;
    }
    let size = control & 0x1f;
    if (size === 29) {
      size = 29 + this.#byte(at);
      at += 1;
    } else if (size === 30) {
      this.#need(at, 2);
      size = 285 + ((this.#byte(at) << 8) | this.#byte(at + 1));
      at += 2;
    } else if (size === 31) {
      this.#need(at, 3);
      size =
        65821 +
        ((this.#byte(at) << 16) |
          (this.#byte(at + 1) << 8) |
          this.#byte(at + 2));
      at += 3;
    }
    switch (type) {
      case 2: {
        this.#need(at, size);
        return [DECODER.decode(this.#bytes.subarray(at, at + size)), at + size];
      }
      case 3: {
        if (size !== 8)
          throw new MmdbError(`a double of ${size} bytes at ${offset}`);
        this.#need(at, 8);
        return [this.#view.getFloat64(at), at + 8];
      }
      case 4: {
        this.#need(at, size);
        return [this.#bytes.slice(at, at + size), at + size];
      }
      case 5:
      case 6:
      case 9:
      case 10: {
        const max = type === 5 ? 2 : type === 6 ? 4 : type === 9 ? 8 : 16;
        if (size > max)
          throw new MmdbError(
            `an unsigned integer of ${size} bytes at ${offset}`,
          );
        return [this.#unsigned(at, size), at + size];
      }
      case 7: {
        const map: Record<string, MmdbValue> = {};
        for (let i = 0; i < size; i++) {
          const [key, afterKey] = this.decode(at, base, depth + 1);
          if (typeof key !== "string")
            throw new MmdbError(`a map key at ${at} is not a string`);
          const [value, afterValue] = this.decode(afterKey, base, depth + 1);
          Object.defineProperty(map, key, {
            value,
            enumerable: true,
            writable: false,
            configurable: false,
          });
          at = afterValue;
        }
        return [Object.freeze(map), at];
      }
      case 8: {
        if (size > 4)
          throw new MmdbError(`an int32 of ${size} bytes at ${offset}`);
        const raw = this.#unsigned(at, size) as number;
        return [size === 4 ? raw | 0 : raw, at + size];
      }
      case 11: {
        const items: MmdbValue[] = [];
        for (let i = 0; i < size; i++) {
          const [value, after] = this.decode(at, base, depth + 1);
          items.push(value);
          at = after;
        }
        return [Object.freeze(items), at];
      }
      case 14:
        if (size > 1)
          throw new MmdbError(`a boolean of size ${size} at ${offset}`);
        return [size === 1, at];
      case 15: {
        if (size !== 4)
          throw new MmdbError(`a float of ${size} bytes at ${offset}`);
        this.#need(at, 4);
        return [this.#view.getFloat32(at), at + 4];
      }
      default:
        throw new MmdbError(`unknown or invalid type ${type} at ${offset}`);
    }
  }
}

/** Where the metadata starts (just after the marker), or throws. */
function metadataStart(bytes: Uint8Array): number {
  const floor = Math.max(0, bytes.length - METADATA_WINDOW);
  outer: for (let i = bytes.length - MARKER.length; i >= floor; i--) {
    for (let j = 0; j < MARKER.length; j++) {
      if (bytes[i + j] !== MARKER[j]) continue outer;
    }
    return i + MARKER.length;
  }
  throw new MmdbError("no metadata marker: not a MaxMind DB file");
}

/** A number field of the metadata, or throws. */
function field(map: Record<string, MmdbValue>, name: string): number {
  const value = map[name];
  if (typeof value !== "number")
    throw new MmdbError(`metadata ${name} is missing or not a number`);
  return value;
}

/** Reads the metadata. */
function readMetadata(bytes: Uint8Array, decoder: Decoder): MmdbMetadata {
  const start = metadataStart(bytes);
  const [value] = decoder.decode(start, start);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value instanceof Uint8Array
  ) {
    throw new MmdbError("the metadata is not a map");
  }
  const map = value as Record<string, MmdbValue>;
  const recordSize = field(map, "record_size");
  if (recordSize !== 24 && recordSize !== 28 && recordSize !== 32) {
    throw new MmdbError(`record_size ${recordSize} is not 24, 28 or 32`);
  }
  const ipVersion = field(map, "ip_version");
  if (ipVersion !== 4 && ipVersion !== 6)
    throw new MmdbError(`ip_version ${ipVersion} is not 4 or 6`);
  const major = field(map, "binary_format_major_version");
  if (major !== 2) throw new MmdbError(`binary format ${major} is not 2`);
  const languages = Array.isArray(map.languages)
    ? (map.languages as MmdbValue[]).filter(
        (l): l is string => typeof l === "string",
      )
    : [];
  const description: Record<string, string> = {};
  const rawDescription = map.description;
  if (
    typeof rawDescription === "object" &&
    rawDescription !== null &&
    !Array.isArray(rawDescription)
  ) {
    for (const [key, text] of Object.entries(
      rawDescription as Record<string, MmdbValue>,
    )) {
      if (typeof text === "string") description[key] = text;
    }
  }
  const buildEpoch = map.build_epoch;
  return Object.freeze({
    nodeCount: field(map, "node_count"),
    recordSize,
    ipVersion,
    databaseType:
      typeof map.database_type === "string" ? map.database_type : "",
    languages: Object.freeze(languages),
    binaryFormatMajorVersion: major,
    binaryFormatMinorVersion:
      typeof map.binary_format_minor_version === "number"
        ? map.binary_format_minor_version
        : 0,
    buildEpoch:
      typeof buildEpoch === "number" ? buildEpoch : Number(buildEpoch ?? 0),
    description: Object.freeze(description),
  });
}

/** An open database: {@link MmdbReader.lookup} by address. */
export class MmdbReader {
  /** The metadata. */
  readonly metadata: MmdbMetadata;
  /** The file's bytes. */
  readonly #bytes: Uint8Array;
  /** The decoder. */
  readonly #decoder: Decoder;
  /** The tree's size in bytes. */
  readonly #treeSize: number;
  /** Where the data section starts. */
  readonly #dataStart: number;
  /** The node an IPv4 lookup starts from (after 96 zero bits in an IPv6 tree). */
  readonly #ipv4Start: number;
  /** The view for 32-bit records. */
  readonly #view: DataView;

  constructor(
    /** The whole file. */
    bytes: Uint8Array,
  ) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#decoder = new Decoder(bytes);
    this.metadata = readMetadata(bytes, this.#decoder);
    const { nodeCount, recordSize } = this.metadata;
    this.#treeSize = ((recordSize * 2) / 8) * nodeCount;
    this.#dataStart = this.#treeSize + SEPARATOR;
    if (this.#dataStart > bytes.length) {
      throw new MmdbError(
        `the search tree (${this.#treeSize} bytes) is larger than the file`,
      );
    }
    let node = 0;
    if (this.metadata.ipVersion === 6) {
      for (let i = 0; i < 96 && node < nodeCount; i++)
        node = this.#record(node, 0);
    }
    this.#ipv4Start = node;
  }

  /** The record `side` (0 left, 1 right) of `node`. */
  #record(node: number, side: 0 | 1): number {
    const bytes = this.#bytes;
    switch (this.metadata.recordSize) {
      case 24: {
        const at = node * 6 + side * 3;
        if (at + 3 > this.#treeSize)
          throw new MmdbError(`node ${node} is outside the tree`);
        return (
          ((bytes[at] ?? 0) << 16) |
          ((bytes[at + 1] ?? 0) << 8) |
          (bytes[at + 2] ?? 0)
        );
      }
      case 28: {
        const at = node * 7;
        if (at + 7 > this.#treeSize)
          throw new MmdbError(`node ${node} is outside the tree`);
        const middle = bytes[at + 3] ?? 0;
        return side === 0
          ? ((middle & 0xf0) << 20) |
              ((bytes[at] ?? 0) << 16) |
              ((bytes[at + 1] ?? 0) << 8) |
              (bytes[at + 2] ?? 0)
          : ((middle & 0x0f) << 24) |
              ((bytes[at + 4] ?? 0) << 16) |
              ((bytes[at + 5] ?? 0) << 8) |
              (bytes[at + 6] ?? 0);
      }
      default: {
        const at = node * 8 + side * 4;
        if (at + 4 > this.#treeSize)
          throw new MmdbError(`node ${node} is outside the tree`);
        return this.#view.getUint32(at);
      }
    }
  }

  /**
   * The record for `address` (text or parsed) and its network's prefix
   * length, or `undefined` when the database has none (or the address is
   * IPv6 and the database IPv4, or the text is not an address). Throws
   * {@link MmdbError} on a corrupt tree or record.
   */
  lookupWithPrefix(address: string | ParsedAddress): MmdbResult | undefined {
    const parsed =
      typeof address === "string" ? parseAddress(address) : address;
    if (parsed === null) return undefined;
    const { nodeCount } = this.metadata;
    if (parsed.family === 6 && this.metadata.ipVersion === 4) return undefined;
    const bits = parsed.family === 4 ? 32 : 128;
    let node = parsed.family === 4 ? this.#ipv4Start : 0;
    let depth = 0;
    for (; depth < bits && node < nodeCount; depth++) {
      const word = parsed.words[depth >>> 5] ?? 0;
      const bit = (word >>> (31 - (depth & 31))) & 1;
      node = this.#record(node, bit as 0 | 1);
    }
    if (node === nodeCount) return undefined;
    if (node < nodeCount)
      throw new MmdbError("the tree is deeper than the address");
    const offset = this.#dataStart + (node - nodeCount - SEPARATOR);
    if (offset < this.#dataStart || offset >= this.#bytes.length) {
      throw new MmdbError(`a record points outside the data section (${node})`);
    }
    const [record] = this.#decoder.decode(offset, this.#dataStart);
    return { record, prefixLength: depth };
  }

  /** The record for `address`, or `undefined`; see {@link lookupWithPrefix}. */
  lookup(address: string | ParsedAddress): MmdbValue | undefined {
    return this.lookupWithPrefix(address)?.record;
  }
}

/**
 * Opens a MaxMind DB file: a path (read once into memory), or its bytes.
 * Throws {@link MmdbError} when it is not one. Supply your own file
 * (GeoLite2, DB-IP Lite, IPinfo Lite, a commercial one): none ships with
 * the package.
 */
export async function openMmdb(
  source: string | Uint8Array | ArrayBuffer,
): Promise<MmdbReader> {
  let bytes: Uint8Array;
  if (typeof source === "string") {
    const file = Bun.file(source);
    if (!(await file.exists())) throw new MmdbError(`no file at ${source}`);
    bytes = await file.bytes();
  } else {
    bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  }
  return new MmdbReader(bytes);
}
