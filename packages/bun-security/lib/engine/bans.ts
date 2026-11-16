/**
 * Layer L4, bans (layers.md L4): records written at run time, by counted
 * rules, by the ladder and by operators, and looked up locally on every
 * request: an exact-key map for addresses, users, API keys and composite
 * keys, and a CIDR trie for ranges. A request never waits on a store to
 * learn whether it is banned (plan D2). With a shared store, the engine's
 * ban log (`banSync.ts`) feeds every process's table: {@link BanTable.merge}
 * takes another process's record, idempotently, and
 * {@link BanTable.reconcile} replaces the table with the store's set.
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
  /** `ban` refuses; `challenge` challenges (a `block` without a challenge flow). */
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
  /** The service whose engine wrote it (its policy's `service`), when it names one. */
  readonly service?: string;
  /**
   * `"service"` when only its service's processes enforce it (the policy's
   * `state.scope`); absent when every `shared` service on the store does.
   */
  readonly scope?: "service";
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
  /** The service writing it. */
  readonly service?: string;
  /** `"service"` for a ban only its service enforces. */
  readonly scope?: "service";
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

/** What a record says beside its times and count, as one comparable text. */
function describing(ban: Ban): string {
  return JSON.stringify([
    ban.reason,
    ban.rule ?? "",
    ban.code ?? "",
    ban.createdBy ?? "",
    ban.service ?? "",
  ]);
}

/**
 * Whether `b`'s reason, rule, code, author and service win over `a`'s when
 * two records of one ban merge: a manual record over an automatic one, then
 * the greater by their text. A total order on what does not change in a
 * merge, so merging is the same in any order and any grouping, and every
 * process holding the same records holds the same ban.
 */
function precedes(a: Ban, b: Ban): boolean {
  if (a.source !== b.source) return b.source === "manual";
  return describing(b) > describing(a);
}

/**
 * Two records of one ban merged, the same whichever comes first (see
 * {@link BanTable.merge}).
 */
export function mergeBans(a: Ban, b: Ban): Ban {
  const winner = precedes(a, b) ? b : a;
  return Object.freeze({
    ...winner,
    action: a.action === "ban" || b.action === "ban" ? "ban" : "challenge",
    expiresAt:
      a.expiresAt === null || b.expiresAt === null
        ? null
        : Math.max(a.expiresAt, b.expiresAt),
    count: Math.max(a.count, b.count),
    createdAt: Math.min(a.createdAt, b.createdAt),
  });
}

/** Whether two records of one ban say the same. */
function sameBan(a: Ban, b: Ban): boolean {
  return (
    a.action === b.action &&
    a.expiresAt === b.expiresAt &&
    a.count === b.count &&
    a.createdAt === b.createdAt &&
    a.reason === b.reason &&
    a.source === b.source &&
    a.rule === b.rule &&
    a.code === b.code &&
    a.createdBy === b.createdBy &&
    a.service === b.service &&
    a.scope === b.scope
  );
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
            ...(write.service === undefined ? {} : { service: write.service }),
          }),
      ...(write.scope === undefined ? {} : { scope: write.scope }),
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
      ...(write.service === undefined ? {} : { service: write.service }),
      ...(write.scope === undefined ? {} : { scope: write.scope }),
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

  /** Lifts every ban `keep` refuses (a new policy removed or turned off the rule that wrote it). */
  prune(keep: (ban: Ban) => boolean): void {
    for (const table of [this.#exact, this.#ranges]) {
      for (const [id, ban] of table) {
        if (!keep(ban)) this.#remove(id);
      }
    }
  }

  /**
   * Takes another process's record of a ban (the ban log, a reload): merged
   * with the one held so that taking the same record twice, or two records
   * in either order, ends the same — the later expiry wins, "until lifted"
   * beats a date, `ban` beats `challenge`, a manual record's reason beats an
   * automatic one's (else the later write's), the larger count, the earlier
   * creation. An ended record is ignored. A new ban past the bound's slack
   * is dropped and counted. Answers the ban held.
   */
  merge(ban: Ban, now: number): Ban | undefined {
    if (!active(ban, now)) return this.get(ban.id);
    const existing = this.get(ban.id);
    if (existing === undefined || !active(existing, now)) {
      if (existing !== undefined) this.#remove(ban.id);
      if (this.size >= this.maxActive() + 1024 && ban.source === "auto") {
        this.dropped++;
        return undefined;
      }
      const taken = Object.freeze({ ...ban });
      this.#put(taken);
      return taken;
    }
    if (sameBan(existing, ban)) return existing;
    const merged = mergeBans(existing, ban);
    if (sameBan(existing, merged)) return existing;
    this.#put(merged);
    return merged;
  }

  /** Forgets `id`, as another process's lift does; answers whether it was held. */
  remove(id: string): boolean {
    return this.#remove(id) !== undefined;
  }

  /**
   * Makes the table the store's `set` (a reload): each of its bans merged
   * in; and, when the set is `complete` (read whole), every held ban it
   * lacks removed unless `keep` says it is this process's own, not yet in
   * the store. Answers how many were removed.
   */
  reconcile(
    set: ReadonlyMap<string, Ban>,
    complete: boolean,
    keep: (id: string) => boolean,
    now: number,
  ): number {
    for (const ban of set.values()) this.merge(ban, now);
    if (!complete) return 0;
    let removed = 0;
    for (const table of [this.#exact, this.#ranges]) {
      for (const id of [...table.keys()]) {
        if (!set.has(id) && !keep(id)) {
          this.#remove(id);
          removed++;
        }
      }
    }
    return removed;
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
