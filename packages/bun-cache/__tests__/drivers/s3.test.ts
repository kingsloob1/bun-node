/**
 * The S3 driver (plan §7.8): the SigV4 signer against AWS's published
 * examples, the URL and option rules, and a fake store that ignores
 * conditional writes — all without a server — then the conformance kit (with
 * its two-process pass) and the driver's specifics on the server
 * `BUN_CACHE_TEST_S3_URL` (or `BUN_JOBS_TEST_S3_URL`) names: SeaweedFS from
 * `bun scripts/setup-databases.ts --print-env`, which checks signatures.
 *
 * Test data: every object carries this run's prefix
 * (`bun-cache-test/<pid>-<time>/…`), and the end of the file deletes exactly
 * the objects under the prefixes it used. A backend whose URL is unset skips
 * visibly; one whose URL is set but unreachable fails, naming the variable.
 */
import process from "node:process";
import { afterAll, describe, expect, test } from "bun:test";
import { S3Client } from "bun";
import type { StoredEntry } from "../../lib/index";
import {
  createCache,
  s3Driver,
  UnsupportedOperationError,
} from "../../lib/index";
import type { S3DriverOptions } from "../../lib/drivers/s3";
import {
  parseContentType,
  parseS3Url,
  resolveSigningTarget,
  S3CacheDriver,
} from "../../lib/drivers/s3";
import { s3Encode, signS3Request } from "../../lib/drivers/s3-sign";
import { runCacheDriverConformance } from "../../lib/testing/index";
import { deleteS3Prefix, s3RawDump, s3Backend, s3ReachError } from "./backends";
import { reportNotConfigured, reportUnreachable } from "./sqlSuite";

/** An entry for the specifics. */
function entry(
  key: string,
  bytes: number[],
  tags: readonly string[] = [],
  expiresAt: number | null = null,
): StoredEntry {
  return { key, value: new Uint8Array(bytes), expiresAt, tags };
}

/** The hex SHA-256 of a name, as the driver's object names use it. */
function sha(name: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(name);
  return hasher.digest("hex");
}

