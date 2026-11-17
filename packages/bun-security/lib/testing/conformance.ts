/**
 * `runSecurityStoreConformance` (storage.md §9): the contract every security
 * store keeps, as a `bun:test` suite. A driver runs it in its own tests:
 *
 * ```ts
 * import { runSecurityStoreConformance } from "@kingsleyweb/bun-security/testing";
 *
 * await runSecurityStoreConformance("my-store", async () => {
 *   const store = myStore({ ... });
 *   return { store, cleanup: () => removeMyData() };
 * });
 * ```
 *
 * The factory is called once per case, so each case starts on an empty
 * store, and once more before the suite registers, for the capabilities the
 * cases are gated on (a case a capability does not cover is reported as
 * skipped, by name). Await the call at the test file's top level.
 *
 * What it checks: documents with revisions (a write naming a stale revision
 * is refused with the document as it is, two racing writers never both
 * win); policy versions (the head moves by compare-and-set, numbers have no
 * holes, racing publishers never fork the head); the change feed (every
 * write and only writes, in order, complete, pushed where the driver
 * pushes); pages (empty, last, stable under concurrent inserts, cursors
 * bound to their walk); refused input; the schema's baseline (a fresh one
 * has no drift); and, for a `multiProcess` driver, the same races from two
 * processes.
 */
import type { SecurityStoreDriver, StoredDoc } from "../store/types";
import process from "node:process";
import { describe, expect, test } from "bun:test";
import { raceStore } from "./race";

/** What the factory answers. */
export interface StoreConformanceInstance {
  /** The store under test, empty. */
  readonly store: SecurityStoreDriver;
  /** Run after the case, once the store is closed: removes its data. */
  readonly cleanup?: () => unknown;
}

/** The store's factory: called once per case. */
export type StoreConformanceFactory = () =>
  StoreConformanceInstance | Promise<StoreConformanceInstance>;

/** How the two-process pass builds the same store in a child process. */
export interface StoreConformanceCrossProcess {
  /** The absolute path of the module the factory lives in. */
  readonly module: string;
  /** The factory's export; default `"default"`. */
  readonly export?: string;
  /**
   * What the child's factory is called with: it must open the same store
   * the parent's factory opened for the case. Called per case with the
   * parent's store, so it can name the case's file or prefix.
   */
  readonly options: (store: SecurityStoreDriver) => unknown;
}

/** `runSecurityStoreConformance`'s options. */
export interface StoreConformanceOptions {
  /**
   * How the two-process pass builds the store in a child. Required when the
   * driver advertises `multiProcess`: a claim without it fails the pass
   * rather than skipping it.
   */
  readonly crossProcess?: StoreConformanceCrossProcess;
  /** The races' size: writes and appends each side wins. Default 20. */
  readonly raceSize?: number;
}

/** How long a case that starts a second process may take, ms. */
const CROSS_PROCESS_TIMEOUT_MS = 30_000;

/** Runs `body` on a fresh store from `factory`, closing and cleaning up after. */
async function withStore(
  factory: StoreConformanceFactory,
  body: (store: SecurityStoreDriver) => Promise<void>,
): Promise<void> {
  const { store, cleanup } = await factory();
  try {
    await store.connect();
    await body(store);
  } finally {
    await store.close();
    await cleanup?.();
  }
}

/** Whether `promise` rejects. */
async function rejects(promise: () => Promise<unknown>): Promise<boolean> {
  try {
    await promise();
    return false;
  } catch {
    return true;
  }
}

/** Every item of a document walk, page by page. */
async function walk(
  store: SecurityStoreDriver,
  query: Parameters<SecurityStoreDriver["list"]>[1],
  between?: () => Promise<void>,
): Promise<StoredDoc[]> {
  const seen: StoredDoc[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 1_000; pages++) {
    const page = await store.list("service", { ...query, cursor });
    seen.push(...page.items);
    if (page.next === undefined) return seen;
    cursor = page.next;
    await between?.();
  }
  throw new Error("the walk never ended");
}

