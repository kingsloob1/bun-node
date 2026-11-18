/**
 * The conflict check (layers.md L3.2): a block list entry, a manual ban, or
 * a country or ASN entry that covers an allowed crawler's published ranges
 * (a block on Google's ASN, a country block over Googlebot's addresses)
 * would de-index the site (R19). The engine reports each as a
 * `crawler.conflict` warning when it starts, on `load()`, and on
 * `crawlerConflicts()` — after the range feeds have loaded, call it again.
 * Keeping the entry is allowed: the warning names the crawler, the entry
 * and one range it covers.
 */
import type { Ban } from "../engine/bans";
import type { IntelLookup } from "../intel/types";
import { cidrContains, parseCidr } from "../ip/address";
import type { ParsedCidr } from "../ip/address";
import type { CompiledPolicy } from "../policy/compile";
import type { ListEntry, SecurityPolicy } from "../policy/types";
import { crawlersOf } from "./policy";

/** One conflict. */
export interface CrawlerConflict {
  /** The allowed crawler whose ranges are covered. */
  readonly crawler: string;
  /** The entry or ban that covers them (`lists[3] country:US`, `ban ip:66.249.66.1`). */
  readonly entry: string;
  /**
   * The list entry's key, as the effective policy's paths name it
   * (`lists[id=<key>]`: its `id`, else its subject and any paths), when a
   * list entry covers them (PR-AN2).
   */
  readonly entryId?: string;
  /** The manual ban's id, when a ban covers them (PR-AN2). */
  readonly banId?: string;
  /** One range of the crawler's it covers. */
  readonly range: string;
  /** The warning's text. */
  readonly message: string;
}

/** The most ranges per crawler examined. */
const MAX_RANGES = 10_000;

/** Whether two ranges overlap. */
function overlaps(a: ParsedCidr, b: ParsedCidr): boolean {
  if (a.family !== b.family) return false;
  return a.bits <= b.bits
    ? cidrContains(a, { family: b.family, words: b.words, text: b.text })
    : cidrContains(b, { family: a.family, words: a.words, text: a.text });
}

/**
 * A list entry's key as the control plane's merge names it: its `id`,
 * else its subject (`ip:`, `country:`, `asn:`) and any `|paths`.
 */
function entryKey(entry: ListEntry): string {
  if (entry.id !== undefined) return entry.id;
  const subject =
    entry.ip !== undefined
      ? `ip:${entry.ip}`
      : entry.country !== undefined
        ? `country:${entry.country}`
        : `asn:${String(entry.asn)}`;
  return entry.paths === undefined
    ? subject
    : `${subject}|${entry.paths.join(",")}`;
}

/** Whether a list entry refuses (an allow never conflicts). */
function refusing(entry: ListEntry): boolean {
  return entry.action !== "allow" && (entry.mode ?? "enforce") !== "off";
}

/**
 * The conflicts between a policy's allowed crawlers and its refusing list
 * entries and the manual `bans`. Needs the crawlers' ranges from `intel`
 * (`crawler:<id>` classes, `ranges()`): none without them.
 */
export function crawlerConflicts(
  policy: CompiledPolicy,
  intel: IntelLookup | undefined,
  bans: readonly Ban[],
): CrawlerConflict[] {
  const compiled = crawlersOf(policy);
  if (compiled.mode === "off" || intel?.ranges === undefined) return [];
  const entries = ((policy.source as SecurityPolicy).lists ?? [])
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => refusing(entry));
  const manual = bans.filter(
    (ban) =>
      ban.source === "manual" &&
      (ban.subject.type === "ip" || ban.subject.type === "cidr"),
  );
  const found: CrawlerConflict[] = [];
  for (const crawler of compiled.allowed) {
    const ranges = intel
      .ranges(`crawler:${crawler.id}`)
      .slice(0, MAX_RANGES)
      .map((text) => parseCidr(text))
      .filter((range): range is ParsedCidr => range !== null);
    if (ranges.length === 0) continue;
    const add = (
      entry: string,
      range: ParsedCidr,
      id: { entryId: string } | { banId: string },
    ) => {
      if (found.some((c) => c.crawler === crawler.id && c.entry === entry))
        return;
      found.push({
        crawler: crawler.id,
        entry,
        ...id,
        range: range.text,
        message: `${entry} covers ${crawler.id}'s published range ${range.text}: a verified ${crawler.id} crawler would be refused there, and the site may drop out of its index`,
      });
    };
    for (const { entry, index } of entries) {
      const name = `lists[${index}] ${entry.id ?? (entry.ip ? `ip:${entry.ip}` : entry.country ? `country:${entry.country}` : entry.asn !== undefined ? `asn:${entry.asn}` : "")}`;
      if (entry.ip !== undefined) {
        const cidr = parseCidr(entry.ip);
        const hit =
          cidr === null
            ? undefined
            : ranges.find((range) => overlaps(cidr, range));
        if (hit) add(name, hit, { entryId: entryKey(entry) });
      } else if (entry.country !== undefined || entry.asn !== undefined) {
        const hit = ranges.find((range) => {
          const record = intel.lookup({
            family: range.family,
            words: range.words,
            text: range.text.split("/")[0] ?? "",
          });
          return entry.country !== undefined
            ? record.country === entry.country
            : record.asn === entry.asn;
        });
        if (hit) add(name, hit, { entryId: entryKey(entry) });
      }
    }
    for (const ban of manual) {
      const cidr = parseCidr(ban.subject.value);
      const hit =
        cidr === null
          ? undefined
          : ranges.find((range) => overlaps(cidr, range));
      if (hit) add(`ban ${ban.id}`, hit, { banId: ban.id });
    }
  }
  return found;
}
