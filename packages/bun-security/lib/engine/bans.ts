/**
 * Layer L4, bans (layers.md L4): records written at run time, by counted
 * rules, by the ladder and by operators, and looked up locally on every
 * request: an exact-key map for addresses, users, API keys and composite
 * keys, and a CIDR trie for ranges. A request never waits on a store to
 * learn whether it is banned (plan D2). Sharing bans across processes (the
 * ban stream and its reconcile) is PR-S4's.
 *
 * - **Merging** (ConcaveHR's rules): a new ban on a subject with an active
 *   ban extends it, the later expiry winning and "until lifted" beating any
 *   date; a manual ban replaces an automatic one's reason; `ban` beats
 *   `challenge`.
 * - **Unban** lifts a ban (`liftedAt`, `liftedBy`), which the engine follows
 *   by resetting the address's score for an automatic one.
 * - **Bounds**: at most `maxActive` bans. Past it a new automatic ban of an
 *   address is widened to its `/24` (IPv4) or `/48` (IPv6), merged into one
 *   ban per range; if that cannot fit either it is dropped and counted.
 *   Manual bans are never dropped.
 * - **The ranges' trie** holds range ids, not ban records, so a merge never
 *   touches it, and a new range is inserted once. A removed or ended range
 *   stays in it as a stale id that a lookup skips; the trie is rebuilt from
 *   the live ranges only when stale ids outnumber them (and at least 64),
 *   so rebuilds are amortised over removals and no write makes a later
 *   lookup rebuild it. A flood of new ranges therefore costs each request
 *   one trie walk, however many ranges were written since the last one.
 */
import { formatAddress, maskWords, parseCidr } from "../ip/address";
import type { ParsedAddress, ParsedCidr } from "../ip/address";
import { CidrTrie } from "../ip/trie";

/**
 * What a ban refuses: a client address key (`ip`: IPv4, or an IPv6 `/64`),
 * a range (`cidr`), a user or API key id, or a composite key a counted rule
 * counts under (`ip|user`: its parts joined with `|`).
 */
export interface BanSubject {
  /** The kind: `ip`, `cidr`, `user`, `apiKey`, or key parts joined with `|`. */
  readonly type: string;
  /** The value: the address key, the range as `base/bits`, the id, or the composite key. */
  readonly value: string;
}

/** A ban (layers.md L4). */
export interface Ban {
  /** Its id, `<type>:<value>` (`ip:203.0.113.5`, `cidr:203.0.113.0/24`): one per subject. */
  readonly id: string;
  /** What it refuses. */
  readonly subject: BanSubject;
  /** `ban` refuses; `challenge` is a `block` until challenge providers exist. */
  readonly action: "ban" | "challenge";
  /** Why, for operators; never sent to the client. */
  readonly reason: string;
  /** The counted rule (`counted:<id>`) or `ladder` that wrote it, for an automatic ban. */
  readonly rule?: string;
  /** `auto` (a counted rule, the ladder, a canary) or `manual` (`security.ban()`). */
  readonly source: "auto" | "manual";
  /** When it was first written, epoch ms. */
  readonly createdAt: number;
  /** When it ends, epoch ms; `null` until lifted. */
  readonly expiresAt: number | null;
  /** Who wrote a manual ban. */
  readonly createdBy?: string;
  /** How many times it was written (merges included). */
  readonly count: number;
  /** The problem code it answers with; the policy's `bans.code` when absent. */
  readonly code?: string;
  /** When it was lifted, epoch ms (only on the record `unban()` answers). */
  readonly liftedAt?: number;
  /** Who lifted it. */
  readonly liftedBy?: string;
}

/** What {@link BanTable.add} writes. */
export interface BanWrite {
  /** What it refuses. */
  readonly subject: BanSubject;
  /** Its action. */
  readonly action: "ban" | "challenge";
  /** Why. */
  readonly reason: string;
  /** The rule that wrote it. */
  readonly rule?: string;
  /** Its source. */
  readonly source: "auto" | "manual";
  /** When it ends; `null` until lifted. */
  readonly expiresAt: number | null;
  /** Who wrote it. */
  readonly createdBy?: string;
  /** Its problem code. */
  readonly code?: string;
}

/** What {@link BanTable.add} did. */
export interface BanOutcome {
  /** The ban in force for the subject (merged), or `undefined` when dropped at the bound. */
  readonly ban: Ban | undefined;
  /** Whether the address was widened to its /24 or /48 to fit the bound. */
  readonly aggregated: boolean;
}

/** Whether `ban` is in force at `now`. */
function active(ban: Ban, now: number): boolean {
  return ban.expiresAt === null || ban.expiresAt > now;
}

