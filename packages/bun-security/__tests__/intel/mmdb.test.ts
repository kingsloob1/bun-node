/**
 * The MaxMind DB reader (layers.md L5, Q8: our own): databases the test
 * writes itself (`mmdbWriter.ts`, from the published format), read back in
 * every record size and both families, every data type, every pointer
 * size and every size-encoding boundary; a property test against a naive
 * longest-prefix match over random networks (seed printed); and corrupt
 * files refused with `MmdbError`, never a hang or a crash.
 *
 * The reader was also checked once, by hand, against MaxMind's own test
 * databases (`MaxMind-DB/test-data`: the decoder, ipv4-24/28/32, ipv6-24,
 * mixed-28, GeoIP2-Country and GeoLite2-ASN test files), which the
 * repository does not ship.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { MmdbError, MmdbReader, openMmdb } from "../../lib/intel/mmdb";
import { formatAddress, parseCidr } from "../../lib/ip/address";
import { randomWord, seededRandom } from "../helpers";
import {
  bytes,
  f32,
  f64,
  i32,
  u128,
  u16,
  u32,
  u64,
  writeMmdb,
} from "./mmdbWriter";
import type { WriterValue } from "./mmdbWriter";

const work = mkdtempSync(join(tmpdir(), "bun-security-mmdb-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Every type the format has, in one record. */
const EVERY_TYPE: WriterValue = {
  array: [u32(1), u32(2), u32(3)],
  boolean: true,
  bytes: bytes(Uint8Array.from([0, 0, 0, 42])),
  double: f64(42.123456),
  float: f32(1.1),
  int32: i32(-268435456),
  map: { mapX: { arrayX: [u32(7), u32(8), u32(9)], utf8_stringX: "hello" } },
  uint128: u128(1329227995784915872903807060280344576n),
  uint16: u16(100),
  uint32: u32(268435456),
  uint64: u64(1152921504606846976n),
  utf8_string: "unicode! ☯ - ♫",
  falsy: false,
  small64: u64(7),
};

