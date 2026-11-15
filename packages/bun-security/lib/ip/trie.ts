/**
 * A binary radix trie of CIDR ranges, one per address family (layers.md L3):
 * a lookup walks at most 32 or 128 bit steps whatever the number of entries,
 * and returns every range containing the address, least specific first.
 *
 * The trie is path-compressed (a node per branching point or stored range,
 * so at most two nodes per range) and kept in typed arrays rather than one
 * object per node, so a list of a million ranges is a few flat arrays the
 * garbage collector never walks. `__tests__/ip/trie.test.ts` checks it
 * against a brute-force scan over random prefixes and addresses.
 */
import { familyBits, maskWords } from "./address";
import type { ParsedAddress, ParsedCidr } from "./address";

/** An empty answer, shared: a lookup that matches nothing allocates nothing. */
const NONE: readonly never[] = Object.freeze([]);

/** The bit at `index` (0 = most significant) of the key at `offset` in `words`. */
function bitAt(words: Uint32Array, offset: number, index: number): number {
  return ((words[offset + (index >>> 5)] ?? 0) >>> (31 - (index & 31))) & 1;
}

/**
 * How many leading bits of the keys at `aOffset` in `a` and `bOffset` in `b`
 * are equal, up to `max`.
 */
function commonBits(
  a: Uint32Array,
  aOffset: number,
  b: Uint32Array,
  bOffset: number,
  max: number,
): number {
  let bits = 0;
  for (let word = 0; bits < max; word++) {
    const diff = ((a[aOffset + word] ?? 0) ^ (b[bOffset + word] ?? 0)) >>> 0;
    if (diff !== 0) {
      return Math.min(max, bits + Math.clz32(diff));
    }
    bits += 32;
  }
  return Math.min(max, bits);
}

/** `links` copied into a new array of `capacity`, the new cells -1. */
function grownLinks(links: Int32Array, capacity: number): Int32Array {
  const next = new Int32Array(capacity).fill(-1);
  next.set(links);
  return next;
}

/** One family's trie: keys of `width` 32-bit words. */
class RadixTrie<T> {
  /** Words per key: 1 for IPv4, 4 for IPv6. */
  readonly #width: number;
  /** Bits per key: 32 or 128. */
  readonly #keyBits: number;
  /** Every node's key, `#width` words each, host bits cleared. */
  #keys: Uint32Array;
  /** Every node's prefix length. */
  #lengths: Uint8Array;
  /** Every node's child on a 0 bit, or -1. */
  #zero: Int32Array;
  /** Every node's child on a 1 bit, or -1. */
  #one: Int32Array;
  /** Every node's index into {@link #values}, or -1 when it stores no range. */
  #slot: Int32Array;
  /** The values stored at each range, by slot. */
  readonly #values: T[][] = [];
  /** Nodes in use. */
  #count = 0;
  /** The root node, or -1 while empty. */
  #root = -1;

  constructor(width: number) {
    this.#width = width;
    this.#keyBits = width * 32;
    const capacity = 16;
    this.#keys = new Uint32Array(capacity * width);
    this.#lengths = new Uint8Array(capacity);
    this.#zero = new Int32Array(capacity).fill(-1);
    this.#one = new Int32Array(capacity).fill(-1);
    this.#slot = new Int32Array(capacity).fill(-1);
  }

  /** The number of nodes (at most two per distinct range). */
  get nodes(): number {
    return this.#count;
  }

  /** Doubles every array when full. */
  #grow(): void {
    const capacity = this.#lengths.length * 2;
    const keys = new Uint32Array(capacity * this.#width);
    keys.set(this.#keys);
    this.#keys = keys;
    const lengths = new Uint8Array(capacity);
    lengths.set(this.#lengths);
    this.#lengths = lengths;
    this.#zero = grownLinks(this.#zero, capacity);
    this.#one = grownLinks(this.#one, capacity);
    this.#slot = grownLinks(this.#slot, capacity);
  }

  /** A new node for `key` cut to `length` bits. */
  #node(key: Uint32Array, length: number): number {
    if (this.#count === this.#lengths.length) {
      this.#grow();
    }
    const node = this.#count++;
    this.#keys.set(maskWords(key, length), node * this.#width);
    this.#lengths[node] = length;
    return node;
  }

  /** Stores `value` at `node`. */
  #store(node: number, value: T): void {
    const slot = this.#slot[node] ?? -1;
    if (slot >= 0) {
      this.#values[slot]?.push(value);
      return;
    }
    this.#slot[node] = this.#values.length;
    this.#values.push([value]);
  }

