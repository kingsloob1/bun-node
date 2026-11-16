/**
 * The ban table's range lookups (layers.md L4). The trie holds range ids
 * and grows by insertion, so a flood of new range bans interleaved with
 * lookups rebuilds it zero times (an attacker-triggered rebuild per request
 * would make each request cost as much as every range written); removals
 * rebuild it only when stale ids outnumber live ones. Counted through the
 * table's `trieRebuilds` seam, never timed. A differential checks lookups
 * against a brute-force scan through random bans, merges, unbans and
 * expiries.
 */
import { describe, expect, it } from "bun:test";
import { cidrContains, parseAddress, parseCidr } from "../../lib/ip/address";
import { BanTable } from "../../lib/engine/bans";
import type { BanWrite } from "../../lib/engine/bans";
import { seededRandom } from "../helpers";

const NOW = Date.UTC(2026, 10, 16);

/** A range ban write. */
function range(
  value: string,
  expiresAt: number | null,
  source: "auto" | "manual" = "manual",
): BanWrite {
  return {
    subject: { type: "cidr", value },
    action: "ban",
    reason: "test",
    source,
    expiresAt,
  };
}

/** An address, parsed. */
function address(text: string) {
  const parsed = parseAddress(text);
  if (parsed === null) throw new Error(`not an address: ${text}`);
  return parsed;
}

describe("rebuilds of the ranges' trie", () => {
  it("a flood of new range bans, each followed by a lookup, rebuilds it zero times", () => {
    const table = new BanTable(() => 1_000_000);
    for (let i = 0; i < 2_000; i++) {
      table.add(
        range(`${Math.floor(i / 256) + 1}.${i % 256}.0.0/24`, NOW + 3_600_000),
        NOW,
      );
      expect(
        table.ranges(address(`${Math.floor(i / 256) + 1}.${i % 256}.0.9`), NOW),
      ).toHaveLength(1);
    }
    expect(table.trieRebuilds).toBe(0);
    // Merges into ranges already held do not touch the trie either.
    for (let i = 0; i < 2_000; i++) {
      table.add(
        range(`${Math.floor(i / 256) + 1}.${i % 256}.0.0/24`, NOW + 7_200_000),
        NOW,
      );
      table.ranges(address("1.0.0.1"), NOW);
    }
    expect(table.trieRebuilds).toBe(0);
  });

  it("removals interleaved with lookups rebuild it a logarithmic number of times, keeping every live range", () => {
    const table = new BanTable(() => 1_000_000);
    const at = (i: number) => `${Math.floor(i / 256) + 1}.${i % 256}.0`;
    for (let i = 0; i < 2_000; i++) {
      table.add(range(`${at(i)}.0/24`, null), NOW);
    }
    // Lift two of every three; after each, every tenth kept range must still be found.
    const kept = Array.from({ length: 2_000 }, (_, i) => i).filter(
      (i) => i % 3 === 0,
    );
    for (let i = 0; i < 2_000; i++) {
      if (i % 3 === 0) continue;
      expect(table.lift(`cidr:${at(i)}.0/24`, "test", NOW)).toBeDefined();
      expect(table.ranges(address(`${at(i)}.9`), NOW)).toEqual([]);
      if (i % 50 === 1) {
        for (const k of kept.filter((_, n) => n % 10 === 0)) {
          expect(
            table.ranges(address(`${at(k)}.9`), NOW).map((ban) => ban.id),
          ).toEqual([`cidr:${at(k)}.0/24`]);
        }
      }
    }
    // Compacted when stale ids outnumbered live ones: at least once, a handful of times, not 1,333.
    expect(table.trieRebuilds).toBeGreaterThan(0);
    expect(table.trieRebuilds).toBeLessThanOrEqual(12);
    for (const k of kept) {
      expect(table.ranges(address(`${at(k)}.9`), NOW)).toHaveLength(1);
    }
  });

  it("re-banning a lifted range finds it again, once", () => {
    const table = new BanTable(() => 10);
    table.add(range("203.0.113.0/24", null), NOW);
    table.lift("cidr:203.0.113.0/24", undefined, NOW);
    expect(table.ranges(address("203.0.113.5"), NOW)).toEqual([]);
    table.add(range("203.0.113.0/24", null), NOW);
    expect(
      table.ranges(address("203.0.113.5"), NOW).map((ban) => ban.id),
    ).toEqual(["cidr:203.0.113.0/24"]);
    expect(table.trieRebuilds).toBe(0);
  });
});

describe("differential: range lookups against a brute-force scan", () => {
  it("agrees through random bans, merges, unbans and expiries (20 seeds × 600 steps)", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const random = seededRandom(seed);
      const table = new BanTable(() => 1_000_000);
      let now = NOW;
      const randomRange = () => {
        const bits = 22 + Math.floor(random() * 11);
        const base = `198.51.${Math.floor(random() * 4)}.${Math.floor(random() * 256)}`;
        return parseCidr(`${base}/${bits}`)?.text ?? "198.51.0.0/22";
      };
      for (let step = 0; step < 600; step++) {
        const roll = random();
        if (roll < 0.35) {
          // A ban, often a merge with one in force; some until lifted.
          const ends =
            random() < 0.2 ? null : now + Math.floor(random() * 60_000);
          table.add(
            range(randomRange(), ends, random() < 0.5 ? "auto" : "manual"),
            now,
          );
        } else if (roll < 0.5) {
          // An unban, of a range that may or may not be held.
          table.lift(`cidr:${randomRange()}`, undefined, now);
        } else if (roll < 0.6) {
          now += Math.floor(random() * 30_000); // expiries
        } else {
          const probe = address(
            `198.51.${Math.floor(random() * 4)}.${Math.floor(random() * 256)}`,
          );
          const ours = table
            .ranges(probe, now)
            .map((ban) => ban.id)
            .sort();
          const brute = table
            .list(now)
            .filter((ban) => ban.subject.type === "cidr")
            .filter((ban) => {
              const cidr = parseCidr(ban.subject.value);
              return cidr !== null && cidrContains(cidr, probe);
            })
            .map((ban) => ban.id)
            .sort();
          expect({ seed, step, ours }).toEqual({ seed, step, ours: brute });
        }
      }
    }
  });
});
