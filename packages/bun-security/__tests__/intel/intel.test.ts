/**
 * `ipIntel` (layers.md L5): country and ASN from databases the test writes
 * in MaxMind's, DB-IP's and IPinfo's record shapes, merged in order;
 * classes from static ranges; the LRU (a hit is the same frozen record, an
 * eviction past `cacheSize`, a clear when the classes change); `provides`
 * from the databases' types; `reload()`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@kingsleyweb/bun-common";
import { afterAll, describe, expect, it } from "bun:test";
import { extractIntel, ipIntel } from "../../lib/intel/intel";
import { openMmdb } from "../../lib/intel/mmdb";
import { u32, writeMmdb } from "./mmdbWriter";

const work = mkdtempSync(join(tmpdir(), "bun-security-intel-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** A GeoLite2-Country-shaped database. */
const country = () =>
  writeMmdb(
    [
      [
        "203.0.113.0/24",
        {
          country: { iso_code: "DE", names: { en: "Germany" } },
          registered_country: { iso_code: "DE" },
        },
      ],
      ["198.51.100.0/24", { registered_country: { iso_code: "fr" } }],
      ["2001:db8::/32", { country: { iso_code: "JP" } }],
    ],
    { databaseType: "GeoLite2-Country" },
  );

/** A GeoLite2-ASN-shaped database. */
const asn = () =>
  writeMmdb(
    [
      [
        "203.0.113.0/24",
        {
          autonomous_system_number: u32(64500),
          autonomous_system_organization: "Example Net",
        },
      ],
      [
        "2001:db8::/32",
        {
          autonomous_system_number: u32(64501),
          autonomous_system_organization: "Doc Net",
        },
      ],
    ],
    { databaseType: "GeoLite2-ASN" },
  );

/** An IPinfo-Lite-shaped database: both fields in one. */
const ipinfo = () =>
  writeMmdb(
    [
      [
        "192.0.2.0/24",
        { country_code: "BR", asn: "AS64502", as_name: "Lite Net" },
      ],
    ],
    {
      databaseType: "ipinfo lite.mmdb",
    },
  );

describe("ipIntel", () => {
  it("reads country and ASN from MaxMind-, DB-IP- and IPinfo-shaped databases, merged in order", async () => {
    const intel = await ipIntel({
      databases: [
        await openMmdb(country()),
        await openMmdb(asn()),
        await openMmdb(ipinfo()),
      ],
    });
    expect(intel.lookup("203.0.113.5")).toEqual({
      country: "DE",
      asn: 64500,
      asOrganization: "Example Net",
      classes: [],
    });
    expect(intel.lookup("198.51.100.5")).toEqual({
      country: "FR",
      classes: [],
    });
    expect(intel.lookup("2001:db8::1")).toEqual({
      country: "JP",
      asn: 64501,
      asOrganization: "Doc Net",
      classes: [],
    });
    expect(intel.lookup("192.0.2.9")).toEqual({
      country: "BR",
      asn: 64502,
      asOrganization: "Lite Net",
      classes: [],
    });
    expect(intel.lookup("::ffff:203.0.113.5")).toBe(
      intel.lookup("203.0.113.5"),
    );
    expect(intel.lookup("10.1.1.1")).toEqual({ classes: [] });
    expect(intel.lookup("not an address")).toEqual({ classes: [] });
    expect(intel.provides()).toEqual({
      country: true,
      asn: true,
      classes: new Set(),
    });
  });

  it("says what its databases provide", async () => {
    expect(
      (await ipIntel({ databases: [await openMmdb(country())] })).provides(),
    ).toMatchObject({ country: true, asn: false });
    expect(
      (await ipIntel({ databases: [await openMmdb(asn())] })).provides(),
    ).toMatchObject({ country: false, asn: true });
    expect((await ipIntel()).provides()).toMatchObject({
      country: false,
      asn: false,
    });
  });

  it("puts addresses in the classes of its static ranges", async () => {
    const intel = await ipIntel({
      ranges: {
        office: ["198.51.100.0/24"],
        hosting: ["198.51.100.128/25", "2001:db8::/32"],
      },
    });
    expect(intel.lookup("198.51.100.200").classes).toEqual([
      "hosting",
      "office",
    ]);
    expect(intel.lookup("198.51.100.1").classes).toEqual(["office"]);
    expect(intel.lookup("2001:db8::9").classes).toEqual(["hosting"]);
    expect(intel.provides().classes).toEqual(new Set(["office", "hosting"]));
    expect(intel.status().classes).toEqual({ office: 1, hosting: 2 });
    await expect(ipIntel({ ranges: { office: ["nope"] } })).rejects.toThrow(
      ConfigError,
    );
    await expect(ipIntel({ ranges: { "bad name": [] } })).rejects.toThrow(
      ConfigError,
    );
  });

  it("caches lookups: a hit is the same frozen record, the oldest goes past cacheSize", async () => {
    let reads = 0;
    const reader = await openMmdb(country());
    const counting = new Proxy(reader, {
      get(target, key) {
        if (key === "lookup") {
          return (address: Parameters<typeof reader.lookup>[0]) => {
            reads++;
            return target.lookup(address);
          };
        }
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const intel = await ipIntel({ databases: [counting], cacheSize: 2 });
    const first = intel.lookup("203.0.113.1");
    expect(Object.isFrozen(first)).toBe(true);
    expect(intel.lookup("203.0.113.1")).toBe(first);
    expect(reads).toBe(1);
    intel.lookup("203.0.113.2");
    intel.lookup("203.0.113.3"); // evicts .1
    expect(intel.status().cached).toBe(2);
    intel.lookup("203.0.113.1");
    expect(reads).toBe(4);
    // Negative control: no cache, every lookup reads.
    const uncached = await ipIntel({ databases: [counting], cacheSize: 0 });
    uncached.lookup("203.0.113.1");
    uncached.lookup("203.0.113.1");
    expect(reads).toBe(6);
  });

  it("re-reads its files on reload()", async () => {
    const path = join(work, "country.mmdb");
    writeFileSync(path, country());
    const intel = await ipIntel({ databases: [path] });
    expect(intel.lookup("203.0.113.1").country).toBe("DE");
    writeFileSync(
      path,
      writeMmdb([["203.0.113.0/24", { country: { iso_code: "NL" } }]], {
        databaseType: "GeoLite2-Country",
      }),
    );
    expect(intel.lookup("203.0.113.1").country).toBe("DE");
    await intel.reload();
    expect(intel.lookup("203.0.113.1").country).toBe("NL");
    expect(intel.status().databases[0]?.databaseType).toBe("GeoLite2-Country");
  });

  it("takes a record reader of one's own", async () => {
    const custom = writeMmdb([
      ["203.0.113.0/24", { geo: { cc: "IT" }, network: { as: u32(7) } }],
    ]);
    const intel = await ipIntel({
      databases: [await openMmdb(custom)],
      extract: (record) => {
        const r = record as { geo: { cc: string }; network: { as: number } };
        return { country: r.geo.cc, asn: r.network.as };
      },
    });
    expect(intel.lookup("203.0.113.1")).toEqual({
      country: "IT",
      asn: 7,
      classes: [],
    });
  });

  it("extractIntel ignores what is not a country code or an ASN", () => {
    expect(
      extractIntel({
        country: { iso_code: "Germany" },
        asn: "ASX",
        autonomous_system_number: "1",
      }),
    ).toEqual({});
    expect(extractIntel("plain")).toEqual({});
  });

  it("refuses a bad cacheSize", async () => {
    await expect(ipIntel({ cacheSize: -1 })).rejects.toThrow(/cacheSize/);
  });
});