  /** `node`'s child on `bit`. */
  #child(node: number, bit: number): number {
    return (bit === 0 ? this.#zero[node] : this.#one[node]) ?? -1;
  }

  /** Sets `node`'s child on `bit`; `node` -1 sets the root. */
  #link(node: number, bit: number, child: number): void {
    if (node < 0) {
      this.#root = child;
    } else if (bit === 0) {
      this.#zero[node] = child;
    } else {
      this.#one[node] = child;
    }
  }

  /** Adds `value` under the range `key/length` (`key` already masked). */
  insert(key: Uint32Array, length: number, value: T): void {
    if (this.#root < 0) {
      this.#root = this.#node(key, length);
      this.#store(this.#root, value);
      return;
    }
    let parent = -1;
    let side = 0;
    let node = this.#root;
    for (;;) {
      const nodeLength = this.#lengths[node] ?? 0;
      const common = commonBits(
        key,
        0,
        this.#keys,
        node * this.#width,
        Math.min(length, nodeLength),
      );
      if (common < nodeLength) {
        // The new range leaves this node's path at bit `common`: split there.
        const middle = this.#node(key, common);
        const oldSide = bitAt(this.#keys, node * this.#width, common);
        this.#link(middle, oldSide, node);
        if (common === length) {
          this.#store(middle, value);
        } else {
          const leaf = this.#node(key, length);
          this.#store(leaf, value);
          this.#link(middle, 1 - oldSide, leaf);
        }
        this.#link(parent, side, middle);
        return;
      }
      if (length === nodeLength) {
        this.#store(node, value);
        return;
      }
      const bit = bitAt(key, 0, nodeLength);
      const child = this.#child(node, bit);
      if (child < 0) {
        const leaf = this.#node(key, length);
        this.#store(leaf, value);
        this.#link(node, bit, leaf);
        return;
      }
      parent = node;
      side = bit;
      node = child;
    }
  }

  /** Every value whose range contains `address`, least specific first. */
  match(address: Uint32Array): readonly T[] {
    let found: T[] | undefined;
    let node = this.#root;
    while (node >= 0) {
      const length = this.#lengths[node] ?? 0;
      if (
        commonBits(address, 0, this.#keys, node * this.#width, length) < length
      ) {
        break;
      }
      const slot = this.#slot[node] ?? -1;
      if (slot >= 0) {
        found ??= [];
        for (const value of this.#values[slot] ?? []) found.push(value);
      }
      if (length >= this.#keyBits) {
        break;
      }
      node = this.#child(node, bitAt(address, 0, length));
    }
    return found ?? NONE;
  }
}

/**
 * A CIDR trie over both families. Ranges are added with {@link insert};
 * {@link match} returns every value whose range contains an address,
 * least specific first.
 *
 * @typeParam T What each range carries (a list entry, a ban).
 */
export class CidrTrie<T> {
  /** IPv4 ranges. */
  readonly #v4 = new RadixTrie<T>(1);
  /** IPv6 ranges. */
  readonly #v6 = new RadixTrie<T>(4);
  /** Ranges added. */
  #size = 0;

  /** The number of ranges added (a range added twice counts twice). */
  get size(): number {
    return this.#size;
  }

  /** The number of trie nodes in use, both families. */
  get nodes(): number {
    return this.#v4.nodes + this.#v6.nodes;
  }

  /** Adds `value` under `cidr`. */
  insert(cidr: ParsedCidr, value: T): void {
    if (cidr.bits < 1 || cidr.bits > familyBits(cidr.family)) {
      throw new RangeError(`prefix /${cidr.bits} out of range`);
    }
    (cidr.family === 4 ? this.#v4 : this.#v6).insert(
      maskWords(cidr.words, cidr.bits),
      cidr.bits,
      value,
    );
    this.#size++;
  }

  /** Every value whose range contains `address`, least specific first. */
  match(address: ParsedAddress): readonly T[] {
    return (address.family === 4 ? this.#v4 : this.#v6).match(address.words);
  }
}
