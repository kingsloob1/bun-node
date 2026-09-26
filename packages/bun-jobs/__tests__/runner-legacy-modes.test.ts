import type { SQL } from "bun";
import type {
  DriverConfig,
  ExecutionMode,
  JobsDriver,
  RunRecord,
} from "../lib/index";
import type { Backend } from "./helpers/backends";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import {
  toRunnerConfigDto,
  toRunnerInfoDto,
  toRunRecordDto,
} from "../lib/api/serialize";
import {
  BunJobs,
  BunRunner,
  ConfigError,
  createDriver,
  MemoryDriver,
  RUNNER_CONFIG_STATE,
  runnerKey,
  SQL_TABLES,
} from "../lib/index";
import {
  LEGACY_EXECUTION_MODES,
  legacyExecutionModeHint,
  normalizeExecutionMode,
  readStoredRunnerConfig,
} from "../lib/runner/config";
import { takeBooleanParam } from "../lib/shared/connection";
import { harness } from "./api/fixtures";
import { makeTmpDir, testNamespace } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * Old execution-mode spellings in a store, read through the new code (Phase
 * 1r, D1).
 *
 * Runners called two modes `"spawn"` and `"worker"` before 1r. Nothing
 * rewrites what a store already holds — a run record's `mode`, the owner's
 * `executionMode`, `config:code`, `config:allowed` and a
 * `config:executionMode` override — so every read above the driver translates
 * it, permanently. This suite is the proof, on every backend:
 *
 * 1. the old shape is written twice, once through the driver's own write
 *    primitives (`setState`, `appendHistory`, `updateHistory`, exactly as a
 *    pre-1r runner wrote it) and once **raw**, past the driver's write path —
 *    SQL `UPDATE` of the JSON, Redis `HSET`/`LPUSH`, Mongo `updateOne`, a
 *    hand-written `state.json` — because a translation that works on memory
 *    can fail on a backend that stores the raw string;
 * 2. a **negative control** reads it back through the driver and finds the
 *    old spelling, so the fixture provably wrote one;
 * 3. `RunnerController` and the management API (with `validateResponses`)
 *    then return only the new spellings, and nothing else anywhere in their
 *    answers is `"spawn"` or `"worker"`;
 * 4. an owner started on that state adopts the old `"worker"` override as
 *    `worker-thread` and runs in it.
 *
 * The driver layer must keep *accepting* old-spelled writes: the examples
 * seed old data through it, and so does case 1 here.
 */

/** A run record whose `mode` may be an old spelling, as a pre-1r runner wrote it. */
type StoredRunRecord = Omit<RunRecord, "mode"> & { mode: string };

/** The old spellings, which no answer above the driver may contain. */
const OLD = new Set(Object.keys(LEGACY_EXECUTION_MODES));

/** Every string in `value` that is an old spelling, with where it was found. */
function oldSpellings(value: unknown, path = "$"): string[] {
  if (typeof value === "string") {
    return OLD.has(value) ? [`${path} = ${JSON.stringify(value)}`] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      oldSpellings(item, `${path}[${index}]`),
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) =>
      oldSpellings(item, `${path}.${key}`),
    );
  }
  return [];
}

/** A settled run record in the old shape. */
function oldRecord(
  id: string,
  runId: string,
  mode: string,
  startedAt: number,
): StoredRunRecord {
  return {
    runId,
    runnerId: id,
    attempt: 1,
    source: "manual",
    mode,
    host: "pre-1r-host",
    pid: 4242,
    startedAt,
    finishedAt: startedAt + 5,
    durationMs: 5,
    status: "success",
    result: "ok",
  };
}

/** The state fields a pre-1r owner and controller left behind. */
function oldFields(
  id: string,
  allowed: readonly string[] = ["spawn", "worker", "in-process"],
): Record<string, string> {
  return {
    name: id,
    paused: "0",
    executionMode: "spawn",
    runMode: "single",
    maxConcurrency: "Infinity",
    [RUNNER_CONFIG_STATE.code]: JSON.stringify({
      executionMode: "worker",
      runMode: "single",
      maxConcurrency: null,
    }),
    [RUNNER_CONFIG_STATE.allowed]: JSON.stringify(allowed),
    [RUNNER_CONFIG_STATE.executionMode]: "worker",
    updatedAt: String(Date.now()),
  };
}

