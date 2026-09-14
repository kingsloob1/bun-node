import type {
  JobPayload,
  QueueContender,
  QueueHandle,
  QueueSetupContext,
} from "../../lib/types";
import { padding } from "../../lib/harness";

/**
 * The Redis-backed competitors: BullMQ, bee-queue and node-resque.
 *
 * All three are configured to match the way `bun-jobs` is measured — one
 * attempt, no retry, the completed job removed — so the figure reflects the
 * claim path rather than how much history each library chooses to keep.
 */

/** Splits a `redis://` URL into the fields these libraries want. */
export function redisFields(url: string): {
  host: string;
  port: number;
  db: number;
  password?: string;
} {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/^\//, "");

  return {
    host: parsed.hostname || "127.0.0.1",
    port: Number(parsed.port || 6379),
    db: path ? Number(path) : 0,
    password: parsed.password || undefined,
  };
}

/* ------------------------------------------------------------------ *
 * BullMQ
 * ------------------------------------------------------------------ */

/** BullMQ, the most widely used Redis queue for Node. */
export const bullmq: QueueContender = {
  id: "bullmq",
  label: "BullMQ",
  backend: "redis",
  nativeBulk: true,
  note: "waits on Redis rather than polling; `removeOnComplete: true`, one attempt",
  async setup(ctx: QueueSetupContext): Promise<QueueHandle> {
    const { Queue, Worker } = await import("bullmq");
    const IORedis = (await import("ioredis")).default;
    const fields = redisFields(ctx.url);
    const pad = padding(ctx.payloadBytes);
    const prefix = "bench";

    // A worker's blocking reads would stall a shared client, so the producer
    // and the consumer each get their own connection.
    const producerConnection = new IORedis({
      ...fields,
      maxRetriesPerRequest: null,
    });
    const connections = [producerConnection];

    const queue = new Queue(ctx.name, {
      connection: producerConnection,
      prefix,
    });
    queue.on("error", ctx.onError);

    const jobOptions = {
      removeOnComplete: true,
      removeOnFail: true,
      attempts: 1,
    };
    let worker: import("bullmq").Worker | undefined;

    return {
      async add(payload) {
        await queue.add(
          "bench",
          pad ? { ...payload, pad } : payload,
          jobOptions,
        );
      },

      async addBulk(payloads) {
        await queue.addBulk(
          payloads.map((payload) => ({
            name: "bench",
            data: pad ? { ...payload, pad } : payload,
            opts: jobOptions,
          })),
        );
      },

      async startWorker(concurrency) {
        const connection = new IORedis({
          ...fields,
          maxRetriesPerRequest: null,
        });
        connections.push(connection);

        worker = new Worker(
          ctx.name,
          async (job) => {
            ctx.onComplete(job.data as JobPayload);
          },
          { connection, prefix, concurrency, autorun: false },
        );
        worker.on("error", ctx.onError);
        worker.on("failed", (_job, error) => ctx.onError(error));
        void worker.run();
        await worker.waitUntilReady();
      },

      async stopWorker() {
        await worker?.close();
        worker = undefined;
      },

      async reset() {
        await queue.obliterate({ force: true }).catch(() => {});
      },

      async close() {
        await worker?.close(true).catch(() => {});
        await queue.close().catch(() => {});
        for (const connection of connections) connection.disconnect();
      },
    };
  },
};

/* ------------------------------------------------------------------ *
 * bee-queue
 * ------------------------------------------------------------------ */

/** bee-queue: smaller and faster than BullMQ, with fewer guarantees. */
export const beeQueue: QueueContender = {
  id: "bee-queue",
  label: "bee-queue",
  backend: "redis",
  nativeBulk: true,
  note: "waits on Redis; `removeOnSuccess: true`, delayed-job sweeping off",
  async setup(ctx: QueueSetupContext): Promise<QueueHandle> {
    const BeeQueue = (await import("bee-queue")).default;
    const fields = redisFields(ctx.url);
    const pad = padding(ctx.payloadBytes);

    const make = (isWorker: boolean) =>
      new BeeQueue<JobPayload>(ctx.name, {
        redis: fields,
        prefix: "bench-bee",
        isWorker,
        // Sweeping delayed jobs is a background timer this benchmark never
        // uses; leaving it on would charge every entry for work not measured.
        activateDelayedJobs: false,
        removeOnSuccess: true,
        removeOnFailure: true,
        storeJobs: false,
      });

    const producer = make(false);
    producer.on("error", ctx.onError);
    await producer.ready();

    let consumer: ReturnType<typeof make> | undefined;

    return {
      async add(payload) {
        await producer.createJob(pad ? { ...payload, pad } : payload).save();
      },

      async addBulk(payloads) {
        await producer.saveAll(
          payloads.map((payload) =>
            producer.createJob(pad ? { ...payload, pad } : payload),
          ),
        );
      },

      async startWorker(concurrency) {
        consumer = make(true);
        consumer.on("error", ctx.onError);
        consumer.on("failed", (_job, error) => ctx.onError(error));
        await consumer.ready();
        consumer.process(concurrency, async (job) => {
          ctx.onComplete(job.data);
        });
      },

      async stopWorker() {
        await consumer?.close(5000).catch(() => {});
        consumer = undefined;
      },

      async reset() {
        await producer.destroy();
      },

      async close() {
        await consumer?.close(1000).catch(() => {});
        await producer.close(1000).catch(() => {});
      },
    };
  },
};

