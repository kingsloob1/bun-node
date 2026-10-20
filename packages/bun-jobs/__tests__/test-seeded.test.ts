import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  discoverTestFiles,
  failedTests,
  mulberry32,
  parseCounts,
  partitionFiles,
  readTimings,
  seededShuffle,
  shardArgs,
  withoutDatabaseUrls,
} from "../scripts/test-seeded";

/** Forty made-up test files, enough for pairings to differ between seeds. */
const FILES = Array.from(
  { length: 40 },
  (_, index) => `__tests__/file-${String(index).padStart(2, "0")}.test.ts`,
);

/** Every unordered pair of files that share a shard, as `a|b`. */
function pairings(shards: string[][]): Set<string> {
  const pairs = new Set<string>();
  for (const shard of shards) {
    const sorted = [...shard].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++)
        pairs.add(`${sorted[i]}|${sorted[j]}`);
    }
  }
  return pairs;
}

describe("partitionFiles", () => {
  test("puts every file in exactly one shard", () => {
    for (const shards of [1, 2, 3, 4, 7, 40]) {
      const result = partitionFiles(FILES, 12345, shards);
      const all = result.flat();
      expect(all.length).toBe(FILES.length);
      expect(new Set(all).size).toBe(FILES.length);
      expect([...all].sort()).toEqual([...FILES].sort());
    }
  });

  test("deals evenly: shard sizes differ by at most one", () => {
    const sizes = partitionFiles(FILES.slice(0, 39), 7, 4).map(
      (shard) => shard.length,
    );
    expect(sizes).toEqual([10, 10, 10, 9]);
  });

  test("is deterministic for a seed, whatever order the files arrive in", () => {
    const first = partitionFiles(FILES, 42, 4);
    expect(partitionFiles(FILES, 42, 4)).toEqual(first);
    expect(partitionFiles([...FILES].reverse(), 42, 4)).toEqual(first);
  });

  test("pairs different files for different seeds", () => {
    const one = pairings(partitionFiles(FILES, 1, 4));
    const two = pairings(partitionFiles(FILES, 2, 4));
    const three = pairings(partitionFiles(FILES, 3, 4));
    expect(one).not.toEqual(two);
    expect(two).not.toEqual(three);
    // Not merely reordered within the same groups: a large share of the pairs change.
    const shared = [...one].filter((pair) => two.has(pair)).length;
    expect(shared).toBeLessThan(one.size / 2);
  });

  test("with more shards than files, gives one file per shard and no empty shard", () => {
    const files = FILES.slice(0, 3);
    const result = partitionFiles(files, 9, 10);
    expect(result.length).toBe(3);
    for (const shard of result) expect(shard.length).toBe(1);
    expect(result.flat().sort()).toEqual([...files].sort());
  });

  test("K = 1 is one shard holding every file", () => {
    const result = partitionFiles(FILES, 5, 1);
    expect(result.length).toBe(1);
    expect([...result[0]].sort()).toEqual([...FILES].sort());
  });

  test("no files, no shards", () => {
    expect(partitionFiles([], 1, 4)).toEqual([]);
  });

  test("refuses a shard count below one or not whole", () => {
    expect(() => partitionFiles(FILES, 1, 0)).toThrow(RangeError);
    expect(() => partitionFiles(FILES, 1, -2)).toThrow(RangeError);
    expect(() => partitionFiles(FILES, 1, 1.5)).toThrow(RangeError);
    expect(() => partitionFiles(FILES, 1, Number.NaN)).toThrow(RangeError);
  });
});