describe("openMmdb", () => {
  for (const recordSize of [24, 28, 32] as const) {
    for (const ipVersion of [4, 6] as const) {
      it(`reads a ${recordSize}-bit IPv${ipVersion} tree: records, prefix lengths, misses`, async () => {
        const entries: [string, WriterValue][] = [
          ["1.1.1.0/24", { name: "one" }],
          ["1.1.1.128/25", { name: "one-high" }],
          ["203.0.113.7/32", { name: "single" }],
        ];
        if (ipVersion === 6)
          entries.push(
            ["2001:db8::/32", { name: "doc" }],
            ["2001:db8:1::/48", { name: "doc-1" }],
          );
        const reader = await openMmdb(
          writeMmdb(entries, { recordSize, ipVersion }),
        );
        expect(reader.metadata).toMatchObject({
          recordSize,
          ipVersion,
          databaseType: "Test",
          binaryFormatMajorVersion: 2,
        });
        // The /25 inside it split the /24: its other half is a /25 network
        // in the tree, as a MaxMind writer would make it.
        expect(reader.lookupWithPrefix("1.1.1.5")).toEqual({
          record: { name: "one" },
          prefixLength: 25,
        });
        expect(reader.lookupWithPrefix("1.1.1.200")).toEqual({
          record: { name: "one-high" },
          prefixLength: 25,
        });
        expect(reader.lookupWithPrefix("203.0.113.7")).toEqual({
          record: { name: "single" },
          prefixLength: 32,
        });
        expect(reader.lookup("203.0.113.8")).toBeUndefined();
        expect(reader.lookup("9.9.9.9")).toBeUndefined();
        // An IPv4-mapped address reads as IPv4.
        expect(reader.lookup("::ffff:1.1.1.5")).toEqual({ name: "one" });
        if (ipVersion === 6) {
          expect(reader.lookupWithPrefix("2001:db8:1::5")).toEqual({
            record: { name: "doc-1" },
            prefixLength: 48,
          });
          expect(reader.lookup("2001:db8:2::")).toEqual({ name: "doc" });
          expect(reader.lookup("2001:db9::")).toBeUndefined();
        } else {
          expect(reader.lookup("2001:db8::1")).toBeUndefined();
        }
        expect(reader.lookup("not an address")).toBeUndefined();
      });
    }
  }

  it("decodes every type the format has", async () => {
    const reader = await openMmdb(
      writeMmdb([["1.1.1.0/24", EVERY_TYPE]], { ipVersion: 6 }),
    );
    const record = reader.lookup("1.1.1.0") as Record<string, unknown>;
    expect(record).toEqual({
      array: [1, 2, 3],
      boolean: true,
      bytes: Uint8Array.from([0, 0, 0, 42]),
      double: 42.123456,
      float: Math.fround(1.1),
      int32: -268435456,
      map: { mapX: { arrayX: [7, 8, 9], utf8_stringX: "hello" } },
      uint128: 1329227995784915872903807060280344576n,
      uint16: 100,
      uint32: 268435456,
      uint64: 1152921504606846976n,
      utf8_string: "unicode! ☯ - ♫",
      falsy: false,
      small64: 7,
    });
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("reads strings at every size-encoding boundary", async () => {
    const lengths = [0, 28, 29, 284, 285, 65820, 65821, 70000];
    const entries = lengths.map((length, i): [string, WriterValue] => [
      `10.0.${i}.0/24`,
      "x".repeat(length),
    ]);
    const reader = await openMmdb(writeMmdb(entries, { ipVersion: 4 }));
    lengths.forEach((length, i) => {
      expect((reader.lookup(`10.0.${i}.1`) as string).length).toBe(length);
    });
  });

  for (const [size, padding] of [
    [0, 0],
    [1, 3000],
    [2, 600_000],
    [3, 0],
  ] as const) {
    it(`follows size-${size} pointers`, async () => {
      const shared = "a shared organisation name";
      const reader = await openMmdb(
        writeMmdb(
          [
            ["10.0.0.0/24", { org: shared, n: u16(1) }],
            ["10.0.1.0/24", { org: shared, n: u16(2) }],
          ],
          { ipVersion: 4, pointers: { minLength: 3, size }, padding },
        ),
      );
      expect(reader.lookup("10.0.0.1")).toEqual({ org: shared, n: 1 });
      expect(reader.lookup("10.0.1.1")).toEqual({ org: shared, n: 2 });
    });
  }

  it("reads a file by path, and refuses a missing one", async () => {
    const path = join(work, "test.mmdb");
    writeFileSync(path, writeMmdb([["1.1.1.0/24", "x"]], { ipVersion: 4 }));
    expect((await openMmdb(path)).lookup("1.1.1.1")).toBe("x");
    await expect(openMmdb(join(work, "missing.mmdb"))).rejects.toThrow(
      MmdbError,
    );
  });

  it("agrees with a naive longest-prefix match on random networks", async () => {
    const seed = Number(
      process.env.MMDB_SEED ?? Math.floor(Math.random() * 1_000_000),
    );
    console.log(`mmdb property seed ${seed}`);
    const random = seededRandom(seed);
    for (const ipVersion of [4, 6] as const) {
      // Networks inserted least specific first (the writer's rule).
      const networks: { text: string; bits: number }[] = [];
      for (let i = 0; i < 60; i++) {
        const v6 = ipVersion === 6 && random() < 0.5;
        const bits = v6
          ? 16 + Math.floor(random() * 100)
          : 8 + Math.floor(random() * 25);
        const words = v6
          ? Uint32Array.from([
              0x20010db8,
              randomWord(random),
              randomWord(random),
              randomWord(random),
            ])
          : Uint32Array.from([(10 << 24) | (randomWord(random) & 0xffffff)]);
        const cidr = parseCidr(`${formatAddress(v6 ? 6 : 4, words)}/${bits}`)!;
        networks.push({ text: cidr.text, bits });
      }
      networks.sort((a, b) => a.bits - b.bits);
      const unique = [...new Map(networks.map((n) => [n.text, n])).values()];
      const reader = await openMmdb(
        writeMmdb(
          unique.map((n): [string, WriterValue] => [n.text, n.text]),
          {
            ipVersion,
            recordSize: ([24, 28, 32] as const)[Math.floor(random() * 3)],
          },
        ),
      );
      for (let probe = 0; probe < 400; probe++) {
        const v6 = ipVersion === 6 && random() < 0.5;
        const base = unique[Math.floor(random() * unique.length)]!;
        const cidr = parseCidr(base.text)!;
        // Near a network: its base with random low bits.
        const words = Uint32Array.from(cidr.words);
        const last = words.length - 1;
        words[last] =
          (words[last]! ^
            (randomWord(random) & (random() < 0.5 ? 0xff : 0xffff))) >>>
          0;
        if (v6 !== (cidr.family === 6)) continue;
        const address = formatAddress(cidr.family, words);
        let expected: string | undefined;
        for (const network of unique) {
          const range = parseCidr(network.text)!;
          if (range.family !== cidr.family) continue;
          const probeRange = parseCidr(`${address}/${range.bits}`)!;
          if (probeRange.text === range.text) expected = network.text;
        }
        expect(`${address} → ${String(reader.lookup(address))}`).toBe(
          `${address} → ${String(expected)}`,
        );
      }
    }
  });
});

describe("a corrupt database", () => {
  const good = () => writeMmdb([["1.1.1.0/24", { a: "b" }]], { ipVersion: 4 });

  it("without its metadata marker is refused", () => {
    expect(() => new MmdbReader(new Uint8Array(100))).toThrow(
      /no metadata marker/,
    );
  });

  it("whose record points outside the data section is refused at lookup", () => {
    const file = good();
    // The first node's records (24-bit): point both far past the data.
    file.set([0xff, 0xff, 0xf0, 0xff, 0xff, 0xf0], 0);
    const reader = new MmdbReader(file);
    expect(() => reader.lookup("1.1.1.1")).toThrow(MmdbError);
  });

  it("with an impossible record size or version is refused", () => {
    const text = (file: Uint8Array) => new TextDecoder("latin1").decode(file);
    for (const [from, to] of [
      ["record_size", "record_sizX"],
      ["ip_version", "ip_versioX"],
      ["binary_format_major_version", "binary_format_major_versioX"],
    ] as const) {
      const file = good();
      const at = text(file).lastIndexOf(from);
      file.set(new TextEncoder().encode(to), at);
      expect(() => new MmdbReader(file)).toThrow(MmdbError);
    }
  });

  it("whose values run past the end, nest too deep or chain pointers is refused, never hangs", () => {
    // A map that claims more entries than the file holds.
    const tooLong = writeMmdb([["1.1.1.0/24", { a: "b" }]], { ipVersion: 4 });
    const reader = new MmdbReader(tooLong);
    expect(reader.lookup("1.1.1.1")).toEqual({ a: "b" });
    // Nesting: a record of arrays 100 deep.
    let deep: WriterValue = "leaf";
    for (let i = 0; i < 100; i++) deep = [deep];
    const nested = new MmdbReader(
      writeMmdb([["1.1.1.0/24", deep]], { ipVersion: 4 }),
    );
    expect(() => nested.lookup("1.1.1.1")).toThrow(/nest too deeply/);
    // A pointer to a pointer: the shared string's second use, then rewrite
    // the first string's control byte into a pointer.
    const file = writeMmdb(
      [
        ["10.0.0.0/24", { org: "shared-name" }],
        ["10.0.1.0/24", { org: "shared-name" }],
      ],
      { ipVersion: 4, pointers: { minLength: 3, size: 0 } },
    );
    const latin = new TextDecoder("latin1").decode(file);
    const at = latin.indexOf("shared-name") - 1; // its control byte
    file.set([0x20, 0x00], at);
    expect(() => new MmdbReader(file).lookup("10.0.1.1")).toThrow(MmdbError);
  });
});