/** Spawns the worker for one side of the two-process race; resolves once it is ready. */
async function startWorker(job: Record<string, unknown>): Promise<{
  go: () => void;
  result: Promise<{ revisions: number[]; versions: string[] }>;
}> {
  const worker = new URL("./crossprocess-worker.ts", import.meta.url).pathname;
  const child = Bun.spawn({
    cmd: [process.execPath, worker, JSON.stringify(job)],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const nextLine = async (): Promise<string | undefined> => {
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        return line;
      }
      const { done, value } = await reader.read();
      if (done) {
        const rest = buffered;
        buffered = "";
        return rest === "" ? undefined : rest;
      }
      buffered += decoder.decode(value, { stream: true });
    }
  };
  const failed = async (): Promise<never> => {
    void child.stdin.end();
    const code = await child.exited;
    throw new Error(
      `the cross-process worker exited ${code}: ${(await stderr).trim()}`,
    );
  };
  const ready = await nextLine();
  if (
    ready === undefined ||
    (JSON.parse(ready) as { ready?: unknown }).ready !== true
  ) {
    return await failed();
  }
  return {
    go: () => {
      void child.stdin.end();
    },
    result: (async () => {
      const line = await nextLine();
      const code = await child.exited;
      if (code !== 0 || line === undefined) return await failed();
      return JSON.parse(line) as { revisions: number[]; versions: string[] };
    })(),
  };
}

