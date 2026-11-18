/**
 * The Lists screen's pure parts (PR-U3): the CSV reader and writer (the
 * 10,000-row bound, problems by line, a round trip), the browser's CIDR
 * reading and containment, and the entry checks that mirror the policy
 * schema's. No DOM.
 */
import { describe, expect, it } from "bun:test";
import { expectNone } from "../../harness/assert";
import {
  cidrContains,
  isAddress,
  parseCidr,
} from "../../../app/security/components/cidr";
import {
  importCsv,
  parseCsv,
  toCsv,
} from "../../../app/security/screens/lists/csv";
import {
  diffLists,
  entryKey,
  MAX_IMPORT_ROWS,
} from "../../../app/security/screens/lists/entries";
import { matchesSearch } from "../../../app/security/screens/lists/filters";
import {
  checkEntry,
  emptyInput,
} from "../../../app/security/screens/lists/validate";

/** A CSV of `n` distinct address rows. */
function rowsOf(n: number): string {
  const lines = ["kind,value,action"];
  for (let i = 0; i < n; i += 1)
    lines.push(`ip,10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255},block`);
  return lines.join("\n");
}

describe("the CSV import", () => {
  it(`takes ${MAX_IMPORT_ROWS} rows, and refuses ${MAX_IMPORT_ROWS + 1} whole`, () => {
    const full = importCsv(rowsOf(MAX_IMPORT_ROWS));
    expect(full.ok).toBe(true);
    expect(full.ok ? full.entries.length : 0).toBe(MAX_IMPORT_ROWS);
    const over = importCsv(rowsOf(MAX_IMPORT_ROWS + 1));
    expect(over).toEqual({
      ok: false,
      problems: [
        {
          line: 1,
          message:
            "The file holds 10,001 rows; one import takes at most 10,000",
        },
      ],
    });
  });

  it("refuses a file with any bad line, naming each by its line, quoted line breaks counted", () => {
    const result = importCsv(
      [
        "kind,value,action,override,reason",
        'ip,192.0.2.1,block,,"two',
        'lines"',
        "ip,192.0.2.2,block,maybe,",
        "ip,192.0.2.3,block,true,",
        "asn,4294967296,block,,",
        "comet,x,block,,",
        "ip,192.0.2.1,drop,,",
        "ip,192.0.2.9,block,,,extra",
      ].join("\r\n"),
    );
    expect(result).toEqual({
      ok: false,
      problems: [
        { line: 4, message: "override: true or false" },
        { line: 5, message: "override: Only an allow entry can override" },
        {
          line: 6,
          message: "value: Not an autonomous system number (0 to 4294967295)",
        },
        {
          line: 7,
          message:
            "kind: one of ip, userHash, user, apiKeyHash, apiKey, country, asn",
        },
        { line: 8, message: "Repeats line 2" },
        { line: 9, message: "6 cells; the header names 5" },
      ],
    });
  });

  it("names a missing or unknown column, an empty file, and an unclosed quote", () => {
    expect(importCsv("kind,value,colour\nip,192.0.2.1,red")).toEqual({
      ok: false,
      problems: [
        {
          line: 1,
          message: "Missing column(s): action; unknown column(s): colour",
        },
      ],
    });
    expect(importCsv("")).toEqual({
      ok: false,
      problems: [{ line: 1, message: "The file is empty" }],
    });
    expect(importCsv("kind,value,action\n")).toEqual({
      ok: false,
      problems: [{ line: 1, message: "No rows" }],
    });
    expect(importCsv('kind,value,action\nip,"192.0.2.1,block')).toEqual({
      ok: false,
      problems: [{ line: 2, message: "A quoted cell is never closed" }],
    });
  });

  it("refuses a key that is not one, without echoing it", () => {
    const result = importCsv("kind,value,action\nuserHash,alice,block");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("alice");
  });

  it("refuses a row already in the scope", () => {
    const existing = new Set([entryKey({ ip: "192.0.2.1", action: "block" })]);
    expect(importCsv("kind,value,action\nip,192.0.2.1,drop", existing)).toEqual(
      {
        ok: false,
        problems: [{ line: 2, message: "Already listed in this scope" }],
      },
    );
  });
});

describe("the CSV export", () => {
  it("round-trips through the import, guarding formulas and quoting", () => {
    const entries = [
      {
        ip: "203.0.113.0/24",
        action: "block" as const,
        paths: ["/login", "/api"],
        expiresAt: "2030-01-01T00:00:00Z",
        reason: 'says "hi", twice',
        mode: "dryRun" as const,
      },
      {
        userHash: "0123456789abcdef0123456789abcdef",
        action: "allow" as const,
        override: true,
        locked: true,
        reason: "=cmd()",
      },
      { country: "KP", action: "drop" as const },
      { asn: 64500, action: "challenge" as const },
    ];
    const { text, skipped } = toCsv(entries);
    expect(skipped).toBe(0);
    expect(text).toContain(`,"says ""hi"", twice",`);
    expect(text).toContain(",'=cmd(),");
    expect(importCsv(text)).toEqual({ ok: true, entries });
  });

  it("never writes a raw account id", () => {
    const { text, skipped } = toCsv([
      { user: "alice", action: "block" },
      { apiKey: "key_1", action: "block" },
    ]);
    expect(skipped).toBe(2);
    expect(text).not.toContain("alice");
    expect(text).not.toContain("key_1");
  });
});

