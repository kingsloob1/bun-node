/**
 * `redisDriver`'s `keyLocking` option (Upstash's `allow-key-locking`), with
 * no server: a stand-in client records every script the driver sends. The
 * flag must be on every script when opted in and on none otherwise, the
 * digest `EVALSHA` names must be the text's own, and a server's refusal of
 * the flag must name the option. Against real servers: `redisSuite.ts` (local
 * Redis refuses the flag; the Upstash lane runs everything key-locked).
 */
import { describe, expect, test } from "bun:test";
import type { RedisClient } from "bun";
import type { StoredEntry } from "../../lib/index";
import { RedisCacheDriver } from "../../lib/drivers/redis";

/** The shebang the option adds to a script that writes. */
const SHEBANG = "#!lua flags=allow-key-locking\n";

/** The shebang the option adds to a script that only reads and removes: also `allow-oom`. */
const FREEING_SHEBANG = "#!lua flags=allow-key-locking,allow-oom\n";

/**
 * Which shebang each operation's scripts carry when key-locked. `allow-oom`
 * only where every command reads or removes: `delete`, `releaseLock` and the
 * sweep's two prunes (a tag set's, a stamp's). `deleteByTags` writes stamps,
 * and the others write entries, counters or locks.
 */
const EXPECTED_SHEBANGS: Record<Operation, string[]> = {
  set: [SHEBANG],
  delete: [FREEING_SHEBANG],
  touch: [SHEBANG],
  deleteByTags: [SHEBANG],
  increment: [SHEBANG],
  acquireLock: [SHEBANG],
  releaseLock: [FREEING_SHEBANG],
  sweep: [FREEING_SHEBANG, FREEING_SHEBANG],
};

/** The driver operations that send a script. */
type Operation =
  | "set"
  | "delete"
  | "touch"
  | "deleteByTags"
  | "increment"
  | "acquireLock"
  | "releaseLock"
  | "sweep";

/** What the stand-in client saw. */
interface Recorded {
  /** The digests `EVALSHA` named, in order. */
  shas: string[];
  /** The sources `EVAL` sent, in order. */
  sources: string[];
}

/** What the stand-in client saw, and which sources each operation sent. */
interface RecordedByOperation extends Recorded {
  /** The sources each operation sent, in order. */
  byOperation: Record<Operation, string[]>;
}

/**
 * A stand-in `RedisClient`: connects, answers `INFO` with nothing, refuses
 * every `EVALSHA` with `NOSCRIPT` (so each source reaches `EVAL`), answers
 * `EVAL` with 1 or `evalError`, and `SCAN` with one tag set and one stamp.
 */
function standIn(evalError?: string): {
  client: RedisClient;
  recorded: Recorded;
} {
  const recorded: Recorded = { shas: [], sources: [] };
  const client = {
    connected: true,
    connect: async () => {},
    send: async () => "",
    evalsha: async (sha: string) => {
      recorded.shas.push(sha);
      throw new Error("NOSCRIPT No matching script. Please use EVAL.");
    },
    eval: async (source: string) => {
      recorded.sources.push(source);
      if (evalError !== undefined) {
        throw new Error(evalError);
      }
      return 1;
    },
    scan: async () => ["0", ["p:{ns}:t:red", "p:{ns}:s:blue"]],
    close: () => {},
  };
  return { client: client as unknown as RedisClient, recorded };
}

/** An entry. */
function entry(key: string, tags: readonly string[]): StoredEntry {
  return { key, value: new Uint8Array([1]), expiresAt: null, tags };
}

/** Runs every operation that sends a script — all nine scripts — and answers what was sent, by operation. */
async function everyScript(
  keyLocking: boolean | undefined,
): Promise<RecordedByOperation> {
  const { client, recorded } = standIn();
  const driver = new RedisCacheDriver({ client, prefix: "p", keyLocking });
  const byOperation = {} as Record<Operation, string[]>;
  /** Runs one operation, noting the sources it sent. */
  const step = async (
    operation: Operation,
    run: () => Promise<unknown>,
  ): Promise<void> => {
    const before = recorded.sources.length;
    await run();
    byOperation[operation] = recorded.sources.slice(before);
  };
  await step("set", async () =>
    driver.set("ns", entry("k", ["red"]), {
      tags: ["red"],
      createdAt: Date.now(),
    }),
  );
  await step("delete", async () => driver.delete("ns", ["k", "j"]));
  await step("touch", async () => driver.touch("ns", "k", Date.now() + 60_000));
  await step("deleteByTags", async () =>
    driver.deleteByTags("ns", ["red", "blue"], Date.now() + 60_000),
  );
  await step("increment", async () => driver.increment("ns", "c", 1, null));
  await step("acquireLock", async () =>
    driver.acquireLock("ns", "l", "me", 1_000),
  );
  await step("releaseLock", async () => driver.releaseLock("ns", "l", "me"));
  await step("sweep", async () => driver.sweep(Date.now(), 100));
  await driver.close();
  return { ...recorded, byOperation };
}