/* ------------------------------------------------------------------ *
 * node-resque
 * ------------------------------------------------------------------ */

/** node-resque: the Resque protocol, so a Ruby worker could share the queue. */
export function nodeResque(pollIntervalMs: number): QueueContender {
  return {
    id: "node-resque",
    label: "node-resque",
    backend: "redis",
    nativeBulk: false,
    note:
      `polls every ${pollIntervalMs}ms (no blocking read); concurrency via MultiWorker; ` +
      "no batch enqueue, so the bulk figure is a sequential loop",
    async setup(ctx: QueueSetupContext): Promise<QueueHandle> {
      const { Queue, MultiWorker } = await import("node-resque");
      const fields = redisFields(ctx.url);
      const pad = padding(ctx.payloadBytes);

      const connection = {
        pkg: "ioredis" as const,
        host: fields.host,
        port: fields.port,
        database: fields.db,
        password: fields.password,
        namespace: `bench-resque:${ctx.name}`,
      };

      const jobs = {
        bench: {
          perform: async (payload: JobPayload) => {
            ctx.onComplete(payload);
          },
        },
      };

      const queue = new Queue({ connection }, jobs);
      queue.on("error", ctx.onError);
      await queue.connect();

      let worker: InstanceType<typeof MultiWorker> | undefined;

      return {
        async add(payload) {
          await queue.enqueue(ctx.name, "bench", [
            pad ? { ...payload, pad } : payload,
          ]);
        },

        async addBulk(payloads) {
          // node-resque exposes no batch enqueue; the loop is the honest
          // equivalent and the note above says so.
          for (const payload of payloads) {
            await queue.enqueue(ctx.name, "bench", [
              pad ? { ...payload, pad } : payload,
            ]);
          }
        },

        async startWorker(concurrency) {
          worker = new MultiWorker(
            {
              connection,
              queues: [ctx.name],
              timeout: pollIntervalMs,
              minTaskProcessors: concurrency,
              maxTaskProcessors: concurrency,
              checkTimeout: pollIntervalMs,
            },
            jobs,
          );
          worker.on("error", (error) => ctx.onError(error));
          worker.on("failure", (_w, _q, _job, error) => ctx.onError(error));
          await worker.start();
        },

        async stopWorker() {
          await worker?.end().catch(() => {});
          worker = undefined;
        },

        async reset() {
          await queue.delQueue(ctx.name).catch(() => {});
        },

        async close() {
          await worker?.end().catch(() => {});
          await queue.end().catch(() => {});
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * Agenda on Redis
 * ------------------------------------------------------------------ */

/** Agenda with its Redis backend, so it appears in the Redis group too. */
export function agendaRedis(pollIntervalMs: number): QueueContender {
  return {
    id: "agenda-redis",
    label: "Agenda (redis)",
    backend: "redis",
    nativeBulk: false,
    note: `polls every ${pollIntervalMs}ms; no batch enqueue, so the bulk figure is a sequential loop`,
    setup: (ctx) => agendaHandle(ctx, pollIntervalMs, "redis"),
  };
}

/**
 * Tables this process has already created, so only the first Agenda instance
 * on a table runs the schema statements.
 */
const ensuredTables = new Set<string>();

/**
 * A Postgres identifier for one run's Agenda table.
 *
 * Run names carry hyphens, which Postgres would need quoted everywhere, so
 * they become underscores and anything else is dropped.
 */
function agendaTable(name: string): string {
  return `bench_agenda_${name.replace(/[^a-z0-9]+/gi, "_")}`.slice(0, 60);
}

/**
 * One Agenda instance on whichever backend it was asked for. Shared by the
 * Redis, Postgres and MongoDB groups, since Agenda 6 is one scheduler with
 * three storage packages behind it.
 */
export async function agendaHandle(
  ctx: QueueSetupContext,
  pollIntervalMs: number,
  kind: "redis" | "postgres" | "mongodb",
): Promise<QueueHandle> {
  const { Agenda } = await import("agenda");
  const pad = padding(ctx.payloadBytes);

  const backend = await (async () => {
    if (kind === "redis") {
      const { RedisBackend } = await import("@agendajs/redis-backend");
      return new RedisBackend({
        connectionString: ctx.url,
        keyPrefix: `bench-agenda:${ctx.name}`,
      });
    }
    if (kind === "postgres") {
      const { PostgresBackend } = await import("@agendajs/postgres-backend");

      // A table per run, matching the per-run key prefix the Redis backend
      // gets and the per-run collection the Mongo one gets. A fixed name here
      // let one run's leftovers arrive during the next, which reads exactly
      // like the library delivering jobs twice.
      const table = agendaTable(ctx.name);

      // Only the first instance creates the schema, and it does so before the
      // next one is built. Several instances creating the same table at once
      // is a race the backend does not guard, and it surfaces as a unique-key
      // violation on the index rather than as anything about jobs.
      const first = !ensuredTables.has(table);
      const backend = new PostgresBackend({
        connectionString: ctx.url,
        tableName: table,
        ensureSchema: first,
      });

      if (first) {
        await backend.connect();
        ensuredTables.add(table);
      }

      return backend;
    }
    const { MongoBackend } = await import("@agendajs/mongo-backend");
    return new MongoBackend({
      address: ctx.url,
      collection: `benchAgenda_${ctx.name}`,
    });
  })();

  const agenda = new Agenda({
    backend,
    // A number, not a string. Agenda parses a string with `human-interval`,
    // which returns NaN for "50 ms" and silently falls back to its 5-second
    // default — measured, that turned a 41ms dispatch into a 4999ms one.
    // ("50 milliseconds" is worse still: human-interval reads it as 50000.)
    processEvery: pollIntervalMs,
    // Off by default, on for every other contender here. Without it Agenda
    // keeps every finished job, so it would be the only entry paying to store
    // a history the benchmark never reads.
    removeOnComplete: true,
  });
  agenda.on("error", ctx.onError);
  agenda.on("fail", (error: unknown) => ctx.onError(error));

  let started = false;

  return {
    async add(payload) {
      await agenda.now("bench", pad ? { ...payload, pad } : payload);
    },

    async addBulk(payloads) {
      for (const payload of payloads) {
        await agenda.now("bench", pad ? { ...payload, pad } : payload);
      }
    },

    async startWorker(concurrency) {
      // Defined here rather than at construction, because a definition's
      // concurrency is fixed when it is declared and Agenda's default of 20
      // would otherwise cap every entry asked for more. Enqueueing needs no
      // definition, so the producer-only scenarios never reach this.
      agenda.maxConcurrency(concurrency);
      agenda.defaultConcurrency(concurrency);
      // Agenda's default lock limit is 0, meaning *unlimited*: it locks every
      // runnable job into memory at once. Against a 5000-job backlog that both
      // collapsed its throughput and made it deliver 18 jobs twice. Bounding
      // the locks to the concurrency is what its documentation asks for, and
      // it is the same window every other contender claims within.
      agenda.lockLimit(concurrency);
      agenda.defaultLockLimit(concurrency);
      agenda.define(
        "bench",
        async (job: { attrs: { data: JobPayload } }) => {
          ctx.onComplete(job.attrs.data);
        },
        { concurrency },
      );

      await agenda.start();
      started = true;
    },

    async stopWorker() {
      if (started) await agenda.stop();
      started = false;
    },

    async reset() {
      await agenda.cancel({});
    },

    async close() {
      if (started) await agenda.stop().catch(() => {});
      await agenda.cancel({}).catch(() => {});
      await (backend as unknown as { close?: () => Promise<void> })
        .close?.()
        .catch(() => {});

      // The per-run table goes with the run. Postgres is the only backend of
      // the three whose storage would otherwise outlive the process.
      if (kind === "postgres") {
        const { SQL } = await import("bun");
        const sql = new SQL(ctx.url, { max: 1 });
        await sql
          .unsafe(`drop table if exists ${agendaTable(ctx.name)}`)
          .catch(() => {});
        await sql.close().catch(() => {});
      }
    },
  };
}