/** The security store kit; see the module's description. */
export async function runSecurityStoreConformance(
  name: string,
  factory: StoreConformanceFactory,
  options: StoreConformanceOptions = {},
): Promise<void> {
  const probe = await factory();
  const { capabilities } = probe.store;
  const hasSync = probe.store.syncSchema !== undefined;
  const hasSubscribe = probe.store.subscribe !== undefined;
  await probe.store.close();
  await probe.cleanup?.();
  const raceSize = options.raceSize ?? 20;
  /** A case gated on `when`: skipped, by name, when it does not hold. */
  const gated = (when: boolean) => (when ? test : test.skip);

  describe(`security store conformance: ${name}`, () => {
    test("advertises its capabilities, and refuses writes only when read-only", () => {
      for (const flag of [
        "durable",
        "multiProcess",
        "multiHost",
        "transactions",
        "analytics",
        "cidrQuery",
        "readOnly",
      ] as const) {
        expect(typeof capabilities[flag]).toBe("boolean");
      }
      expect(["push", "poll"]).toContain(capabilities.changeFeed);
      if (capabilities.changeFeed === "push") expect(hasSubscribe).toBe(true);
    });

    test("connect and close are idempotent", async () => {
      const { store, cleanup } = await factory();
      await store.connect();
      await store.connect();
      await store.close();
      await store.close();
      await cleanup?.();
    });

    if (capabilities.readOnly) {
      test("refuses every write", async () => {
        await withStore(factory, async (store) => {
          expect(await rejects(() => store.put("service", "a", {}, null))).toBe(
            true,
          );
          expect(await rejects(() => store.delete("service", "a", 1))).toBe(
            true,
          );
          expect(
            await rejects(() =>
              store.appendVersion("p", { id: "v", policy: {} }, null),
            ),
          ).toBe(true);
          expect(
            await rejects(() =>
              store.putBundle("s", { version: 1, bundle: {} }, null),
            ),
          ).toBe(true);
        });
      });
      return;
    }

    describe("documents and revisions", () => {
      test("create, read, update, delete, each by the revision it read", async () => {
        await withStore(factory, async (store) => {
          expect(await store.get("service", "a")).toBeUndefined();
          const created = await store.put("service", "a", { n: 1 }, null);
          expect(created).toMatchObject({ ok: true, revision: 1 });
          const read = await store.get("service", "a");
          expect(read).toMatchObject({
            kind: "service",
            id: "a",
            revision: 1,
            doc: { n: 1 },
          });
          expect(typeof read?.updatedAt).toBe("number");
          expect(await store.put("service", "a", { n: 2 }, 1)).toMatchObject({
            ok: true,
            revision: 2,
          });
          // A stale revision, and a create over an existing one: refused, with the document as it is.
          const stale = await store.put("service", "a", { n: 9 }, 1);
          expect(stale.ok).toBe(false);
          expect(!stale.ok && stale.conflict).toMatchObject({
            revision: 2,
            doc: { n: 2 },
          });
          const again = await store.put("service", "a", { n: 9 }, null);
          expect(!again.ok && again.conflict?.revision).toBe(2);
          // An update of a missing document: refused, with nothing.
          const missing = await store.put("service", "b", {}, 3);
          expect(missing).toEqual({ ok: false, conflict: undefined });
          expect(await store.delete("service", "a", 1)).toBe(false);
          expect(await store.delete("service", "a", 2)).toBe(true);
          expect(await store.get("service", "a")).toBeUndefined();
          expect(await store.delete("service", "a", 2)).toBe(false);
        });
      });

      test("kinds are apart, and a body round-trips as JSON", async () => {
        await withStore(factory, async (store) => {
          await store.put("service", "x", { kind: "service" }, null);
          await store.put("group", "x", { kind: "group" }, null);
          expect((await store.get("group", "x"))?.doc).toEqual({
            kind: "group",
          });
          const body = {
            a: [1, "two", null, { b: true }],
            c: "é ✓",
            d: undefined,
            e: 1.5,
          };
          await store.put("operator", "u", body, null);
          expect((await store.get("operator", "u"))?.doc).toEqual({
            a: [1, "two", null, { b: true }],
            c: "é ✓",
            e: 1.5,
          });
          for (const [id, value] of [
            ["s", "text"],
            ["n", 42],
            ["z", null],
            ["l", [1]],
          ] as const) {
            await store.put("approval", id, value, null);
            expect((await store.get("approval", id))?.doc).toEqual(value);
          }
          // A read is a copy: changing it changes nothing stored.
          const doc = (await store.get("operator", "u"))!.doc as {
            a: unknown[];
          };
          doc.a.push("mutated");
          expect(
            ((await store.get("operator", "u"))!.doc as { a: unknown[] }).a,
          ).toHaveLength(4);
        });
      });

      test("refuses a policy head written by hand, and malformed input", async () => {
        await withStore(factory, async (store) => {
          expect(await rejects(() => store.put("policy", "p", {}, null))).toBe(
            true,
          );
          expect(await rejects(() => store.delete("policy", "p", 1))).toBe(
            true,
          );
          expect(await rejects(() => store.get("nope" as never, "a"))).toBe(
            true,
          );
          expect(await rejects(() => store.get("service", ""))).toBe(true);
          expect(
            await rejects(() => store.get("service", "x".repeat(201))),
          ).toBe(true);
          expect(await rejects(() => store.put("service", "a", {}, 0))).toBe(
            true,
          );
          expect(await rejects(() => store.put("service", "a", 1n, null))).toBe(
            true,
          );
          expect(await rejects(() => store.list("service", { limit: 0 }))).toBe(
            true,
          );
          expect(
            await rejects(() => store.list("service", { limit: 1_001 })),
          ).toBe(true);
          expect(
            await rejects(() =>
              store.list("service", { limit: 1, sort: "name" as never }),
            ),
          ).toBe(true);
        });
      });

      test(`two racing writers never both win (${raceSize} rounds)`, async () => {
        await withStore(factory, async (store) => {
          await store.put("service", "race", { n: 0 }, null);
          for (let round = 1; round <= raceSize; round++) {
            const results = await Promise.all(
              Array.from(
                { length: 4 },
                async (_, side) =>
                  await store.put("service", "race", { side }, round),
              ),
            );
            expect(results.filter((result) => result.ok)).toHaveLength(1);
          }
          expect((await store.get("service", "race"))?.revision).toBe(
            raceSize + 1,
          );
          const creates = await Promise.all(
            Array.from(
              { length: 4 },
              async (_, side) =>
                await store.put("service", "fresh", { side }, null),
            ),
          );
          expect(creates.filter((result) => result.ok)).toHaveLength(1);
        });
      });
    });

    describe("pages", () => {
      test("an empty kind is one empty page with no next", async () => {
        await withStore(factory, async (store) => {
          const page = await store.list("service", { limit: 10 });
          expect(page.items).toEqual([]);
          expect(page.next).toBeUndefined();
        });
      });

      for (const sort of ["id", "updatedAt"] as const) {
        for (const direction of ["asc", "desc"] as const) {
          test(`walks every document once, by ${sort} ${direction}, the last page without a next`, async () => {
            await withStore(factory, async (store) => {
              const ids = Array.from(
                { length: 23 },
                (_, at) => `s${String(at).padStart(2, "0")}`,
              );
              for (const id of [...ids].reverse()) {
                await store.put("service", id, { id }, null);
              }
              await store.put("group", "s99", {}, null);
              const seen = await walk(store, { limit: 5, sort, direction });
              expect(seen.map((doc) => doc.id).sort()).toEqual(ids);
              const keys = seen.map(
                (doc) =>
                  [sort === "id" ? doc.id : doc.updatedAt, doc.id] as const,
              );
              const ordered = [...keys].sort((a, b) =>
                a[0] < b[0]
                  ? -1
                  : a[0] > b[0]
                    ? 1
                    : a[1] < b[1]
                      ? -1
                      : a[1] > b[1]
                        ? 1
                        : 0,
              );
              if (direction === "desc") ordered.reverse();
              expect(keys).toEqual(ordered);
              const exact = await store.list("service", {
                limit: 23,
                sort,
                direction,
              });
              expect(exact.items).toHaveLength(23);
              expect(exact.next).toBeUndefined();
            });
          });
        }
      }

      test("a prefix narrows the walk", async () => {
        await withStore(factory, async (store) => {
          for (const id of ["a1", "a2", "b1", "a3", "ab"]) {
            await store.put("service", id, {}, null);
          }
          const seen = await walk(store, { limit: 2, prefix: "a" });
          expect(seen.map((doc) => doc.id)).toEqual(["a1", "a2", "a3", "ab"]);
        });
      });

      test("stays exact while documents arrive between pages", async () => {
        await withStore(factory, async (store) => {
          const ids = Array.from(
            { length: 20 },
            (_, at) => `m${String(at * 2).padStart(3, "0")}`,
          );
          for (const id of ids) await store.put("service", id, {}, null);
          let added = 0;
          const seen = await walk(store, { limit: 4 }, async () => {
            added += 1;
            // Before the walk's position and after it.
            await store.put("service", `a${added}`, {}, null);
            await store.put("service", `z${added}`, {}, null);
          });
          const walked = seen.map((doc) => doc.id);
          expect(new Set(walked).size).toBe(walked.length);
          for (const id of ids) expect(walked).toContain(id);
          expect(walked.filter((id) => id.startsWith("a"))).toEqual([]);
        });
      });

      test("a cursor is bound to its walk: another sort, direction, prefix or kind refuses it", async () => {
        await withStore(factory, async (store) => {
          for (let at = 0; at < 4; at++)
            await store.put("service", `c${at}`, {}, null);
          const { next } = await store.list("service", { limit: 2 });
          expect(next).toBeDefined();
          expect(
            (await store.list("service", { limit: 2, cursor: next })).items,
          ).toHaveLength(2);
          for (const query of [
            { sort: "updatedAt" as const },
            { direction: "desc" as const },
            { prefix: "c" },
          ]) {
            expect(
              await rejects(() =>
                store.list("service", { limit: 2, cursor: next, ...query }),
              ),
            ).toBe(true);
          }
          expect(
            await rejects(() =>
              store.list("group", { limit: 2, cursor: next }),
            ),
          ).toBe(true);
          expect(
            await rejects(() =>
              store.list("service", { limit: 2, cursor: "garbage" }),
            ),
          ).toBe(true);
        });
      });
    });

    describe("policy versions", () => {
      test("append moves the head by compare-and-set, numbered without holes", async () => {
        await withStore(factory, async (store) => {
          expect(await store.get("policy", "p")).toBeUndefined();
          expect(
            await store.appendVersion(
              "p",
              {
                id: "v1",
                policy: { mode: "dryRun" },
                createdBy: "ann",
                message: "first",
              },
              null,
            ),
          ).toMatchObject({ ok: true });
          expect((await store.get("policy", "p"))?.doc).toEqual({
            head: "v1",
            number: 1,
          });
          // A stale head, a head on a fresh policy, and a reused id: refused, with the head as it is.
          expect(
            await store.appendVersion("p", { id: "v2", policy: {} }, null),
          ).toEqual({ ok: false, head: "v1" });
          expect(
            await store.appendVersion("p", { id: "v2", policy: {} }, "v0"),
          ).toEqual({ ok: false, head: "v1" });
          expect(
            await store.appendVersion("p", { id: "v1", policy: {} }, "v1"),
          ).toEqual({ ok: false, head: "v1" });
          expect(
            await store.appendVersion("q", { id: "v1", policy: {} }, "v1"),
          ).toEqual({ ok: false, head: null });
          expect(
            await store.appendVersion(
              "p",
              {
                id: "v2",
                policy: { mode: "enforce" },
                createdAt: 1_790_000_000_000,
              },
              "v1",
            ),
          ).toMatchObject({ ok: true });
          expect(await store.get("policy", "p")).toMatchObject({
            revision: 2,
            doc: { head: "v2", number: 2 },
          });
          expect(await store.getVersion("p", "v1")).toMatchObject({
            policyId: "p",
            id: "v1",
            number: 1,
            policy: { mode: "dryRun" },
            createdBy: "ann",
            message: "first",
          });
          expect(await store.getVersion("p", "v2")).toMatchObject({
            number: 2,
            createdAt: 1_790_000_000_000,
            createdBy: undefined,
          });
          expect(await store.getVersion("p", "v9")).toBeUndefined();
          expect(await store.getVersion("q", "v1")).toBeUndefined();
        });
      });

      test("lists versions by number, newest first on desc, page by page", async () => {
        await withStore(factory, async (store) => {
          let head: string | null = null;
          for (let at = 1; at <= 7; at++) {
            expect(
              (
                await store.appendVersion(
                  "p",
                  { id: `v${at}`, policy: { at } },
                  head,
                )
              ).ok,
            ).toBe(true);
            head = `v${at}`;
          }
          for (const direction of ["asc", "desc"] as const) {
            const numbers: number[] = [];
            let cursor: string | undefined;
            for (;;) {
              const page = await store.listVersions("p", {
                limit: 3,
                direction,
                cursor,
              });
              numbers.push(...page.items.map((v) => v.number));
              if (page.next === undefined) break;
              cursor = page.next;
            }
            const expected = [1, 2, 3, 4, 5, 6, 7];
            expect(numbers).toEqual(
              direction === "asc" ? expected : expected.reverse(),
            );
          }
          const first = await store.listVersions("p", { limit: 3 });
          expect(
            await rejects(() =>
              store.listVersions("q", { limit: 3, cursor: first.next }),
            ),
          ).toBe(true);
          expect(
            (await store.listVersions("none", { limit: 3 })).items,
          ).toEqual([]);
        });
      });

      test(`racing publishers never fork the head (${raceSize} rounds)`, async () => {
        await withStore(factory, async (store) => {
          await store.appendVersion("p", { id: "v0", policy: {} }, null);
          let head = "v0";
          for (let round = 1; round <= raceSize; round++) {
            const results = await Promise.all(
              Array.from(
                { length: 4 },
                async (_, side) =>
                  await store.appendVersion(
                    "p",
                    { id: `r${round}-${side}`, policy: { side } },
                    head,
                  ),
              ),
            );
            const winners = results.filter((result) => result.ok);
            expect(winners).toHaveLength(1);
            head = ((await store.get("policy", "p"))!.doc as { head: string })
              .head;
          }
          const all = await store.listVersions("p", { limit: 1_000 });
          expect(all.items.map((v) => v.number)).toEqual(
            Array.from({ length: raceSize + 1 }, (_, at) => at + 1),
          );
        });
      });
    });

    describe("signed bundles (storage.md §3.1)", () => {
      test("stored by compare-and-set on the version, each higher than the last", async () => {
        await withStore(factory, async (store) => {
          expect(await store.getBundle("svc")).toBeUndefined();
          expect(
            await store.putBundle(
              "svc",
              { version: 1, bundle: { v: 1 } },
              null,
            ),
          ).toMatchObject({ ok: true });
          // A stale expected version, a fresh service's null, and a version
          // no higher than the stored one: refused, with the stored version.
          expect(
            await store.putBundle("svc", { version: 2, bundle: {} }, null),
          ).toEqual({ ok: false, version: 1 });
          expect(
            await store.putBundle("svc", { version: 3, bundle: {} }, 2),
          ).toEqual({ ok: false, version: 1 });
          expect(
            await store.putBundle("svc", { version: 1, bundle: {} }, 1),
          ).toEqual({ ok: false, version: 1 });
          expect(
            await store.putBundle("svc", { version: 5, bundle: { v: 5 } }, 1),
          ).toMatchObject({ ok: true });
          expect(await store.getBundle("svc")).toMatchObject({
            serviceId: "svc",
            version: 5,
            etag: '"5"',
            bundle: { v: 5 },
          });
          // Services are apart.
          expect(await store.getBundle("other")).toBeUndefined();
          expect(
            await rejects(() =>
              store.putBundle("svc", { version: 0, bundle: {} }, 5),
            ),
          ).toBe(true);
          expect(
            await rejects(() =>
              store.putBundle("svc", { version: 6, bundle: undefined }, 5),
            ),
          ).toBe(true);
        });
      });

      test("a conditional read answers not-modified for its own entity tag", async () => {
        await withStore(factory, async (store) => {
          await store.putBundle("svc", { version: 7, bundle: { a: 1 } }, null);
          expect(await store.getBundle("svc", '"7"')).toBe("not-modified");
          expect(await store.getBundle("svc", '"6"')).toMatchObject({
            version: 7,
          });
          expect(await store.getBundle("none", '"7"')).toBeUndefined();
        });
      });

      test(`racing compilers never both win (${raceSize} rounds)`, async () => {
        await withStore(factory, async (store) => {
          let version: number | null = null;
          for (let round = 1; round <= raceSize; round++) {
            const results = await Promise.all(
              Array.from(
                { length: 4 },
                async (_, side) =>
                  await store.putBundle(
                    "race",
                    { version: round * 10 + side, bundle: { side } },
                    version,
                  ),
              ),
            );
            expect(results.filter((result) => result.ok)).toHaveLength(1);
            const stored = await store.getBundle("race");
            version =
              stored === undefined || stored === "not-modified"
                ? null
                : stored.version;
          }
        });
      });
    });

    describe("the change feed", () => {
      test("every write, and only writes, in order and complete", async () => {
        await withStore(factory, async (store) => {
          const start = (await store.changesSince(0n, 1)).head;
          await store.put("service", "a", {}, null);
          await store.put("service", "a", {}, 1);
          await store.put("service", "a", {}, 1); // refused: no change
          await store.delete("service", "a", 9); // refused: no change
          await store.appendVersion("p", { id: "v1", policy: {} }, null);
          await store.appendVersion("p", { id: "v2", policy: {} }, "v0"); // refused
          await store.putBundle("s", { version: 3, bundle: {} }, null);
          await store.putBundle("s", { version: 4, bundle: {} }, null); // refused
          await store.delete("service", "a", 2);
          const { changes, head } = await store.changesSince(start, 100);
          expect(
            changes.map((c) => [c.kind, c.id, c.revision, c.deleted]),
          ).toEqual([
            ["service", "a", 1, false],
            ["service", "a", 2, false],
            ["policy", "p", 1, false],
            ["bundle", "s", 3, false],
            ["service", "a", 2, true],
          ]);
          const seqs = changes.map((c) => c.seq);
          expect(seqs.every((seq, at) => at === 0 || seq > seqs[at - 1]!)).toBe(
            true,
          );
          expect(head).toBe(seqs.at(-1)!);
          // Paged by limit, it is the same feed.
          const first = await store.changesSince(start, 2);
          expect(first.changes).toEqual(changes.slice(0, 2));
          expect(
            (await store.changesSince(first.changes[1]!.seq, 10)).changes,
          ).toEqual(changes.slice(2));
          expect((await store.changesSince(head, 10)).changes).toEqual([]);
          expect(await rejects(() => store.changesSince(-1n, 10))).toBe(true);
          expect(await rejects(() => store.changesSince(0n, 0))).toBe(true);
        });
      });

      gated(capabilities.changeFeed === "push")(
        "pushes the head after a write",
        async () => {
          await withStore(factory, async (store) => {
            const heard: bigint[] = [];
            const stop = store.subscribe!(
              (head) => heard.push(head),
              () => undefined,
            );
            const written = await store.put("service", "a", {}, null);
            for (let at = 0; at < 100 && heard.length === 0; at++)
              await Bun.sleep(10);
            stop();
            expect(heard.length).toBeGreaterThan(0);
            expect(heard.at(-1)!).toBeGreaterThanOrEqual(
              written.ok ? written.seq : 0n,
            );
          });
        },
      );
    });

    gated(hasSync)(
      "syncSchema: a fresh schema has no drift, dry run or not",
      async () => {
        await withStore(factory, async (store) => {
          expect(await store.syncSchema!({ dryRun: true })).toEqual([]);
          expect(await store.syncSchema!()).toEqual([]);
        });
      },
    );

    if (capabilities.multiProcess) {
      test(
        "two processes racing the same document and head: no lost write, no fork",
        async () => {
          const harness = options.crossProcess;
          if (harness === undefined) {
            throw new Error(
              `${name} advertises multiProcess but the kit was given no crossProcess harness, so the claim is untested`,
            );
          }
          await withStore(factory, async (store) => {
            const job = { docId: "xp", policyId: "xp", count: raceSize };
            const worker = await startWorker({
              module: harness.module,
              export: harness.export,
              options: harness.options(store),
              ...job,
              side: "child",
            });
            worker.go();
            const [mine, theirs] = await Promise.all([
              raceStore(store, { ...job, side: "parent" }),
              worker.result,
            ]);
            const revisions = [...mine.revisions, ...theirs.revisions].sort(
              (a, b) => a - b,
            );
            expect(revisions).toEqual(
              Array.from({ length: 2 * raceSize }, (_, at) => at + 1),
            );
            const versions = await store.listVersions("xp", { limit: 1_000 });
            expect(versions.items.map((v) => v.number)).toEqual(
              Array.from({ length: 2 * raceSize }, (_, at) => at + 1),
            );
            expect(versions.items.map((v) => v.id).sort()).toEqual(
              [...mine.versions, ...theirs.versions].sort(),
            );
            const { changes } = await store.changesSince(0n, 1_000);
            expect(
              changes.filter((c) => c.kind === "service" && c.id === "xp"),
            ).toHaveLength(2 * raceSize);
          });
        },
        CROSS_PROCESS_TIMEOUT_MS,
      );
    }
  });
}