describe("partitionFiles with weights", () => {
  /** Uneven durations: a few slow files among many quick ones, as in bun-jobs. */
  const WEIGHTS: Record<string, number> = Object.fromEntries(
    FILES.map((file, index) => [
      file,
      index % 10 === 0 ? 60_000 : 500 + index * 37,
    ]),
  );
  const load = (shard: string[], weights = WEIGHTS) =>
    shard.reduce((sum, file) => sum + (weights[file] ?? 0), 0);

  test("puts every file in exactly one shard, deterministically", () => {
    const result = partitionFiles(FILES, 11, 4, WEIGHTS);
    expect(result.flat().sort()).toEqual([...FILES].sort());
    expect(partitionFiles([...FILES].reverse(), 11, 4, WEIGHTS)).toEqual(
      result,
    );
  });

  test("keeps every shard within one file's weight of the others", () => {
    const heaviest = Math.max(...Object.values(WEIGHTS));
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const loads = partitionFiles(FILES, seed, 4, WEIGHTS).map((shard) =>
        load(shard),
      );
      expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(
        heaviest,
      );
    }
  });

  test("balances better than round-robin on uneven files", () => {
    let weighted = 0;
    let roundRobin = 0;
    for (let seed = 1; seed <= 30; seed++) {
      weighted += Math.max(
        ...partitionFiles(FILES, seed, 4, WEIGHTS).map((shard) => load(shard)),
      );
      roundRobin += Math.max(
        ...partitionFiles(FILES, seed, 4).map((shard) => load(shard)),
      );
    }
    expect(weighted).toBeLessThan(roundRobin);
  });

  test("puts a heavy file only where it fits under the fair share: here, one per shard", () => {
    // Four files of 60 s against a fair share of about 71 s: no two fit together.
    const heavy = FILES.filter((file) => WEIGHTS[file] === 60_000);
    expect(heavy.length).toBe(4);
    for (const seed of [1, 2, 3, 4, 5]) {
      for (const shard of partitionFiles(FILES, seed, 4, WEIGHTS))
        expect(shard.filter((file) => heavy.includes(file)).length).toBe(1);
    }
  });

  test("lets two heavy files share a shard when they fit, for some seeds", () => {
    // Two files of 30 s and sixty of 1 s in 2 shards: a fair share of 60 s,
    // so the two heavy files fit together exactly.
    const files = [
      "heavy-1.test.ts",
      "heavy-2.test.ts",
      ...FILES.slice(0, 30),
      ...FILES.map((file) => file.replace("file-", "more-")).slice(0, 30),
    ];
    const weights: Record<string, number> = Object.fromEntries(
      files.map((file) => [file, file.startsWith("heavy") ? 30_000 : 1_000]),
    );
    let together = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const result = partitionFiles(files, seed, 2, weights);
      if (
        result.some(
          (shard) =>
            shard.includes("heavy-1.test.ts") &&
            shard.includes("heavy-2.test.ts"),
        )
      )
        together++;
      expect(result.flat().sort()).toEqual([...files].sort());
    }
    expect(together).toBeGreaterThan(0);
    expect(together).toBeLessThan(40);
  });

  test("still pairs different files for different seeds", () => {
    const one = pairings(partitionFiles(FILES, 1, 4, WEIGHTS));
    const two = pairings(partitionFiles(FILES, 2, 4, WEIGHTS));
    expect(one).not.toEqual(two);
    expect([...one].filter((pair) => two.has(pair)).length).toBeLessThan(
      one.size / 2,
    );
  });

  test("leaves no shard empty, even when every weight is zero", () => {
    const zero = Object.fromEntries(FILES.map((file) => [file, 0]));
    const result = partitionFiles(FILES.slice(0, 6), 3, 4, zero);
    expect(result.length).toBe(4);
    for (const shard of result) expect(shard.length).toBeGreaterThan(0);
  });

  test("counts an untimed file as the median, not as free", () => {
    // Three timed files of 10 s and one untimed: the untimed one must not all
    // pile onto the shard that already holds a timed file's 10 s.
    const files = [
      "a.test.ts",
      "b.test.ts",
      "c.test.ts",
      "d.test.ts",
      "e.test.ts",
      "f.test.ts",
    ];
    const weights = {
      "a.test.ts": 10_000,
      "b.test.ts": 10_000,
      "c.test.ts": 10_000,
    };
    for (const seed of [1, 2, 3, 4, 5]) {
      const result = partitionFiles(files, seed, 3, weights);
      for (const shard of result) expect(shard.length).toBe(2);
    }
  });
});