describe("parseCsv", () => {
  it("skips blank lines and a byte-order mark", () => {
    const records = parseCsv("﻿a,b\n\n c ,d\n");
    expect(Array.isArray(records) ? records : []).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 3, cells: [" c ", "d"] },
    ]);
  });
});

describe("addresses and ranges", () => {
  it("reads IPv4, IPv6 and IPv4-mapped forms, masking host bits", () => {
    expect(parseCidr("10.1.2.3/8")).toEqual({
      family: 4,
      base: 0x0a000000n,
      bits: 8,
    });
    expect(parseCidr("::ffff:192.0.2.1")).toEqual({
      family: 4,
      base: 0xc0000201n,
      bits: 32,
    });
    expect(parseCidr("2001:db8::1/32")?.bits).toBe(32);
    for (const bad of [
      "256.0.0.1",
      "01.2.3.4",
      "1.2.3",
      "1.2.3.4/33",
      "::1::2",
      "2001:db8::/129",
      "fe80::1%eth0",
      "1:2:3:4:5:6:7:8:9",
      "",
    ])
      expect(parseCidr(bad)).toBe(null);
  });

  it("a range contains its addresses and narrower ranges, not wider ones or the other family", () => {
    const range = parseCidr("203.0.113.0/24")!;
    expect(cidrContains(range, parseCidr("203.0.113.255")!)).toBe(true);
    expect(cidrContains(range, parseCidr("203.0.113.128/25")!)).toBe(true);
    expect(cidrContains(range, parseCidr("203.0.112.0/23")!)).toBe(false);
    expect(cidrContains(range, parseCidr("203.0.114.1")!)).toBe(false);
    expect(cidrContains(range, parseCidr("::ffff:203.0.113.9")!)).toBe(true);
    expect(cidrContains(range, parseCidr("2001:db8::1")!)).toBe(false);
    expect(isAddress("203.0.113.9")).toBe(true);
    expect(isAddress("203.0.113.9/32")).toBe(false);
  });

  it("the search: an address finds the ranges holding it; text matches values", () => {
    const entry = { ip: "203.0.113.0/24", action: "block" as const };
    expect(matchesSearch(entry, "203.0.113.7")).toBe(true);
    expect(matchesSearch(entry, "203.0.114.7")).toBe(false);
    expect(matchesSearch(entry, "113.0/2")).toBe(true);
    expect(matchesSearch({ user: "alice", action: "block" }, "alice")).toBe(
      false,
    );
  });
});

describe("checkEntry", () => {
  it("mirrors the policy's refusals", () => {
    const check = (changes: Partial<ReturnType<typeof emptyInput>>) => {
      const result = checkEntry({ ...emptyInput(), ...changes });
      return result.ok ? {} : result.errors;
    };
    expect(check({ value: "0.0.0.0/0" }).value).toContain("/0 range");
    expect(check({ value: "::/0" }).value).toContain("/0 range");
    expect(check({ value: "10.0.0.0/8", action: "allow" })).toEqual({});
    expect(check({ value: "2001:db8::/31", action: "allow" }).value).toBe(
      "An allow entry wider than /32 is refused",
    );
    expect(check({ value: "192.0.2.1", paths: "login" }).paths).toBe(
      'Each route prefix starts with "/"',
    );
    expect(
      check({ value: "192.0.2.1", expiresAt: "2030-01-01T00:00:00" }).expiresAt,
    ).toContain("ISO 8601");
    expect(check({ value: "192.0.2.1", reason: "x".repeat(1025) }).reason).toBe(
      "At most 1024 characters",
    );
    expect(check({ kind: "user", value: "has space" }).value).toBe(
      "Not a user id (1-256 characters, no spaces)",
    );
    expectNone(
      Object.keys(check({ kind: "apiKey", value: "key_1", action: "drop" })),
      "problems with an API key id",
    );
  });

  it("writes defaults as absent", () => {
    expect(
      checkEntry({
        ...emptyInput(),
        value: " 192.0.2.1 ",
        mode: "enforce",
        reason: "  ",
      }),
    ).toEqual({ ok: true, entry: { ip: "192.0.2.1", action: "block" } });
  });
});

describe("diffLists", () => {
  it("counts by entry key", () => {
    expect(
      diffLists(
        [
          { ip: "192.0.2.1", action: "block" },
          { country: "KP", action: "drop" },
        ],
        [
          { ip: "192.0.2.1", action: "drop" },
          { asn: 1, action: "block" },
        ],
      ),
    ).toEqual({ added: 1, removed: 1, changed: 1 });
  });
});
