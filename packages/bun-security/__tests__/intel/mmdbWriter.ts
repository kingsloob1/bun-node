/**
 * A small MaxMind DB writer for the tests, from the format specification
 * (maxmind.github.io/MaxMind-DB, version 2.0), so the suites read databases
 * they wrote themselves and no MaxMind data ships with the repository.
 *
 * It builds the search tree from CIDR → record entries (IPv4 entries of an
 * IPv6 database go under `::/96`), numbers the nodes breadth first, writes
 * each record once (an identical record is shared), and can emit
 * pointers: every repeated string goes through one, with a chosen pointer
 * size, so the reader's pointer decoding is exercised.
 */
import { parseCidr } from "../../lib/ip/address";

/** A value the writer encodes, with its MMDB type where a JS value is ambiguous. */
export type WriterValue =
  | string
  | boolean
  | readonly WriterValue[]
  | { readonly [key: string]: WriterValue }
  | Typed;

/** A value with an explicit type. */
export interface Typed {
  /** The MMDB type. */
  readonly $type:
    | "uint16"
    | "uint32"
    | "uint64"
    | "uint128"
    | "int32"
    | "double"
    | "float"
    | "bytes";
  /** The value. */
  readonly value: number | bigint | Uint8Array;
}

/** Shorthands. */
export const u16 = (value: number): Typed => ({ $type: "uint16", value });
export const u32 = (value: number): Typed => ({ $type: "uint32", value });
export const u64 = (value: bigint | number): Typed => ({
  $type: "uint64",
  value,
});
export const u128 = (value: bigint): Typed => ({ $type: "uint128", value });
export const i32 = (value: number): Typed => ({ $type: "int32", value });
export const f64 = (value: number): Typed => ({ $type: "double", value });
export const f32 = (value: number): Typed => ({ $type: "float", value });
export const bytes = (value: Uint8Array): Typed => ({ $type: "bytes", value });

/** What to write. */
export interface WriteOptions {
  /** `4` or `6`. Default `6`. */
  readonly ipVersion?: 4 | 6;
  /** 24, 28 or 32. Default `24`. */
  readonly recordSize?: 24 | 28 | 32;
  /** The database type. Default `"Test"`. */
  readonly databaseType?: string;
  /** Strings at least this long that repeat are written once and pointed to. Default: no pointers. */
  readonly pointers?: {
    readonly minLength: number;
    readonly size: 0 | 1 | 2 | 3;
  };
  /** Bytes of filler before the records (to push pointers past 2048 or 526336). Default 0. */
  readonly padding?: number;
  /** The build time, Unix seconds. Default 1_700_000_000. */
  readonly buildEpoch?: number;
}

/** A tree node: two children, each a node, a record index, or empty. */
interface Node {
  left: Node | number | null;
  right: Node | number | null;
}

