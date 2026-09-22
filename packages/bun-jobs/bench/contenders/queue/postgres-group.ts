import type {
  JobPayload,
  QueueContender,
  QueueHandle,
  QueueSetupContext,
} from "../../lib/types";
import { padding } from "../../lib/harness";
import { AGENDA_CLOCK, agendaHandle } from "./redis-group";

/**
 * The Postgres-backed competitors: pg-boss, graphile-worker and Agenda's
 * Postgres backend.
 *
 * Each keeps its own schema so the three never contend on the same tables, and
 * each is configured for one attempt with the completed job discarded.
 */

/* ------------------------------------------------------------------ *
 * pg-boss
 * ------------------------------------------------------------------ */

/**
 * pg-boss. Its polling interval has a hard floor of 500ms, which the
 * round-trip figure is dominated by; the note says so rather than the number
 * being left to look like a dispatch cost.
 */
export function pgBoss(pollIntervalMs: number): QueueContender {
  const seconds = Math.max(0.5, pollIntervalMs / 1000);

  return {
    id: "pg-boss",
    label: "pg-boss",
    backend: "postgres",
    nativeBulk: true,
    note:
      "LISTEN/NOTIFY on (useListenNotify + notify), burst mode on " +
      `(burstWhenBatchFull), ${seconds}s poll as a backstop — pg-boss ships all ` +
      "three off, and measuring the defaults would measure the defaults; " +
      "no completion event, so drains are timed to the first read of the job " +
      "table that finds none of the run's jobs short of `completed`",
    async setup(ctx: QueueSetupContext): Promise<QueueHandle> {
      const { PgBoss } = await import("pg-boss");
      const pad = padding(ctx.payloadBytes);

      const boss = new PgBoss({
        connectionString: ctx.url,
        schema: "bench_pgboss",
        // Maintenance and archiving are background work this benchmark never
        // reads back; every entry is measured with its history discarded.
        supervise: false,
        migrate: true,
        // Off by default. Without it a worker waits out its poll interval,
        // which has a hard floor of 500ms, so the round-trip figure would be
        // that floor rather than anything about pg-boss.
        useListenNotify: true,
      });
      boss.on("error", ctx.onError);
      await boss.start();
      await boss.createQueue(ctx.name, { notify: true }).catch(() => {});

      let working = false;

      return {
        async add(payload) {
          await boss.send(ctx.name, pad ? { ...payload, pad } : payload);
        },

        async addBulk(payloads) {
          await boss.insert(
            ctx.name,
            payloads.map((payload) => ({
              data: pad ? { ...payload, pad } : payload,
            })),
          );
        },

        async startWorker(concurrency) {
          await boss.work<JobPayload>(
            ctx.name,
            {
              batchSize: concurrency,
              pollingIntervalSeconds: seconds,
              // While every fetch comes back full there is obviously more
              // work, so pg-boss re-fetches with no delay. This is its own
              // answer to draining a backlog, and it is off by default.
              burstWhenBatchFull: true,
            },
            async (jobs) => {
              for (const job of jobs) ctx.onReceive(job.data);
            },
          );
          working = true;
        },

        // pg-boss completes a batch once its handler returns, but reports it
        // nowhere outside its test-only spies, so the drain reads the job
        // table instead: this run's jobs still short of `completed`.
        async outstanding() {
          const { rows } = await boss
            .getDb()
            .executeSql(
              `select count(*)::int as left from bench_pgboss.job where name = $1 and state < 'completed'`,
              [ctx.name],
            );
          return Number((rows[0] as { left?: number } | undefined)?.left ?? 0);
        },

        async stopWorker() {
          if (working) await boss.offWork(ctx.name).catch(() => {});
          working = false;
        },

        async reset() {
          await boss.deleteQueuedJobs(ctx.name).catch(() => {});
        },

        async close() {
          await boss.stop({ graceful: false, close: true }).catch(() => {});
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * graphile-worker
 * ------------------------------------------------------------------ */

/**
 * graphile-worker. It listens on a Postgres channel as well as polling, so a
 * job added while it is idle is picked up without waiting out the interval.
 */
export function graphileWorker(pollIntervalMs: number): QueueContender {
  return {
    id: "graphile-worker",
    label: "graphile-worker",
    backend: "postgres",
    nativeBulk: true,
    note:
      `LISTEN/NOTIFY with a ${pollIntervalMs}ms poll as a backstop; completed jobs are deleted; ` +
      "its completion events fire before the write, so drains are timed to the " +
      "first read of the job table that finds it empty",
    async setup(ctx: QueueSetupContext): Promise<QueueHandle> {
      const { run, makeWorkerUtils } = await import("graphile-worker");
      const pad = padding(ctx.payloadBytes);
      const schema = "bench_graphile";

      const utils = await makeWorkerUtils({
        connectionString: ctx.url,
        schema,
      });

      let runner: Awaited<ReturnType<typeof run>> | undefined;

      return {
        async add(payload) {
          await utils.addJob("bench", pad ? { ...payload, pad } : payload);
        },

        async addBulk(payloads) {
          await utils.addJobs(
            payloads.map((payload) => ({
              identifier: "bench",
              payload: pad ? { ...payload, pad } : payload,
            })),
          );
        },

        async startWorker(concurrency) {
          runner = await run({
            connectionString: ctx.url,
            schema,
            concurrency,
            pollInterval: pollIntervalMs,
            noHandleSignals: true,
            taskList: {
              bench: async (payload) => {
                ctx.onReceive(payload as JobPayload);
              },
            },
          });
          runner.events.on("job:failed", ({ error }) => ctx.onError(error));
        },

        // graphile-worker issues `completeJob` without awaiting it and emits
        // `job:success` / `job:complete` before it lands, so neither marks a
        // recorded completion. It deletes a job's row on completion, so the
        // drain reads the table instead: the same scope `reset()` clears.
        async outstanding() {
          return utils.withPgClient(async (client) => {
            const { rows } = await client.query<{ left: number }>(
              `select count(*)::int as left from ${schema}._private_jobs`,
            );
            return Number(rows[0]?.left ?? 0);
          });
        },

        async stopWorker() {
          // `stop()` may hand back a plain value rather than a promise.
          await Promise.resolve(runner?.stop()).catch(() => {});
          runner = undefined;
        },

        async reset() {
          await utils.withPgClient(async (client) => {
            await client.query(`delete from ${schema}._private_jobs`);
          });
        },

        async close() {
          await Promise.resolve(runner?.stop()).catch(() => {});
          await Promise.resolve(utils.release()).catch(() => {});
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * Agenda on Postgres
 * ------------------------------------------------------------------ */

/** Agenda with its Postgres backend. */
export function agendaPostgres(pollIntervalMs: number): QueueContender {
  return {
    id: "agenda-postgres",
    label: "Agenda (postgres)",
    backend: "postgres",
    nativeBulk: false,
    note: `polls every ${pollIntervalMs}ms; no batch enqueue, so the bulk figure is a sequential loop; ${AGENDA_CLOCK}`,
    setup: (ctx) => agendaHandle(ctx, pollIntervalMs, "postgres"),
  };
}

/* ------------------------------------------------------------------ *
 * Agenda on MongoDB
 * ------------------------------------------------------------------ */

/** Agenda with its MongoDB backend — the configuration it is best known in. */
export function agendaMongo(pollIntervalMs: number): QueueContender {
  return {
    id: "agenda-mongodb",
    label: "Agenda (mongodb)",
    backend: "mongodb",
    nativeBulk: false,
    note: `polls every ${pollIntervalMs}ms; no batch enqueue, so the bulk figure is a sequential loop; ${AGENDA_CLOCK}`,
    setup: (ctx) => agendaHandle(ctx, pollIntervalMs, "mongodb"),
  };
}