/** The history a pre-1r runner left: one `"spawn"` run, then a `"worker"` one. */
function oldHistory(id: string): StoredRunRecord[] {
  const now = Date.now();
  // Newest first, as every driver hands it back.
  return [
    oldRecord(id, `${id}-run-2`, "worker", now - 1_000),
    oldRecord(id, `${id}-run-1`, "spawn", now - 2_000),
  ];
}

/**
 * Writes the old shape through the driver's own primitives, the calls a pre-1r
 * runner made: `setState` for the fields, then each run appended as
 * `"running"` and settled by `updateHistory` with the whole record.
 */
async function seedThroughDriver(
  driver: JobsDriver,
  ns: string,
  id: string,
  fields: Record<string, string>,
): Promise<void> {
  const key = runnerKey(id);
  await driver.setState(ns, key, fields);
  for (const record of oldHistory(id).reverse()) {
    const { finishedAt: _f, durationMs: _d, result: _r, ...running } = record;
    await driver.appendHistory(
      ns,
      key,
      { ...running, status: "running" } as unknown as RunRecord,
      50,
    );
    await driver.updateHistory(
      ns,
      key,
      record.runId,
      record as unknown as RunRecord,
    );
  }
}

/** Writes a runner's whole stored state past the driver's write path. */
interface RawWriter {
  /** Replaces the runner's fields and history with these, as stored bytes. */
  write: (
    ns: string,
    id: string,
    fields: Record<string, string>,
    history: StoredRunRecord[],
  ) => Promise<void>;
  /** Lets go of the raw connection. */
  close: () => Promise<void>;
}

/** Everything one backend's cases need. */
interface Harness {
  /** A fresh driver on the backend's isolated storage. */
  driver: () => JobsDriver;
  /** A config for the same storage, handed to a child as `childDriver`. */
  config: DriverConfig;
  /** How to write raw; absent for memory, which has no store outside the driver. */
  raw?: () => Promise<RawWriter>;
  /** Drops what the backend's cases created. */
  cleanup: () => Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup().catch(() => {});
  }
});

/** A short random suffix, for table, collection and key prefixes. */
function suffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** Walks a directory for every `state.json` under it. */
async function stateFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await stateFiles(path)));
    } else if (entry.name === "state.json") {
      found.push(path);
    }
  }
  return found;
}

/** A raw SQL client connected the way the suites connect. */
function sqlClient(url: string): SQL {
  const { url: bare, value } = takeBooleanParam(url, "allowPublicKeyRetrieval");
  return new Bun.SQL({
    url: bare,
    ...(value === undefined ? {} : { allowPublicKeyRetrieval: value }),
  });
}