/** Runs `body` with some environment variables set (or removed, for `undefined`), restoring them after. */
function withEnv<T>(
  vars: Record<string, string | undefined>,
  body: () => T,
): T {
  const saved = Object.fromEntries(
    Object.keys(vars).map((name) => [name, process.env[name]]),
  );
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    return body();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

/** Every `S3_*`/`AWS_*` variable the driver reads, removed, so a test sees only what it sets. */
const NO_S3_ENV = Object.fromEntries(
  [
    "ACCESS_KEY_ID",
    "SECRET_ACCESS_KEY",
    "SESSION_TOKEN",
    "REGION",
    "ENDPOINT",
    "BUCKET",
  ].flatMap((name) => [
    [`S3_${name}`, undefined],
    [`AWS_${name}`, undefined],
  ]),
) as Record<string, undefined>;

describe("the SigV4 signer", () => {
  // AWS's worked examples, "Signature Calculations for the Authorization
  // Header: Transferring Payload in a Single Chunk (AWS Signature Version 4)".
  const credentials = {
    region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  };
  const date = new Date("2013-05-24T00:00:00Z");
  const emptyHash =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const signature = (headers: Record<string, string>): string =>
    /Signature=([0-9a-f]+)/.exec(headers.authorization)?.[1] ?? "";

  test("GET Object, with a signed Range header", () => {
    const headers = signS3Request(credentials, {
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { Range: "bytes=0-9" },
      payloadHash: emptyHash,
      date,
    });
    expect(headers.authorization).toContain(
      "Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,",
    );
    expect(signature(headers)).toBe(
      "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
    expect(headers.host).toBeUndefined();
  });

  test("PUT Object, with an encoded key and extra headers", () => {
    const headers = signS3Request(credentials, {
      method: "PUT",
      url: new URL(
        `https://examplebucket.s3.amazonaws.com/${s3Encode("test$file.text")}`,
      ),
      headers: {
        Date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      },
      payloadHash:
        "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
      date,
    });
    expect(signature(headers)).toBe(
      "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });

  test("GET Bucket (list), with a sorted query string", () => {
    const headers = signS3Request(credentials, {
      method: "GET",
      url: new URL(
        "https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2",
      ),
      payloadHash: emptyHash,
      date,
    });
    expect(signature(headers)).toBe(
      "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    );
  });

  test("encodes what S3 encodes, and signs a session token", () => {
    expect(s3Encode("a b!'()*~._-")).toBe("a%20b%21%27%28%29%2A~._-");
    const headers = signS3Request(
      { ...credentials, sessionToken: "token" },
      { method: "GET", url: new URL("https://h/x"), date },
    );
    expect(headers["x-amz-security-token"]).toBe("token");
    expect(headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
    expect(headers.authorization).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,",
    );
  });
});

describe("s3Driver options", () => {
  test("parseS3Url reads the driver's URL into Bun's S3Options", () => {
    expect(
      parseS3Url(
        "s3://AK%2FID:se%2Bc%2Fret@127.0.0.1:8333/bucket?scheme=http&region=eu-1",
      ),
    ).toEqual({
      endpoint: "http://127.0.0.1:8333",
      bucket: "bucket",
      accessKeyId: "AK/ID",
      secretAccessKey: "se+c/ret",
      region: "eu-1",
    });
    // https by default, no credentials needed in the URL.
    expect(parseS3Url("s3://s3.eu-west-1.amazonaws.com/b")).toEqual({
      endpoint: "https://s3.eu-west-1.amazonaws.com",
      bucket: "b",
    });
    expect(() => parseS3Url("http://k:s@h/b")).toThrow("must start with s3://");
    expect(() => parseS3Url("s3://k:s@h")).toThrow("/<bucket>");
    expect(() => parseS3Url("s3://k:s@h/b/c")).toThrow("/<bucket>");
    expect(() => parseS3Url("s3://k:s@h/b?scheme=ftp")).toThrow(
      "https or http",
    );
    expect(() => parseS3Url("not a url")).toThrow("not a URL");
  });

  test("the signing target follows Bun's client: options, then S3_*/AWS_* variables, and its region rule", () => {
    withEnv(NO_S3_ENV, () => {
      expect(resolveSigningTarget({ bucket: "b" })).toBeUndefined();
      const custom = resolveSigningTarget({
        accessKeyId: "k",
        secretAccessKey: "s",
        bucket: "b",
        endpoint: "http://127.0.0.1:9000/",
      });
      // A custom endpoint signs for "auto", as Bun's presign() does.
      expect(custom).toEqual({
        endpoint: "http://127.0.0.1:9000",
        bucket: "b",
        region: "auto",
        accessKeyId: "k",
        secretAccessKey: "s",
        sessionToken: undefined,
        virtualHostedStyle: false,
      });
      // No endpoint: AWS in us-east-1.
      expect(
        resolveSigningTarget({
          accessKeyId: "k",
          secretAccessKey: "s",
          bucket: "b",
        })?.endpoint,
      ).toBe("https://s3.us-east-1.amazonaws.com");
      // An AWS endpoint names its region.
      expect(
        resolveSigningTarget({
          accessKeyId: "k",
          secretAccessKey: "s",
          bucket: "b",
          endpoint: "https://s3.eu-west-1.amazonaws.com",
        })?.region,
      ).toBe("eu-west-1");
    });
    withEnv(
      {
        ...NO_S3_ENV,
        AWS_ACCESS_KEY_ID: "aws-key",
        S3_SECRET_ACCESS_KEY: "s3-secret",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        AWS_BUCKET: "env-bucket",
        S3_REGION: "env-region",
      },
      () => {
        const target = resolveSigningTarget({});
        expect(target?.accessKeyId).toBe("aws-key");
        // S3_* before AWS_*.
        expect(target?.secretAccessKey).toBe("s3-secret");
        expect(target?.bucket).toBe("env-bucket");
        expect(target?.region).toBe("env-region");
        // An option wins over the environment.
        expect(resolveSigningTarget({ bucket: "mine" })?.bucket).toBe("mine");
      },
    );
  });

  test("refuses what it cannot run", () => {
    withEnv(NO_S3_ENV, () => {
      const url = "s3://k:s@127.0.0.1:1/b?scheme=http";
      expect(() => s3Driver({})).toThrow("needs a url");
      expect(() => s3Driver({ url, prefix: "" })).toThrow("prefix");
      expect(() => s3Driver({ url, prefix: "/abs" })).toThrow("prefix");
      expect(() => s3Driver({ url, maxEntries: 0 })).toThrow("maxEntries");
      expect(() => s3Driver({ url, maxBytes: 1.5 })).toThrow("maxBytes");
      const client = new S3Client({
        bucket: "b",
        accessKeyId: "k",
        secretAccessKey: "s",
      });
      expect(() => s3Driver({ client, conditionalWrites: true })).toThrow(
        "conditionalWrites needs credentials",
      );
      // A client alone: no conditional writes, so no counters or locks.
      const plain = s3Driver({ client });
      expect(plain.capabilities.atomicIncrement).toBe(false);
      expect(plain.capabilities.lock).toBe(false);
      // A trailing slash on the prefix is dropped.
      expect(new S3CacheDriver({ url, prefix: "p/" }).prefix).toBe("p");
      expect(new S3CacheDriver({ url }).prefix).toBe("bun-cache");
    });
  });

  test("the capabilities: stamps, a sweeper, no bus; counters and locks with conditional writes", () => {
    const url = "s3://k:s@127.0.0.1:1/b?scheme=http";
    expect(s3Driver({ url }).capabilities).toEqual({
      multiProcess: true,
      ttl: "sweep",
      atomicIncrement: true,
      lock: true,
      tags: "stamps",
      fence: "atomic",
      bus: "none",
      maxEntryBytes: 5 * 1024 ** 3 - 1024 ** 2,
    });
    const off = s3Driver({ url, conditionalWrites: false });
    expect(off.capabilities.atomicIncrement).toBe(false);
    expect(off.capabilities.lock).toBe(false);
  });

  test("an object's Content-Type carries its kind, expiry and write time", () => {
    expect(
      parseContentType(
        "application/x-bun-cache; exp=1760000000000; at=1759999999000",
      ),
    ).toEqual({ kind: "entry", expiresAt: 1760000000000, at: 1759999999000 });
    expect(parseContentType("application/x-bun-cache-counter; at=5")).toEqual({
      kind: "counter",
      expiresAt: null,
      at: 5,
    });
    expect(parseContentType("application/x-bun-cache-lock; exp=9").kind).toBe(
      "lock",
    );
    expect(parseContentType("text/plain").kind).toBeUndefined();
    expect(parseContentType(undefined).kind).toBeUndefined();
  });
});

describe("a store that ignores conditional writes", () => {
  test("is refused before the first counter or lock operation, naming the option", async () => {
    // A fake S3 that answers every request 200 and keeps nothing: a second
    // If-None-Match: * PUT "succeeds", as a store ignoring the header would.
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        seen.push(
          `${request.method} ${request.headers.get("if-none-match") ?? ""}`,
        );
        return new Response("", { status: 200, headers: { etag: '"x"' } });
      },
    });
    try {
      const url = `s3://k:s@127.0.0.1:${server.port}/b?scheme=http`;
      const driver = s3Driver({ url });
      await expect(driver.increment!("ns", "c", 1, null)).rejects.toThrow(
        "does not honour conditional writes",
      );
      await expect(driver.acquireLock!("ns", "k", "me", 1_000)).rejects.toThrow(
        "conditionalWrites: false",
      );
      // The verdict is kept: the probe ran once (two PUTs and its DELETE).
      expect(seen.filter((line) => line === "PUT *")).toHaveLength(2);
      // Off, the operations are unsupported rather than wrong.
      const off = s3Driver({ url, conditionalWrites: false });
      const refused = await off.increment!("ns", "c", 1, null).catch(
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(UnsupportedOperationError);
    } finally {
      await server.stop(true);
    }
  });
});

const s3 = s3Backend();
if (s3.url === undefined) {
  reportNotConfigured("s3", s3.variable);
} else {
  const unreachable = await s3ReachError(s3.url);
  if (unreachable !== undefined) {
    reportUnreachable("s3", s3.variable, unreachable);
  } else {
    await registerS3Suite(s3.url);
  }
}

/** Registers the kit and the specifics against the server at `url`. */
async function registerS3Suite(url: string): Promise<void> {
  const run = `bun-cache-test/${process.pid}-${Date.now().toString(36)}`;
  const prefixes = new Set<string>();
  /** A prefix of this run's, recorded so the end of the file deletes its objects. */
  const prefix = (suffix: string): string => {
    const value = `${run}/${suffix}`;
    prefixes.add(value);
    return value;
  };
  /** A driver on this run's objects. */
  const make = (
    suffix: string,
    extra: Partial<S3DriverOptions> = {},
  ): S3CacheDriver =>
    new S3CacheDriver({ url, prefix: prefix(suffix), ...extra });
  /** A plain client on the bucket, for looking at what the driver wrote. */
  const raw = new S3Client(parseS3Url(url));

  afterAll(async () => {
    for (const each of prefixes) {
      await deleteS3Prefix(url, each);
    }
  });

  const kitOptions = { url, prefix: prefix("kit") };
  await runCacheDriverConformance(
    "s3",
    () => ({
      driver: s3Driver(kitOptions),
      rawDump: async () => await s3RawDump(url, kitOptions.prefix),
    }),
    {
      crossProcess: {
        module: new URL("../../lib/drivers/s3.ts", import.meta.url).pathname,
        export: "s3Driver",
        options: kitOptions,
      },
    },
  );

  describe("s3Driver specifics", () => {
    test("the layout: entries and counters under e/<hh>/, stamps under s/, locks under l/, each typed", async () => {
      const driver = make("layout");
      const before = Date.now();
      await driver.set(
        "App",
        entry("some:key", [1, 2, 3], ["t"], before + 60_000),
      );
      await driver.setStamps("App", ["users"], before, before + 60_000);
      await driver.increment("App", "hits", 3, null);
      expect(await driver.acquireLock("App", "held", "owner", 60_000)).toBe(
        true,
      );
      const ns = `${driver.prefix}/^app`;
      const listed = (await raw.list({ prefix: `${driver.prefix}/` }))
        .contents!.map((object) => object.key)
        .sort();
      const keySha = sha("some:key");
      const hitsSha = sha("hits");
      expect(listed).toEqual(
        [
          `${ns}/e/${keySha.slice(0, 2)}/${keySha}`,
          `${ns}/e/${hitsSha.slice(0, 2)}/${hitsSha}`,
          `${ns}/l/${sha("held")}`,
          `${ns}/s/${sha("users")}`,
        ].sort(),
      );
      const typed = parseContentType(
        (await raw.stat(`${ns}/e/${keySha.slice(0, 2)}/${keySha}`)).type,
      );
      expect(typed.kind).toBe("entry");
      expect(typed.expiresAt).toBe(before + 60_000);
      expect(typed.at).toBeGreaterThanOrEqual(before);
      expect(
        parseContentType(
          (await raw.stat(`${ns}/e/${hitsSha.slice(0, 2)}/${hitsSha}`)).type,
        ).kind,
      ).toBe("counter");
      expect(
        parseContentType((await raw.stat(`${ns}/l/${sha("held")}`)).type).kind,
      ).toBe("lock");
      expect(
        parseContentType((await raw.stat(`${ns}/s/${sha("users")}`)).type)
          .expiresAt,
      ).toBe(before + 60_000);
    });

    test("namespaces of dots, and ones differing in case, are distinct and never resolved away", async () => {
      const driver = make("segments");
      for (const [index, ns] of [".", "..", "...", "a", "A"].entries()) {
        await driver.set(ns, entry("k", [index]));
      }
      for (const [index, ns] of [".", "..", "...", "a", "A"].entries()) {
        expect((await driver.get(ns, "k"))?.value).toEqual(
          new Uint8Array([index]),
        );
      }
      const listed = (await raw.list({ prefix: `${driver.prefix}/` }))
        .contents!;
      expect(listed).toHaveLength(5);
      expect(listed.every((object) => !/\/\.+\//.test(object.key))).toBe(true);
    });

    test("an entry and a counter share their key's object: the last writer wins", async () => {
      const driver = make("share");
      await driver.set("ns", entry("k", [9]));
      expect(await driver.increment("ns", "k", 2, null)).toBe(2);
      expect(await driver.get("ns", "k")).toBeUndefined();
      expect((await driver.getCounter("ns", "k"))?.value).toBe(2);
      await driver.set("ns", entry("k", [8]));
      expect(await driver.getCounter("ns", "k")).toBeUndefined();
      expect((await driver.get("ns", "k"))?.value).toEqual(new Uint8Array([8]));
      // `delete` counts the one object, entry or counter.
      await driver.increment("ns", "c", 1, null);
      expect(await driver.delete("ns", ["k", "c", "none"])).toBe(2);
    });

    test("a lapsed counter starts again, with the expiry of the call that recreates it", async () => {
      const driver = make("lapsed");
      await driver.increment("ns", "c", 5, Date.now() + 30);
      await Bun.sleep(50);
      const fresh = Date.now() + 60_000;
      expect(await driver.increment("ns", "c", 1, fresh)).toBe(1);
      expect((await driver.getCounter("ns", "c"))?.expiresAt).toBe(fresh);
    });

    test("concurrent increments of one key are batched: each caller gets its own value", async () => {
      const driver = make("batch");
      const results = await Promise.all(
        Array.from(
          { length: 50 },
          async (_, index) =>
            await driver.increment("ns", "c", index % 2 === 0 ? 1 : 2, null),
        ),
      );
      // 25 ones and 25 twos: 75 in all, and every answer distinct.
      expect(Math.max(...results)).toBe(75);
      expect(new Set(results).size).toBe(50);
      expect((await driver.getCounter("ns", "c"))?.value).toBe(75);
    });

    test("two drivers incrementing one key lose nothing (compare-and-swap across instances)", async () => {
      const a = make("cas");
      const b = new S3CacheDriver({ url, prefix: a.prefix });
      const results = await Promise.all(
        Array.from(
          { length: 60 },
          async (_, index) =>
            await (index % 2 === 0 ? a : b).increment("ns", "c", 1, null),
        ),
      );
      expect(new Set(results).size).toBe(60);
      expect((await a.getCounter("ns", "c"))?.value).toBe(60);
    });

    test("a lapsed lock is taken over by exactly one of many contenders, and the old owner cannot release it", async () => {
      const driver = make("takeover");
      expect(await driver.acquireLock("ns", "k", "old", 30)).toBe(true);
      await Bun.sleep(60);
      const outcomes = await Promise.all(
        Array.from(
          { length: 20 },
          async (_, index) =>
            await driver.acquireLock("ns", "k", `new-${index}`, 30_000),
        ),
      );
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(await driver.releaseLock("ns", "k", "old")).toBe(false);
      const winner = `new-${outcomes.indexOf(true)}`;
      // Its owner re-acquiring refreshes it; anyone else is refused.
      expect(await driver.acquireLock("ns", "k", winner, 30_000)).toBe(true);
      expect(await driver.acquireLock("ns", "k", "late", 30_000)).toBe(false);
      expect(await driver.releaseLock("ns", "k", winner)).toBe(true);
      expect(await driver.releaseLock("ns", "k", winner)).toBe(false);
    });

    test("across instances, only the store's conditions decide: one of three takes a free lock, one of three a lapsed one", async () => {
      // Separate instances queue nothing between them (each has its own
      // in-process queue), as separate processes would not. SeaweedFS makes
      // each concurrent loser wait about a second, hence three, not fifty.
      const first = make("instances");
      const drivers = [
        first,
        new S3CacheDriver({ url, prefix: first.prefix }),
        new S3CacheDriver({ url, prefix: first.prefix }),
      ];
      const free = await Promise.all(
        drivers.map(
          async (driver, index) =>
            await driver.acquireLock("ns", "free", `d-${index}`, 60_000),
        ),
      );
      expect(free.filter(Boolean)).toHaveLength(1);
      expect(await first.acquireLock("ns", "lapsed", "old", 30)).toBe(true);
      await Bun.sleep(60);
      const lapsed = await Promise.all(
        drivers.map(
          async (driver, index) =>
            await driver.acquireLock("ns", "lapsed", `d-${index}`, 60_000),
        ),
      );
      expect(lapsed.filter(Boolean)).toHaveLength(1);
    }, 15_000);

    test("touch rewrites an entry's expiry and type, keeping its value and tags; and a counter's", async () => {
      const driver = make("touch");
      await driver.set("ns", entry("k", [1, 2], ["a"], Date.now() + 60_000));
      expect(await driver.touch("ns", "k", null)).toBe(true);
      const read = await driver.get("ns", "k");
      expect(read).toEqual(entry("k", [1, 2], ["a"], null));
      const object = (await raw.list({ prefix: `${driver.prefix}/` }))
        .contents![0];
      expect(
        parseContentType((await raw.stat(object.key)).type).expiresAt,
      ).toBeNull();
      await driver.increment("ns", "c", 4, null);
      const until = Date.now() + 60_000;
      expect(await driver.touch("ns", "c", until)).toBe(true);
      expect(await driver.getCounter("ns", "c")).toMatchObject({
        value: 4,
        expiresAt: until,
      });
      // Without conditional writes, touch is a plain rewrite.
      const plain = new S3CacheDriver({
        url,
        prefix: driver.prefix,
        conditionalWrites: false,
      });
      expect(await plain.touch("ns", "k", until)).toBe(true);
      expect((await plain.get("ns", "k"))?.expiresAt).toBe(until);
      expect(await plain.touch("ns", "missing", until)).toBe(false);
    });

    test("an expired entry is a miss, and its object is deleted in the background", async () => {
      const driver = make("lazy");
      await driver.set("ns", entry("k", [1], [], Date.now() - 1));
      expect(await driver.get("ns", "k")).toBeUndefined();
      const deadline = Date.now() + 5_000;
      while (
        (await raw.list({ prefix: `${driver.prefix}/` })).contents?.length
      ) {
        if (Date.now() > deadline) {
          throw new Error("the expired object was never deleted");
        }
        await Bun.sleep(20);
      }
    });

    test("a stamp only moves forward: an older invalidation landing last does not undo a newer one", async () => {
      const driver = make("stamps");
      const now = Date.now();
      await driver.setStamps("ns", ["t"], now, now + 60_000);
      await driver.setStamps("ns", ["t"], now - 500, now + 30_000);
      expect((await driver.getStamps("ns", ["t"])).get("t")).toBe(now);
      // A later one still advances it, and keeps the longer lifetime.
      await driver.setStamps("ns", ["t"], now + 5, now + 10_000);
      expect((await driver.getStamps("ns", ["t"])).get("t")).toBe(now + 5);
      const object = (await raw.list({ prefix: `${driver.prefix}/` }))
        .contents![0];
      expect(
        parseContentType((await raw.stat(object.key)).type).expiresAt,
      ).toBe(now + 60_000);
      // Concurrent writers from two instances: the latest wins whatever the order.
      const other = new S3CacheDriver({ url, prefix: driver.prefix });
      await Promise.all([
        driver.setStamps("ns", ["u"], now + 100, now + 60_000),
        other.setStamps("ns", ["u"], now + 50, now + 60_000),
        driver.setStamps("ns", ["u"], now + 10, now + 60_000),
      ]);
      expect((await driver.getStamps("ns", ["u"])).get("u")).toBe(now + 100);
    }, 15_000);

    test("clear deletes the namespace's entries and counters, and leaves its stamps and locks", async () => {
      const driver = make("clear");
      await driver.set("ns", entry("k", [1]));
      await driver.increment("ns", "c", 1, null);
      await driver.setStamps("ns", ["t"], Date.now(), Date.now() + 60_000);
      await driver.acquireLock("ns", "l", "me", 60_000);
      await driver.clear("ns");
      expect(await driver.get("ns", "k")).toBeUndefined();
      expect(await driver.getCounter("ns", "c")).toBeUndefined();
      expect((await driver.getStamps("ns", ["t"])).has("t")).toBe(true);
      expect(await driver.acquireLock("ns", "l", "other", 60_000)).toBe(false);
    });

    test("the sweeper deletes expired entries, counters, stamps and locks, and keeps live ones", async () => {
      const driver = make("sweep");
      const now = Date.now();
      await driver.set("ns", entry("dead", [1], [], now - 1));
      await driver.set("ns", entry("live", [2], [], now + 60_000));
      await driver.set("ns", entry("forever", [3]));
      await driver.increment("ns", "dead-counter", 1, now + 20);
      await driver.setStamps("ns", ["old"], now - 2_000, now - 1);
      await driver.acquireLock("ns", "old-lock", "me", 20);
      await Bun.sleep(40);
      // The two expired entries and counters are counted; the stamp and lock go too.
      expect(await driver.sweep(Date.now(), 1_000)).toBe(2);
      const names = (
        await raw.list({ prefix: `${driver.prefix}/` })
      ).contents!.map((object) => object.key);
      expect(names).toHaveLength(2);
      expect((await driver.get("ns", "live"))?.value).toEqual(
        new Uint8Array([2]),
      );
      expect((await driver.get("ns", "forever"))?.value).toEqual(
        new Uint8Array([3]),
      );
      // A limit bounds a pass.
      await driver.set("ns", entry("d1", [1], [], now - 1));
      await driver.set("ns", entry("d2", [1], [], now - 1));
      expect(await driver.sweep(Date.now(), 1)).toBe(1);
      expect(await driver.sweep(Date.now(), 1)).toBe(1);
      expect(await driver.sweep(Date.now(), 1)).toBe(0);
    });

    test("the sweeper reads an unchanged object's expiry once, not on every pass", async () => {
      const real = new S3Client(parseS3Url(url));
      let heads = 0;
      const client = new Proxy(real, {
        get(target, property) {
          if (property === "stat") {
            return async (path: string) => {
              heads++;
              return await target.stat(path);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
      const driver = new S3CacheDriver({ url, client, prefix: prefix("memo") });
      await driver.set("ns", entry("a", [1], [], Date.now() + 60_000));
      await driver.set("ns", entry("b", [1]));
      await driver.sweep(Date.now(), 1_000);
      expect(heads).toBe(2);
      await driver.sweep(Date.now(), 1_000);
      expect(heads).toBe(2);
      // A rewritten object is read again.
      await Bun.sleep(1_100); // lastModified has whole seconds
      await driver.set("ns", entry("a", [2], [], Date.now() + 60_000));
      await driver.sweep(Date.now(), 1_000);
      expect(heads).toBe(3);
    });

    test("on a store that keeps no type parameters, the sweeper reads the frame's head instead", async () => {
      const real = new S3Client(parseS3Url(url));
      const client = new Proxy(real, {
        get(target, property) {
          if (property === "stat") {
            return async (path: string) => ({
              ...(await target.stat(path)),
              type: "",
            });
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
      const driver = new S3CacheDriver({
        url,
        client,
        prefix: prefix("untyped"),
      });
      await driver.set("ns", entry("dead", [1], [], Date.now() - 1));
      await driver.set("ns", entry("live", [1], [], Date.now() + 60_000));
      expect(await driver.sweep(Date.now(), 1_000)).toBe(1);
      expect(await driver.get("ns", "live")).toBeDefined();
    });

    test("maxEntries and maxBytes evict the oldest writes first; counters are never counted or evicted", async () => {
      const capped = make("caps", { maxEntries: 2 });
      await capped.increment("ns", "counter", 1, null);
      for (const key of ["old", "mid", "new"]) {
        await capped.set("ns", entry(key, [1]));
        await Bun.sleep(5); // the write time is in ms; lastModified is not
      }
      await capped.sweep(Date.now(), 1_000);
      expect(await capped.get("ns", "old")).toBeUndefined();
      expect(await capped.get("ns", "mid")).toBeDefined();
      expect(await capped.get("ns", "new")).toBeDefined();
      expect((await capped.getCounter("ns", "counter"))?.value).toBe(1);

      const bytes = make("bytes", { maxBytes: 250 });
      for (const key of ["a", "b", "c"]) {
        await bytes.set(
          "ns",
          entry(
            key,
            Array.from({ length: 100 }, () => 7),
          ),
        );
        await Bun.sleep(5);
      }
      await bytes.sweep(Date.now(), 1_000);
      expect(await bytes.get("ns", "a")).toBeUndefined();
      expect(await bytes.get("ns", "b")).toBeDefined();
      expect(await bytes.get("ns", "c")).toBeDefined();
    });

    test("the store checks signatures, so the signed requests are proven: a wrong secret is refused", async () => {
      const wrong = url.replace(
        /^s3:\/\/([^:]+):[^@]+@/,
        "s3://$1:not-the-secret@",
      );
      const driver = new S3CacheDriver({ url: wrong, prefix: prefix("wrong") });
      await expect(driver.acquireLock("ns", "k", "me", 1_000)).rejects.toThrow(
        /403|SignatureDoesNotMatch|AccessDenied/,
      );
    });

    test("a cache on the driver: tags invalidate through the stamps, counters count", async () => {
      const cache = createCache({ driver: make("cache"), namespace: "app" });
      await cache.set("user:1", { name: "a" }, { tags: ["users"] });
      expect(await cache.get("user:1")).toEqual({ name: "a" });
      await cache.invalidateTags(["users"]);
      expect(await cache.get("user:1")).toBeUndefined();
      expect(await cache.increment("hits")).toBe(1);
      expect(await cache.increment("hits", 4)).toBe(5);
      await cache.close();
    });
  });
}