/** The id of a subject's ban. */
export function banId(subject: BanSubject): string {
  return `${subject.type}:${subject.value}`;
}

/** The range an address key is widened to past the bound: its /24 or /48. */
function widen(key: string): ParsedCidr | null {
  const cidr = parseCidr(key);
  if (!cidr) return null;
  const bits = cidr.family === 4 ? 24 : 48;
  if (cidr.bits <= bits) return cidr;
  return parseCidr(
    `${formatAddress(cidr.family, maskWords(cidr.words, bits))}/${bits}`,
  );
}

/** The bans held, by subject. */
export class BanTable {
  /** Bans of exact subjects, by id, oldest first. */
  readonly #exact = new Map<string, Ban>();
  /** Bans of ranges, by id. */
  readonly #ranges = new Map<string, Ban>();
  /** The ranges' trie, by range id (live and stale; see the module's description). */
  #trie = new CidrTrie<string>();
  /** The range ids in {@link #trie}, live or stale. */
  readonly #inTrie = new Set<string>();
  /**
   * How many times the trie was rebuilt (a test seam: rebuilds follow
   * removals, amortised, and never writes).
   */
  trieRebuilds = 0;
  /** How many exact bans each type has. */
  readonly #types = new Map<string, number>();
  /** Automatic bans dropped at the bound. */
  dropped = 0;

  constructor(
    /** The most bans held (manual ones may pass it). */
    private readonly maxActive: () => number,
  ) {}

  /** Bans held (ended ones may linger until read). */
  get size(): number {
    return this.#exact.size + this.#ranges.size;
  }

  /** The types with an exact ban, for the lookup. */
  types(): IterableIterator<string> {
    return this.#types.keys();
  }

  /** The ban held for `id`, active or not. */
  get(id: string): Ban | undefined {
    return this.#exact.get(id) ?? this.#ranges.get(id);
  }