describe("readTimings", () => {
  test("reads a bun --timings file and rejects anything else", async () => {
    const dir = mkdtempSync(join(tmpdir(), "test-seeded-timings-"));
    try {
      await Bun.write(
        join(dir, "ok.json"),
        JSON.stringify({
          version: 1,
          files: { "a.test.ts": 12, "b.test.ts": "x" },
        }),
      );
      await Bun.write(join(dir, "bad.json"), "{ not json");
      await Bun.write(join(dir, "shape.json"), JSON.stringify({ version: 1 }));
      expect(readTimings(join(dir, "ok.json"))).toEqual({ "a.test.ts": 12 });
      expect(readTimings(join(dir, "bad.json"))).toBeUndefined();
      expect(readTimings(join(dir, "shape.json"))).toBeUndefined();
      expect(readTimings(join(dir, "missing.json"))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("seededShuffle and mulberry32", () => {
  test("the same seed gives the same sequence; another seed does not", () => {
    const a = mulberry32(99);
    const b = mulberry32(99);
    const sequence = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(sequence);
    const c = mulberry32(100);
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(sequence);
    for (const value of sequence) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  test("shuffles a copy and keeps every item", () => {
    const input = [...FILES];
    const out = seededShuffle(input, 3);
    expect(input).toEqual(FILES);
    expect(out).not.toEqual(FILES);
    expect([...out].sort()).toEqual([...FILES].sort());
  });

  test("works for the full seed range bun test accepts", () => {
    expect(seededShuffle(FILES, 0xffffffff).length).toBe(FILES.length);
    expect(seededShuffle(FILES, 0).length).toBe(FILES.length);
  });
});

describe("shardArgs", () => {
  test("runs the files serially with the seed, each as a ./ path", () => {
    expect(
      shardArgs(["__tests__/a.test.ts", "__tests__/b.test.ts"], 8),
    ).toEqual([
      "test",
      "--randomize",
      "--seed=8",
      "./__tests__/a.test.ts",
      "./__tests__/b.test.ts",
    ]);
    expect(shardArgs(["x.test.ts"], 1)).not.toContain("--parallel");
  });
});

describe("withoutDatabaseUrls", () => {
  test("removes every BUN_JOBS_TEST_*_URL and nothing else", () => {
    const env = {
      PATH: "/bin",
      BUN_JOBS_TEST_REDIS_URL: "redis://x",
      BUN_JOBS_TEST_POSTGRES_URL: "postgres://x",
      BUN_JOBS_TEST_MARIADB_URL: "mysql://x",
      BUN_JOBS_TEST_MYSQL_URL: "mysql://y",
      BUN_JOBS_TEST_MONGODB_URL: "mongodb://x",
      BUN_JOBS_TEST_AJV_DIR: "/ajv",
      UNSET: undefined,
    };
    expect(withoutDatabaseUrls(env)).toEqual({
      PATH: "/bin",
      BUN_JOBS_TEST_AJV_DIR: "/ajv",
    });
  });
});

describe("parseCounts", () => {
  test("reads bun test's summary", () => {
    const output =
      "bun test v1.4.3\n\n --seed=3\n 37 pass\n 2 skip\n 1 fail\n 104 expect() calls\nRan 40 tests across 2 files. [224.00ms]\n";
    expect(parseCounts(output)).toEqual({
      pass: 37,
      fail: 1,
      skip: 2,
      todo: 0,
      files: 2,
    });
  });

  test("reports no file count when there is no summary (a crash)", () => {
    expect(
      parseCounts("bun test v1.4.3\nSegmentation fault\n").files,
    ).toBeUndefined();
  });
});

describe("failedTests", () => {
  test("names each failed test under its file heading", () => {
    const output = [
      "bun test v1.4.3",
      "",
      "__tests__/leak-b.test.ts:",
      "4 |   expect(x).toBeUndefined();",
      "error: expect(received).toBeUndefined()",
      "(fail) finds no leaked global [0.17ms]",
      "(fail) another one",
      "",
      " 1 fail",
    ].join("\n");
    expect(failedTests(output)).toEqual([
      "__tests__/leak-b.test.ts > finds no leaked global",
      "__tests__/leak-b.test.ts > another one",
    ]);
  });
});

describe("discoverTestFiles", () => {
  test("finds this package's test files, this one included, and nothing in node_modules", () => {
    const files = discoverTestFiles(join(import.meta.dir, ".."));
    expect(files).toContain("__tests__/test-seeded.test.ts");
    expect(files.some((file) => file.includes("node_modules"))).toBe(false);
    expect(files.some((file) => file.endsWith(".type-test.ts"))).toBe(false);
    expect(files).toEqual([...files].sort());
  });
});