/** SHA-1, hex. */
function sha1(text: string): string {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(text);
  return hasher.digest("hex");
}

describe("redisDriver keyLocking", () => {
  test("off (the default, and false): no script carries a shebang or the flag", async () => {
    for (const option of [undefined, false]) {
      const { sources } = await everyScript(option);
      expect(new Set(sources).size).toBe(9);
      for (const source of sources) {
        expect(source.startsWith("#!")).toBe(false);
        expect(source.includes("allow-key-locking")).toBe(false);
      }
    }
  });

  test("on: every script starts with the flag, and is otherwise the same script", async () => {
    const plain = await everyScript(false);
    const locked = await everyScript(true);
    expect(locked.sources.length).toBe(plain.sources.length);
    locked.sources.forEach((source, index) => {
      expect(source.startsWith("#!lua flags=allow-key-locking")).toBe(true);
      const body = source.slice(source.indexOf("\n") + 1);
      expect(body).toBe(plain.sources[index]);
    });
  });

  test("on: allow-oom only on the scripts that only read and remove (delete, releaseLock, the sweep's prunes); never on one that writes", async () => {
    const { byOperation } = await everyScript(true);
    for (const [operation, shebangs] of Object.entries(EXPECTED_SHEBANGS)) {
      const sent = byOperation[operation as Operation];
      expect({
        operation,
        shebangs: sent.map((source) =>
          source.slice(0, source.indexOf("\n") + 1),
        ),
      }).toEqual({ operation, shebangs });
    }
    // Four distinct scripts carry it, five do not.
    const freeing = new Set(
      Object.values(byOperation)
        .flat()
        .filter((source) => source.startsWith(FREEING_SHEBANG)),
    );
    const writing = new Set(
      Object.values(byOperation)
        .flat()
        .filter((source) => source.startsWith(SHEBANG)),
    );
    expect([freeing.size, writing.size]).toEqual([4, 5]);
  });

  test("EVALSHA names the digest of the text EVAL sends, so the plain and key-locked scripts never share one", async () => {
    for (const option of [false, true]) {
      const { shas, sources } = await everyScript(option);
      expect(shas).toEqual(sources.map(sha1));
    }
    const plain = await everyScript(false);
    const locked = await everyScript(true);
    for (const sha of locked.shas) {
      expect(plain.shas.includes(sha)).toBe(false);
    }
  });

  test("a server refusing the flag fails naming the option, its message kept; with the option off the same error passes through", async () => {
    const refusals = [
      // Redis 8.0.5, measured.
      "ERR Unexpected flag in script shebang: allow-key-locking",
      // Redis 6, which has no shebang: Lua cannot compile the `#!` line.
      "ERR Error compiling script (new function): user_script:1: unexpected symbol near '#'",
    ];
    for (const refusal of refusals) {
      const { client } = standIn(refusal);
      const driver = new RedisCacheDriver({
        client,
        prefix: "p",
        keyLocking: true,
      });
      const failure = await driver
        .set("ns", entry("k", []))
        .then(() => undefined)
        .catch((error: unknown) => error as Error);
      expect(failure?.message).toContain(
        "redisDriver: keyLocking is set, and redis refused Upstash's allow-key-locking script flag",
      );
      expect(failure?.message).toContain(refusal);
      expect(failure?.message).toContain("Remove keyLocking");
      expect((failure?.cause as Error).message).toBe(refusal);

      const { client: plainClient } = standIn(refusal);
      const plain = new RedisCacheDriver({ client: plainClient, prefix: "p" });
      await expect(plain.set("ns", entry("k", []))).rejects.toThrow(
        new Error(refusal),
      );
    }
    // Any other script error is the caller's, unchanged, key-locked or not.
    const { client } = standIn("ERR something else");
    const driver = new RedisCacheDriver({
      client,
      prefix: "p",
      keyLocking: true,
    });
    await expect(driver.set("ns", entry("k", []))).rejects.toThrow(
      new Error("ERR something else"),
    );
  });
});