  /** Stores `ban`. */
  #put(ban: Ban): void {
    if (ban.subject.type === "cidr") {
      this.#ranges.set(ban.id, ban);
      if (!this.#inTrie.has(ban.id)) {
        const cidr = parseCidr(ban.subject.value);
        if (cidr) {
          this.#trie.insert(cidr, ban.id);
          this.#inTrie.add(ban.id);
        }
      }
      return;
    }
    if (!this.#exact.has(ban.id)) {
      this.#types.set(
        ban.subject.type,
        (this.#types.get(ban.subject.type) ?? 0) + 1,
      );
    }
    this.#exact.set(ban.id, ban);
  }

  /** Forgets `id`. */
  #remove(id: string): Ban | undefined {
    const exact = this.#exact.get(id);
    if (exact !== undefined) {
      this.#exact.delete(id);
      const left = (this.#types.get(exact.subject.type) ?? 1) - 1;
      if (left <= 0) this.#types.delete(exact.subject.type);
      else this.#types.set(exact.subject.type, left);
      return exact;
    }
    const range = this.#ranges.get(id);
    if (range !== undefined) {
      // Left in the trie as a stale id; compacted once stale ids dominate.
      this.#ranges.delete(id);
      if (
        this.#inTrie.size - this.#ranges.size >
        Math.max(64, this.#ranges.size)
      ) {
        this.#rebuild();
      }
    }
    return range;
  }

  /** The trie built afresh from the live ranges. */
  #rebuild(): void {
    const trie = new CidrTrie<string>();
    this.#inTrie.clear();
    for (const ban of this.#ranges.values()) {
      const cidr = parseCidr(ban.subject.value);
      if (cidr) {
        trie.insert(cidr, ban.id);
        this.#inTrie.add(ban.id);
      }
    }
    this.#trie = trie;
    this.trieRebuilds++;
  }

  /** Drops up to two ended bans of each kind, oldest first: constant work per write. */
  #sweep(now: number): void {
    for (const table of [this.#exact, this.#ranges]) {
      let checked = 0;
      for (const [id, ban] of table) {
        if (checked++ >= 2) break;
        if (!active(ban, now)) this.#remove(id);
      }
    }
  }

  /** Writes a ban, merging with one in force for the subject (see the module's description). */
  add(write: BanWrite, now: number): BanOutcome {
    this.#sweep(now);
    const id = banId(write.subject);
    const existing = this.get(id);
    if (existing !== undefined && active(existing, now)) {
      return { ban: this.#merge(existing, write), aggregated: false };
    }
    if (existing !== undefined) this.#remove(id);
    if (write.source === "auto" && this.size >= this.maxActive()) {
      return this.#aggregate(write, now);
    }
    const ban = this.#create(id, write, now);
    this.#put(ban);
    return { ban, aggregated: false };
  }

  /** `existing` extended by `write`. */
  #merge(existing: Ban, write: BanWrite): Ban {
    const keepOld = existing.source === "manual" && write.source !== "manual";
    const merged: Ban = Object.freeze({
      ...existing,
      action:
        existing.action === "ban" || write.action === "ban"
          ? "ban"
          : "challenge",
      expiresAt:
        existing.expiresAt === null || write.expiresAt === null
          ? null
          : Math.max(existing.expiresAt, write.expiresAt),
      count: existing.count + 1,
      ...(keepOld
        ? {}
        : {
            reason: write.reason,
            source: write.source,
            ...(write.rule === undefined ? {} : { rule: write.rule }),
            ...(write.createdBy === undefined
              ? {}
              : { createdBy: write.createdBy }),
            ...(write.code === undefined ? {} : { code: write.code }),
          }),
    });
    this.#put(merged);
    return merged;
  }

  /** A new ban record. */
  #create(id: string, write: BanWrite, now: number): Ban {
    return Object.freeze({
      id,
      subject: Object.freeze({ ...write.subject }),
      action: write.action,
      reason: write.reason,
      ...(write.rule === undefined ? {} : { rule: write.rule }),
      source: write.source,
      createdAt: now,
      expiresAt: write.expiresAt,
      ...(write.createdBy === undefined ? {} : { createdBy: write.createdBy }),
      count: 1,
      ...(write.code === undefined ? {} : { code: write.code }),
    });
  }

  /**
   * Past the bound: an automatic address ban widened to its /24 or /48 and
   * merged into that range's ban; a new range has 1,024 entries of slack
   * past the bound, then the ban is dropped and counted.
   */
  #aggregate(write: BanWrite, now: number): BanOutcome {
    const range =
      write.subject.type === "ip" ? widen(write.subject.value) : null;
    if (range === null) {
      this.dropped++;
      return { ban: undefined, aggregated: false };
    }
    const widened: BanWrite = {
      ...write,
      subject: { type: "cidr", value: range.text },
      reason: `${write.reason} (widened to ${range.text}: the ban table is full)`,
    };
    const id = banId(widened.subject);
    const existing = this.get(id);
    if (existing !== undefined && active(existing, now)) {
      return { ban: this.#merge(existing, widened), aggregated: true };
    }
    if (existing !== undefined) this.#remove(id);
    if (this.size >= this.maxActive() + 1024) {
      this.dropped++;
      return { ban: undefined, aggregated: false };
    }
    const ban = this.#create(id, widened, now);
    this.#put(ban);
    return { ban, aggregated: true };
  }

  /** Lifts `id`: the record, marked lifted, or `undefined` when none is in force. */
  lift(id: string, by: string | undefined, now: number): Ban | undefined {
    const ban = this.#remove(id);
    if (ban === undefined || !active(ban, now)) return undefined;
    return Object.freeze({
      ...ban,
      liftedAt: now,
      ...(by === undefined ? {} : { liftedBy: by }),
    });
  }

  /** The ban in force for an exact subject, dropping an ended one when `writes`. */
  find(id: string, now: number, writes: boolean): Ban | undefined {
    const ban = this.#exact.get(id);
    if (ban === undefined) return undefined;
    if (active(ban, now)) return ban;
    if (writes) this.#remove(id);
    return undefined;
  }

  /** The range bans in force that contain `address`, least specific first. */
  ranges(address: ParsedAddress, now: number): readonly Ban[] {
    if (this.#ranges.size === 0) return [];
    const found: Ban[] = [];
    for (const id of this.#trie.match(address)) {
      // A stale id (lifted, ended and removed) has no live record.
      const ban = this.#ranges.get(id);
      if (ban !== undefined && active(ban, now)) found.push(ban);
    }
    return found;
  }

  /** Every ban in force at `now`. */
  list(now: number): Ban[] {
    const out: Ban[] = [];
    for (const ban of this.#exact.values()) if (active(ban, now)) out.push(ban);
    for (const ban of this.#ranges.values())
      if (active(ban, now)) out.push(ban);
    return out;
  }

  /** Lifts every automatic ban whose rule `keep` refuses (a new policy removed or turned it off). */
  prune(keep: (rule: string) => boolean): void {
    for (const table of [this.#exact, this.#ranges]) {
      for (const [id, ban] of table) {
        if (
          ban.source === "auto" &&
          ban.rule !== undefined &&
          !keep(ban.rule)
        ) {
          this.#remove(id);
        }
      }
    }
  }

  /** Forgets every ban. */
  clear(): void {
    this.#exact.clear();
    this.#ranges.clear();
    this.#types.clear();
    this.#trie = new CidrTrie<string>();
    this.#inTrie.clear();
  }
}
