/**
 * User ciphers (the encryption plan's §6): the conformance kit on a sync and
 * an async test cipher, its negative controls (a cipher that ignores the AAD,
 * one that reuses its nonce — each must fail the kit, run in a child
 * `bun test`), and user ciphers inside a cache: `previous`, an unknown
 * cipher id, a cipher that throws on open, the built-in's entries in a user
 * cipher's cache.
 */
import { describe, expect, test } from "bun:test";
import process from "node:process";
import { runCacheCipherConformance } from "../../lib/testing/index";
import {
  decryptErrors,
  KEY_A,
  SENTINEL,
  setup,
  testCipher,
} from "../core/encryptionHelpers";

runCacheCipherConformance("test AES-256-GCM, sync", testCipher({ id: 200 }));
runCacheCipherConformance(
  "test AES-256-GCM, async",
  testCipher({ id: 201, async: true }),
);

/** Runs the fixture under `kind` in a child `bun test`; answers its exit code and output. */
async function runFixture(
  kind: string,
): Promise<{ code: number; output: string }> {
  const fixture = new URL(
    "./fixtures/cipher-conformance-fixture.ts",
    import.meta.url,
  ).pathname;
  const child = Bun.spawn([process.execPath, "test", fixture], {
    env: { ...process.env, BUN_CACHE_CIPHER_FIXTURE: kind },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: stdout + stderr };
}

describe("the kit's negative controls", () => {
  test("a cipher that ignores the AAD fails it, on the aad, namespace and key cases only", async () => {
    const { code, output } = await runFixture("ignore-aad");
    expect(code).not.toBe(0);
    expect(output).toContain(
      "(fail) cache cipher conformance: ignores the aad > a changed aad is refused",
    );
    expect(output).toContain(
      "(fail) cache cipher conformance: ignores the aad > a changed namespace is refused",
    );
    expect(output).toContain(
      "(fail) cache cipher conformance: ignores the aad > a changed key is refused",
    );
    expect(output).toMatch(/\b3 fail\b/);
  }, 30_000);

  test("a cipher that reuses its nonce fails it, on the two-seals case only", async () => {
    const { code, output } = await runFixture("fixed-nonce");
    expect(code).not.toBe(0);
    expect(output).toContain(
      "(fail) cache cipher conformance: reuses its nonce > two seals of one input differ",
    );
    expect(output).toMatch(/\b1 fail\b/);
  }, 30_000);
});

describe("user ciphers in a cache", () => {
  test("previous: entries sealed by an earlier cipher read after cipher moves on; without it they miss (cipher)", async () => {
    const v1 = testCipher({ id: 130 });
    const v2 = testCipher({
      id: 131,
      async: true,
      key: new Uint8Array(32).fill(9),
    });
    const old = setup({ encrypt: { cipher: v1 } });
    await old.cache.set("k", SENTINEL);
    const shared = { driver: old.driver, clock: old.clock };
    const moved = setup({ encrypt: { cipher: v2, previous: [v1] } }, shared);
    expect(await moved.cache.get("k")).toBe(SENTINEL);
    await moved.cache.set("new", 1);
    expect((await old.driver.get("cache", "new"))!.value[3]).toBe(131);
    const forgot = setup({ encrypt: { cipher: v2 } }, shared);
    expect(await forgot.cache.get("k")).toBeUndefined();
    expect(decryptErrors(forgot.errors).map((error) => error.reason)).toEqual([
      "cipher",
    ]);
    expect(await old.driver.get("cache", "k")).toBeDefined();
  });

  test("the built-in reads a previous user cipher's entries, beside its keys", async () => {
    const v1 = testCipher({ id: 140 });
    const old = setup({ encrypt: { cipher: v1 } });
    await old.cache.set("k", SENTINEL);
    const builtIn = setup(
      { encrypt: { keys: [{ id: "a", key: KEY_A }], previous: [v1] } },
      { driver: old.driver, clock: old.clock },
    );
    expect(await builtIn.cache.get("k")).toBe(SENTINEL);
  });

  test("the built-in's entries in a user cipher's cache are misses (cipher)", async () => {
    const builtIn = setup({ encrypt: { keys: [{ id: "a", key: KEY_A }] } });
    await builtIn.cache.set("k", 1);
    const user = setup(
      { encrypt: { cipher: testCipher() } },
      { driver: builtIn.driver, clock: builtIn.clock },
    );
    expect(await user.cache.get("k")).toBeUndefined();
    expect(decryptErrors(user.errors).map((error) => error.reason)).toEqual([
      "cipher",
    ]);
  });

  test("a cipher that throws on open, sync or async: a miss (cipher) with its error as the cause", async () => {
    for (const async of [false, true]) {
      const inner = testCipher({ async });
      const failing = {
        ...inner,
        open: async
          ? async () => {
              await Promise.resolve();
              throw new Error("HSM said no");
            }
          : () => {
              throw new Error("HSM said no");
            },
      };
      const writer = setup({ encrypt: { cipher: inner } });
      await writer.cache.set("k", 1);
      const reader = setup(
        { encrypt: { cipher: failing } },
        { driver: writer.driver, clock: writer.clock },
      );
      expect(await reader.cache.get("k")).toBeUndefined();
      const [error] = decryptErrors(reader.errors);
      expect(error.reason).toBe("cipher");
      expect((error.cause as Error).message).toBe("HSM said no");
    }
  });

  test("a cipher whose open answers something other than bytes: a miss (cipher)", async () => {
    const inner = testCipher();
    const writer = setup({ encrypt: { cipher: inner } });
    await writer.cache.set("k", 1);
    const reader = setup(
      {
        encrypt: {
          cipher: { ...inner, open: () => "nope" as unknown as Uint8Array },
        },
      },
      { driver: writer.driver, clock: writer.clock },
    );
    expect(await reader.cache.get("k")).toBeUndefined();
    expect(decryptErrors(reader.errors).map((error) => error.reason)).toEqual([
      "cipher",
    ]);
  });
});