/** The control bytes of a type and size. */
function control(type: number, size: number): number[] {
  const out: number[] = [];
  let sizeBits: number;
  const extra: number[] = [];
  if (size < 29) sizeBits = size;
  else if (size < 285) {
    sizeBits = 29;
    extra.push(size - 29);
  } else if (size < 65821) {
    sizeBits = 30;
    const n = size - 285;
    extra.push(n >> 8, n & 0xff);
  } else {
    sizeBits = 31;
    const n = size - 65821;
    extra.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  if (type <= 7) out.push((type << 5) | sizeBits);
  else out.push(sizeBits, type - 7);
  return [...out, ...extra];
}

/** Big-endian bytes of an unsigned value, minimal length. */
function unsignedBytes(value: number | bigint): number[] {
  let n = BigInt(value);
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return out;
}

/** The encoder of one section (data or metadata). */
class Encoder {
  readonly out: number[] = [];
  /** Offsets of strings already written, for pointers. */
  readonly #strings = new Map<string, number>();

  constructor(readonly pointers?: WriteOptions["pointers"]) {}

  /** A pointer to `offset`, of the chosen size. */
  #pointer(offset: number): number[] {
    const size = this.pointers?.size ?? 0;
    if (size === 0) {
      if (offset >= 2048)
        throw new RangeError("a size-0 pointer holds under 2048");
      return [0x20 | (offset >> 8), offset & 0xff];
    }
    if (size === 1) {
      const n = offset - 2048;
      if (n < 0 || n >= 1 << 19)
        throw new RangeError("a size-1 pointer holds 2048 to 526335");
      return [0x28 | (n >> 16), (n >> 8) & 0xff, n & 0xff];
    }
    if (size === 2) {
      const n = offset - 526336;
      if (n < 0) throw new RangeError("a size-2 pointer holds 526336 and up");
      return [
        0x30 | Math.floor(n / 0x1000000),
        (n >> 16) & 0xff,
        (n >> 8) & 0xff,
        n & 0xff,
      ];
    }
    return [
      0x38,
      (offset >>> 24) & 0xff,
      (offset >> 16) & 0xff,
      (offset >> 8) & 0xff,
      offset & 0xff,
    ];
  }

  /** Writes `value`. */
  write(value: WriterValue): void {
    const out = this.out;
    if (typeof value === "string") {
      const minLength = this.pointers?.minLength;
      const seen = this.#strings.get(value);
      if (
        minLength !== undefined &&
        value.length >= minLength &&
        seen !== undefined
      ) {
        out.push(...this.#pointer(seen));
        return;
      }
      if (minLength !== undefined && value.length >= minLength)
        this.#strings.set(value, out.length);
      const encoded = new TextEncoder().encode(value);
      out.push(...control(2, encoded.length));
      for (const b of encoded) out.push(b);
      return;
    }
    if (typeof value === "boolean") {
      out.push(...control(14, value ? 1 : 0));
      return;
    }
    if (Array.isArray(value)) {
      out.push(...control(11, value.length));
      for (const item of value as WriterValue[]) this.write(item);
      return;
    }
    if (typeof value === "object" && value !== null && "$type" in value) {
      const typed = value as Typed;
      switch (typed.$type) {
        case "uint16":
        case "uint32":
        case "uint64":
        case "uint128": {
          const type = { uint16: 5, uint32: 6, uint64: 9, uint128: 10 }[
            typed.$type
          ];
          const b = unsignedBytes(typed.value as number | bigint);
          out.push(...control(type, b.length), ...b);
          return;
        }
        case "int32": {
          const n = (typed.value as number) | 0;
          const b =
            n < 0
              ? [
                  (n >>> 24) & 0xff,
                  (n >>> 16) & 0xff,
                  (n >>> 8) & 0xff,
                  n & 0xff,
                ]
              : unsignedBytes(n);
          out.push(...control(8, b.length), ...b);
          return;
        }
        case "double": {
          const view = new DataView(new ArrayBuffer(8));
          view.setFloat64(0, typed.value as number);
          out.push(...control(3, 8), ...new Uint8Array(view.buffer));
          return;
        }
        case "float": {
          const view = new DataView(new ArrayBuffer(4));
          view.setFloat32(0, typed.value as number);
          out.push(...control(15, 4), ...new Uint8Array(view.buffer));
          return;
        }
        default: {
          const b = typed.value as Uint8Array;
          out.push(...control(4, b.length), ...b);
          return;
        }
      }
    }
    const entries = Object.entries(value as Record<string, WriterValue>);
    out.push(...control(7, entries.length));
    for (const [key, item] of entries) {
      this.write(key);
      this.write(item);
    }
  }
}

/** Writes a database holding `entries` (CIDR → record). */
export function writeMmdb(
  entries: readonly (readonly [string, WriterValue])[],
  options: WriteOptions = {},
): Uint8Array {
  const ipVersion = options.ipVersion ?? 6;
  const recordSize = options.recordSize ?? 24;
  const root: Node = { left: null, right: null };
  const records: WriterValue[] = [];
  const recordIndex = new Map<string, number>();
  for (const [cidrText, record] of entries) {
    const cidr = parseCidr(cidrText);
    if (cidr === null) throw new TypeError(`not a range: ${cidrText}`);
    if (cidr.family === 6 && ipVersion === 4)
      throw new TypeError("IPv6 range in an IPv4 database");
    const key = JSON.stringify(record, (_k, v: unknown) =>
      typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? [...v] : v,
    );
    let index = recordIndex.get(key);
    if (index === undefined) {
      index = records.length;
      records.push(record);
      recordIndex.set(key, index);
    }
    // The bit path: 96 zero bits first for IPv4 in an IPv6 tree.
    const path: number[] = [];
    if (cidr.family === 4 && ipVersion === 6)
      for (let i = 0; i < 96; i++) path.push(0);
    for (let i = 0; i < cidr.bits; i++) {
      const word = cidr.words[i >>> 5] ?? 0;
      path.push((word >>> (31 - (i & 31))) & 1);
    }
    let node = root;
    for (let i = 0; i < path.length; i++) {
      const side = path[i] === 0 ? "left" : "right";
      if (i === path.length - 1) {
        node[side] = index;
        break;
      }
      const child = node[side];
      if (child === null || typeof child === "number") {
        // A less specific record already here: both halves keep it.
        const next: Node = { left: child, right: child };
        node[side] = next;
        node = next;
      } else {
        node = child;
      }
    }
  }
  // Number the nodes breadth first.
  const nodes: Node[] = [];
  const ids = new Map<Node, number>();
  const queue: Node[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    ids.set(node, nodes.length);
    nodes.push(node);
    for (const child of [node.left, node.right]) {
      if (child !== null && typeof child === "object") queue.push(child);
    }
  }
  const nodeCount = nodes.length;
  // The data section: padding, then each record.
  const data = new Encoder(options.pointers);
  for (let i = 0; i < (options.padding ?? 0); i++) data.out.push(0x40); // empty strings (type 2, size 0)
  const offsets = records.map((record) => {
    const at = data.out.length;
    data.write(record);
    return at;
  });
  const value = (child: Node | number | null): number =>
    child === null
      ? nodeCount
      : typeof child === "number"
        ? nodeCount + 16 + (offsets[child] ?? 0)
        : (ids.get(child) ?? 0);
  const recordBytes = (recordSize * 2) / 8;
  const tree = new Uint8Array(nodeCount * recordBytes);
  for (const [i, node] of nodes.entries()) {
    const left = value(node.left);
    const right = value(node.right);
    const at = i * recordBytes;
    if (recordSize === 24) {
      tree.set(
        [
          left >> 16,
          (left >> 8) & 0xff,
          left & 0xff,
          right >> 16,
          (right >> 8) & 0xff,
          right & 0xff,
        ],
        at,
      );
    } else if (recordSize === 28) {
      tree.set(
        [
          (left >> 16) & 0xff,
          (left >> 8) & 0xff,
          left & 0xff,
          (((left >>> 24) & 0x0f) << 4) | ((right >>> 24) & 0x0f),
          (right >> 16) & 0xff,
          (right >> 8) & 0xff,
          right & 0xff,
        ],
        at,
      );
    } else {
      const view = new DataView(tree.buffer);
      view.setUint32(at, left);
      view.setUint32(at + 4, right);
    }
  }
  const metadata = new Encoder();
  metadata.write({
    node_count: u32(nodeCount),
    record_size: u16(recordSize),
    ip_version: u16(ipVersion),
    database_type: options.databaseType ?? "Test",
    languages: ["en"],
    binary_format_major_version: u16(2),
    binary_format_minor_version: u16(0),
    build_epoch: u64(options.buildEpoch ?? 1_700_000_000),
    description: { en: "bun-security test database" },
  });
  const marker = [0xab, 0xcd, 0xef, ...new TextEncoder().encode("MaxMind.com")];
  const file = new Uint8Array(
    tree.length + 16 + data.out.length + marker.length + metadata.out.length,
  );
  file.set(tree, 0);
  file.set(Uint8Array.from(data.out), tree.length + 16);
  file.set(marker, tree.length + 16 + data.out.length);
  file.set(
    Uint8Array.from(metadata.out),
    tree.length + 16 + data.out.length + marker.length,
  );
  return file;
}