/** Builds a backend's harness on storage of its own. */
async function harnessFor(backend: Backend | "memory"): Promise<Harness> {
  if (backend === "memory") {
    // A store per driver: each case seeds and reads its own instance.
    return {
      driver: () => new MemoryDriver(),
      config: { type: "memory" },
      cleanup: async () => {},
    };
  }

  const config = backend.config;
  if (config.type === "file") {
    const root = config.root;
    return {
      driver: () => createDriver(config),
      config,
      raw: async () => ({
        write: async (_ns, id, fields, history) => {
          // The file this runner's state lives in, found by what the driver
          // wrote into it rather than by knowing its path scheme.
          let target: string | undefined;
          for (const file of await stateFiles(root)) {
            const parsed = JSON.parse(await readFile(file, "utf8")) as {
              fields?: Record<string, string>;
            };
            if (parsed.fields?.name === id) {
              target = file;
            }
          }
          if (!target) {
            throw new Error(`no state.json for runner ${id} under ${root}`);
          }
          await writeFile(
            target,
            `{"fields":${JSON.stringify(fields)},"history":${JSON.stringify(history)},"queued":[]}`,
          );
        },
        close: async () => {},
      }),
      cleanup: async () => {},
    };
  }

  if (config.type === "sql") {
    const prefix = `lg_${suffix()}_`;
    const isolated = { ...config, tablePrefix: prefix };
    const url = config.url!;
    const sqlite = url.startsWith("sqlite://");
    const kv = `${prefix}kv`;
    const backslashEscapes =
      config.adapter === "mysql" || config.adapter === "mariadb";
    return {
      driver: () => createDriver(isolated),
      config: isolated,
      raw: async () => {
        if (sqlite) {
          const db = new Database(url.slice("sqlite://".length));
          return {
            write: async (ns, id, fields, history) => {
              const value = JSON.stringify({ fields, history, queued: [] });
              const result = db
                .query(
                  `UPDATE ${kv} SET value = ?1 WHERE ns = ?2 AND kv_key = ?3`,
                )
                .run(value, ns, `${runnerKey(id)}:state`);
              expect(result.changes).toBe(1);
            },
            close: async () => db.close(),
          };
        }
        const client = sqlClient(url);
        return {
          write: async (ns, id, fields, history) => {
            // A hand-written literal, not the driver's encoder. MySQL and
            // MariaDB read a backslash in a string literal as an escape, and
            // `config:code` is JSON inside JSON, so theirs are doubled.
            const json = JSON.stringify({ fields, history, queued: [] });
            const literal = (
              backslashEscapes ? json.replaceAll("\\", "\\\\") : json
            ).replaceAll("'", "''");
            await client.unsafe(
              `UPDATE ${kv} SET value = '${literal}' WHERE ns = '${ns}' AND kv_key = '${runnerKey(id)}:state'`,
            );
            const rows = (await client.unsafe(
              `SELECT value FROM ${kv} WHERE ns = '${ns}' AND kv_key = '${runnerKey(id)}:state'`,
            )) as { value: unknown }[];
            expect(rows).toHaveLength(1);
          },
          close: async () => await client.close(),
        };
      },
      cleanup: async () => {
        if (sqlite) {
          return;
        }
        const client = sqlClient(url);
        try {
          for (const table of SQL_TABLES) {
            await client.unsafe(`DROP TABLE IF EXISTS ${prefix}${table}`);
          }
        } finally {
          await client.close();
        }
      },
    };
  }

  if (config.type === "redis") {
    const keyPrefix = `lg-${suffix()}`;
    const isolated = { ...config, keyPrefix };
    const url = config.url!;
    const scan = async (client: Bun.RedisClient, pattern: string) => {
      const keys: string[] = [];
      let cursor = "0";
      do {
        const [next, batch] = (await client.send("SCAN", [
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          "1000",
        ])) as [string, string[]];
        cursor = next;
        keys.push(...batch);
      } while (cursor !== "0");
      return keys;
    };
    return {
      driver: () => createDriver(isolated),
      config: isolated,
      raw: async () => {
        const client = new Bun.RedisClient(url);
        return {
          write: async (ns, id, fields, history) => {
            const keys = await scan(client, `${keyPrefix}:${ns}:r:*`);
            const state = keys.find(
              (key) => key.includes(id) && key.endsWith(":state"),
            );
            expect(state).toBeDefined();
            const list = state!.replace(/:state$/, ":history");
            await client.send("DEL", [state!, list]);
            await client.send("HSET", [
              state!,
              ...Object.entries(fields).flat(),
            ]);
            // Oldest pushed first, so the newest ends up at the head.
            for (const record of [...history].reverse()) {
              await client.send("LPUSH", [list, JSON.stringify(record)]);
            }
          },
          close: async () => client.close(),
        };
      },
      cleanup: async () => {
        const client = new Bun.RedisClient(url);
        try {
          const keys = await scan(client, `${keyPrefix}:*`);
          if (keys.length > 0) {
            await client.send("DEL", keys);
          }
        } finally {
          client.close();
        }
      },
    };
  }

  if (config.type === "mongodb") {
    const collectionPrefix = `lg_${suffix()}_`;
    const isolated = { ...config, collectionPrefix };
    const url = config.url!;
    const database = new URL(url).pathname.replace(/^\//, "") || "bun_jobs";
    const { MongoClient } = await import("mongodb");
    return {
      driver: () => createDriver(isolated),
      config: isolated,
      raw: async () => {
        const client = new MongoClient(url);
        await client.connect();
        const kv = client
          .db(database)
          .collection<{ _id: string }>(`${collectionPrefix}kv`);
        return {
          write: async (ns, id, fields, history) => {
            const result = await kv.updateOne(
              { _id: `${ns}:${runnerKey(id)}:state` },
              {
                $set: {
                  fields,
                  counters: {},
                  history: history.map((record) => JSON.stringify(record)),
                },
              },
            );
            expect(result.matchedCount).toBe(1);
          },
          close: async () => await client.close(),
        };
      },
      cleanup: async () => {
        const client = new MongoClient(url);
        await client.connect();
        try {
          const db = client.db(database);
          for (const { name } of await db.listCollections().toArray()) {
            if (name.startsWith(collectionPrefix)) {
              await db.dropCollection(name);
            }
          }
        } finally {
          await client.close();
        }
      },
    };
  }

  throw new Error(`no harness for ${JSON.stringify(config)}`);
}

/** Seeds the old shape by `method`, first creating the rows a raw write replaces. */
async function seed(
  h: Harness,
  driver: JobsDriver,
  method: "driver" | "raw",
  ns: string,
  id: string,
  fields: Record<string, string>,
): Promise<void> {
  await driver.connect();
  if (method === "driver") {
    await seedThroughDriver(driver, ns, id, fields);
    return;
  }
  // The rows exist first, written the ordinary way and in the new spelling,
  // so the raw write below *replaces* them: what the new code then reads is
  // only what that write put there.
  const key = runnerKey(id);
  await driver.setState(ns, key, { name: id, paused: "0" });
  await driver.appendHistory(
    ns,
    key,
    {
      ...oldRecord(id, `${id}-seed`, "child-process", Date.now() - 10_000),
    } as unknown as RunRecord,
    50,
  );
  const raw = await h.raw!();
  try {
    await raw.write(ns, id, fields, oldHistory(id));
  } finally {
    await raw.close();
  }
}

/** The negative control: the driver hands back the old spelling as stored. */
async function expectStoredOld(
  driver: JobsDriver,
  ns: string,
  id: string,
  allowed: readonly string[],
): Promise<void> {
  const key = runnerKey(id);
  const state = await driver.getState(ns, key);
  expect(state.executionMode).toBe("spawn");
  expect(state[RUNNER_CONFIG_STATE.executionMode]).toBe("worker");
  expect(JSON.parse(state[RUNNER_CONFIG_STATE.allowed]!)).toEqual([...allowed]);
  expect(JSON.parse(state[RUNNER_CONFIG_STATE.code]!).executionMode).toBe(
    "worker",
  );
  const history = await driver.listHistory(ns, key);
  expect(history.map((record) => record.mode as string)).toEqual([
    "worker",
    "spawn",
  ]);
}

const serverBackends = await crossProcessBackends({ cleanups });
const backends: {
  name: string;
  available: boolean;
  backend: Backend | "memory";
}[] = [
  { name: "memory", available: true, backend: "memory" },
  ...serverBackends.map((backend) => ({
    name: backend.name,
    available: backend.available,
    backend,
  })),
];

const ENV_HANDLER = join(
  import.meta.dir,
  "fixtures",
  "handlers",
  "environment.ts",
);

for (const { name, available, backend } of backends) {
  describe.skipIf(!available)(`old execution-mode spellings: ${name}`, () => {
    let built: Harness | undefined;

    /** The backend's harness, built on first use and cleaned up after all. */
    const setup = async (): Promise<Harness> => {
      if (!built) {
        built = await harnessFor(backend);
        cleanups.push(built.cleanup);
      }
      return built;
    };

    const methods: ("driver" | "raw")[] =
      backend === "memory" ? ["driver"] : ["driver", "raw"];

    for (const method of methods) {
      it(`reads a store seeded ${method === "raw" ? "raw" : "through the driver"} in the new spellings only`, async () => {
        const h = await setup();
        const driver = h.driver();
        const ns = testNamespace(`legacy-${name}`);
        const id = `legacy-${method}-${suffix()}`;
        await seed(h, driver, method, ns, id, oldFields(id));

        await expectStoredOld(driver, ns, id, [
          "spawn",
          "worker",
          "in-process",
        ]);

        const jobs = new BunJobs({ namespace: ns, driver, logger: noopLogger });
        try {
          const controller = await jobs.runners.controller(id);
          expect(controller.isLocal).toBe(false);

          const info = await controller.info();
          expect(info.executionMode).toBe("child-process");
          expect(info.config?.effective.executionMode).toBe("child-process");
          expect(info.config?.code?.executionMode).toBe("worker-thread");
          // Exactly the stored list, translated: same length, same order.
          expect(info.config?.allowed).toEqual([
            "child-process",
            "worker-thread",
            "in-process",
          ]);
          expect(info.lastRun?.mode).toBe("worker-thread");
          expect(oldSpellings(info)).toEqual([]);

          const history = await controller.history();
          expect(history.map((record) => record.mode)).toEqual([
            "worker-thread",
            "child-process",
          ]);
          const page = await controller.historyPage({
            offset: 0,
            limit: 10,
            order: "desc",
          });
          expect(page.records.map((record) => record.mode)).toEqual([
            "worker-thread",
            "child-process",
          ]);
          expect(oldSpellings(page)).toEqual([]);
          expect(oldSpellings(await controller.config())).toEqual([]);

          // The management API, checking every answer against its schema.
          const api = harness({ jobs });
          const runner = await api.call("GET", `/runners/${id}`);
          expect(runner.status).toBe(200);
          expect(runner.body.executionMode).toBe("child-process");
          expect(runner.body.config.allowed).toEqual([
            "child-process",
            "worker-thread",
            "in-process",
          ]);
          expect(runner.body.lastRun.mode).toBe("worker-thread");
          expect(oldSpellings(runner.body)).toEqual([]);

          const runs = await api.call("GET", `/runners/${id}/history`);
          expect(runs.status).toBe(200);
          expect(
            (runs.body.items as { mode: ExecutionMode }[]).map(
              (run) => run.mode,
            ),
          ).toEqual(["worker-thread", "child-process"]);
          expect(oldSpellings(runs.body)).toEqual([]);

          const list = await api.call("GET", "/runners");
          expect(list.status).toBe(200);
          expect(oldSpellings(list.body)).toEqual([]);

          // An old spelling on input is refused, naming its replacement.
          const refused = await api.call("PUT", `/runners/${id}/config`, {
            executionMode: "spawn",
          });
          expect(refused.status).toBe(400);
          expect(refused.body.code).toBe("VALIDATION");
          expect(refused.body.issues[0].message).toContain(
            '"spawn" is the old spelling of "child-process"',
          );

          // Accepted, because the stored `allowed` read translated rather than
          // dropped: a filtered list would have answered 409 here.
          const accepted = await api.call("PUT", `/runners/${id}/config`, {
            executionMode: "child-process",
          });
          expect(accepted.status).toBe(200);
          expect(oldSpellings(accepted.body)).toEqual([]);
          const written = await driver.getState(ns, runnerKey(id));
          expect(written[RUNNER_CONFIG_STATE.executionMode]).toBe(
            "child-process",
          );

          expect(api.mismatches()).toEqual([]);
        } finally {
          // A context handed a driver instance does not close it.
          await jobs.close();
          await driver.close();
        }
      }, 30_000);

      it(`keeps every entry of a stored ["spawn","worker"] allow-list (${method === "raw" ? "raw" : "through the driver"})`, async () => {
        const h = await setup();
        const driver = h.driver();
        const ns = testNamespace(`legacy-allowed-${name}`);
        const id = `allowed-${method}-${suffix()}`;
        await seed(
          h,
          driver,
          method,
          ns,
          id,
          oldFields(id, ["spawn", "worker"]),
        );
        await expectStoredOld(driver, ns, id, ["spawn", "worker"]);

        const jobs = new BunJobs({ namespace: ns, driver, logger: noopLogger });
        try {
          const controller = await jobs.runners.controller(id);
          const allowed = (await controller.info()).config?.allowed;
          // The same length as stored. "Contains a valid mode" would pass on a
          // list that lost an entry, which is the bug this guards.
          expect(allowed).toHaveLength(2);
          expect(allowed).toEqual(["child-process", "worker-thread"]);

          const api = harness({ jobs });
          const runner = await api.call("GET", `/runners/${id}`);
          expect(runner.body.config.allowed).toEqual([
            "child-process",
            "worker-thread",
          ]);
          expect(api.mismatches()).toEqual([]);
        } finally {
          // A context handed a driver instance does not close it.
          await jobs.close();
          await driver.close();
        }
      }, 30_000);
    }

    it('has an owner adopt an old "worker" override as worker-thread, and run in it', async () => {
      const h = await setup();
      const driver = h.driver();
      const ns = testNamespace(`legacy-owner-${name}`);
      const id = `owner-${suffix()}`;
      await seed(h, driver, h.raw ? "raw" : "driver", ns, id, oldFields(id));
      await expectStoredOld(driver, ns, id, ["spawn", "worker", "in-process"]);

      const runner = new BunRunner({
        id,
        namespace: ns,
        file: ENV_HANDLER,
        executionMode: "in-process",
        driver,
        // A description of the same backend, so the owner can hand a worker
        // thread its driver and the override is adoptable.
        childDriver: h.config,
        waitToExit: false,
        logger: noopLogger,
      });
      try {
        await runner.start();
        expect(runner.executionMode).toBe("worker-thread");
        expect(runner.config.effective.executionMode).toBe("worker-thread");
        expect(runner.config.error).toBeUndefined();

        const settled = new Promise<{ record: RunRecord; result: unknown }>(
          (resolve) => {
            runner.once("finished", (record, result) => {
              resolve({ record, result });
            });
          },
        );
        await runner.trigger();
        const { record, result } = await settled;
        expect(record.mode).toBe("worker-thread");
        expect((result as { mode: string }).mode).toBe("worker-thread");

        // The owner rewrote its own fields in the new spelling; the override
        // is a controller's and stays as it was stored.
        const state = await driver.getState(ns, runnerKey(id));
        expect(state.executionMode).toBe("worker-thread");
        expect(JSON.parse(state[RUNNER_CONFIG_STATE.code]!).executionMode).toBe(
          "in-process",
        );
        expect(JSON.parse(state[RUNNER_CONFIG_STATE.allowed]!)).toEqual([
          "child-process",
          "worker-thread",
          "in-process",
        ]);
        expect(state[RUNNER_CONFIG_STATE.error]).toBeUndefined();
        expect(state[RUNNER_CONFIG_STATE.executionMode]).toBe("worker");
        expect(readStoredRunnerConfig(state).override.executionMode).toBe(
          "worker-thread",
        );
      } finally {
        await runner.stop({ force: true });
        await driver.close().catch(() => {});
      }
    }, 30_000);
  });
}

describe("normalizeExecutionMode", () => {
  it("translates the old spellings, keeps the new, and rejects anything else", () => {
    expect(normalizeExecutionMode("spawn")).toBe("child-process");
    expect(normalizeExecutionMode("worker")).toBe("worker-thread");
    for (const mode of ["child-process", "worker-thread", "in-process"]) {
      expect(normalizeExecutionMode(mode)).toBe(mode as ExecutionMode);
    }
    for (const other of ["telepathy", "", "Spawn", undefined, null, 1]) {
      expect(normalizeExecutionMode(other)).toBeUndefined();
    }
  });

  it("reads a stored allow-list translated before it is filtered", () => {
    const read = (allowed: unknown) =>
      readStoredRunnerConfig({
        [RUNNER_CONFIG_STATE.allowed]: JSON.stringify(allowed),
      }).allowed;
    expect(read(["spawn", "worker"])).toEqual([
      "child-process",
      "worker-thread",
    ]);
    // A mixed list names one mode twice; it is read once, in canonical order.
    expect(read(["in-process", "worker-thread", "worker", "spawn"])).toEqual([
      "child-process",
      "worker-thread",
      "in-process",
    ]);
    // Only a value that is no mode in either spelling is dropped.
    expect(read(["telepathy", "spawn"])).toEqual(["child-process"]);
    expect(read([])).toEqual([]);
    expect(read("spawn")).toBeUndefined();
  });

  it("keeps an override that is no mode in either spelling, so the owner can refuse it by name", () => {
    const override = (raw: string) => {
      const stored = readStoredRunnerConfig({
        [RUNNER_CONFIG_STATE.executionMode]: raw,
      });
      return stored.override.executionMode;
    };
    expect(override("worker")).toBe("worker-thread");
    expect(override("telepathy")).toBe("telepathy");
  });
});

describe("the serializers, as the second guard", () => {
  const req = {} as Parameters<typeof toRunRecordDto>[1];
  const options = {
    exposeHosts: true,
    exposeStacks: false,
    exposeRunnerFiles: false,
  } as Parameters<typeof toRunRecordDto>[2];

  it("puts no old spelling on the wire, whatever reaches them", () => {
    const record = oldRecord("r", "run", "spawn", 1) as unknown as RunRecord;
    expect(toRunRecordDto(record, req, options).mode).toBe("child-process");

    const config = toRunnerConfigDto({
      effective: {
        executionMode: "worker" as ExecutionMode,
        runMode: "single",
        maxConcurrency: null,
      },
      code: {
        executionMode: "spawn" as ExecutionMode,
        runMode: "single",
        maxConcurrency: null,
      },
      overridden: ["executionMode"],
      allowed: ["spawn", "worker", "in-process"] as ExecutionMode[],
      seq: 1,
    });
    expect(config.effective.executionMode).toBe("worker-thread");
    expect(config.code?.executionMode).toBe("child-process");
    expect(config.allowed).toEqual([
      "child-process",
      "worker-thread",
      "in-process",
    ]);

    const info = toRunnerInfoDto(
      {
        id: "r",
        namespace: "ns",
        isLocal: false,
        name: "r",
        schedule: null,
        nextRunAt: null,
        executionMode: "worker" as ExecutionMode,
        isPaused: false,
        isRunning: false,
        queuedTriggers: 0,
        stats: {
          runs: 0,
          success: 0,
          failed: 0,
          timeout: 0,
          killed: 0,
          skipped: 0,
        },
        lastRun: record,
      } as unknown as Parameters<typeof toRunnerInfoDto>[0],
      req,
      options,
    );
    expect(info.executionMode).toBe("worker-thread");
    expect(info.lastRun?.mode).toBe("child-process");
    expect(oldSpellings(info)).toEqual([]);
  });
});

const inputDir = await makeTmpDir("bun-jobs-legacy-input");
cleanups.push(inputDir.cleanup);

describe("old spellings as new input", () => {
  /** Builds a runner with `options` over the defaults, as plain JavaScript might. */
  const build = (options: Record<string, unknown>) =>
    new BunRunner({
      id: "input",
      namespace: testNamespace("legacy-input"),
      file: ENV_HANDLER,
      driver: { type: "file", root: join(inputDir.path, "driver") },
      logger: noopLogger,
      ...options,
    } as unknown as ConstructorParameters<typeof BunRunner>[0]);

  /** The `ConfigError` `run` throws. */
  const configErrorOf = (run: () => unknown): ConfigError => {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return error as ConfigError;
    }
    throw new Error("expected a ConfigError");
  };

  it("refuses an old executionMode option, naming its replacement", () => {
    for (const [old, current] of Object.entries(LEGACY_EXECUTION_MODES)) {
      const error = configErrorOf(() => build({ executionMode: old }));
      expect(error.message).toBe(
        `executionMode must be one of child-process, worker-thread, in-process, not "${old}": "${old}" is the old spelling of "${current}"`,
      );
    }
    // Anything else gets no hint.
    expect(
      configErrorOf(() => build({ executionMode: "telepathy" })).message,
    ).toBe(
      'executionMode must be one of child-process, worker-thread, in-process, not "telepathy"',
    );
  });

  it("defaults executionMode to child-process", () => {
    expect(build({}).executionMode).toBe("child-process");
  });

  it("refuses an old spelling in allowedOverrides.executionModes", () => {
    const error = configErrorOf(() =>
      build({ allowedOverrides: { executionModes: ["in-process", "worker"] } }),
    );
    expect(error.message).toBe(
      `allowedOverrides.executionModes must only contain child-process, worker-thread, in-process${legacyExecutionModeHint("worker")}`,
    );
  });

  it("refuses an old spelling in updateConfig", async () => {
    const runner = build({ executionMode: "in-process" });
    try {
      await runner.start();
      let caught: unknown;
      try {
        await runner.updateConfig({
          executionMode: "spawn" as ExecutionMode,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).context).toMatchObject({
        reason: "invalid",
        executionMode: "spawn",
      });
      expect((caught as ConfigError).message).toContain(
        '"spawn" is the old spelling of "child-process"',
      );
    } finally {
      await runner.stop({ force: true });
    }
  });
});
