import type { BunJobsOptions, FlowChildrenValues } from "@kingsleyweb/bun-jobs";
import { BunJobs, JobDataValidationError } from "@kingsleyweb/bun-jobs";
import { z } from "zod";

/**
 * Schema-checked flows (bun-validate V5a and V5c): every node of an
 * `addFlow()` is checked against its own name's schema before anything is
 * written, and the parent's `getChildrenValues()` is typed from the flow's
 * declared shape.
 *
 * A third service on the same namespace and driver (`flows`), because the
 * parent's typing comes from the context's job map. The main context never
 * starts its registry worker, so this service's is the only one; its
 * registry queue shows in the UI as `jobs`.
 *
 * What you see:
 *
 * - Queues → `jobs`: `digest-pack-2026-10`, `waiting-children` until its two
 *   children ran, then completed. Its log line says what it read from its
 *   children — typed (`jobs:figures-2026-10` is a `{ rows: number }`, keyed
 *   `queue:id`), and guaranteed, because each child checks its own result
 *   with `resultValidation: "error"`.
 * - The terminal at startup: a second flow whose child carries a bad month
 *   (`"2026/10"` against `^\d{4}-\d{2}$`) is refused with
 *   `JobDataValidationError` and nothing of it is written, on any queue.
 */

/** Waits `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A random integer in [min, max]. */
function between(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** A month, `YYYY-MM` — the data schema of every node of the digest flow. */
const Month = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) });

/**
 * The digest flow, declared once `as const` so its names and ids stay
 * literals: the parent's `children` type below is derived from it, and the
 * same object is what is seeded.
 */
const digestFlow = {
  name: "pack-digest",
  data: { month: "2026-10" },
  opts: { jobId: "digest-pack-2026-10" },
  children: [
    {
      name: "fetch-figures",
      data: { month: "2026-10" },
      opts: { jobId: "figures-2026-10" },
    },
    {
      name: "render-glance",
      data: { month: "2026-10" },
      opts: { jobId: "glance-2026-10" },
    },
  ],
} as const;

/**
 * The digest service's jobs: the parent's entry declares `children`, so its
 * handler's `getChildrenValues()` is typed from the flow above.
 */
interface DigestJobs {
  /** The month's figures. */
  "fetch-figures": { data: { month: string }; result: { rows: number } };
  /** The month's glance chart. */
  "render-glance": { data: { month: string }; result: { chart: string } };
  /** The digest, packing both children's results. */
  "pack-digest": {
    /** Which month. */
    data: { month: string };
    /** What was packed. */
    result: string;
    /** Its children's results, keyed `queue:id`, from the flow above. */
    children: FlowChildrenValues<typeof digestFlow, DigestJobs, "jobs">;
  };
}

/** A started flows service, and how to stop it. */
export interface FlowsService {
  /** Its context, so the caller can close it last. */
  jobs: BunJobs<DigestJobs>;
  /** Closes the context (its registry worker with it). */
  stop: () => Promise<void>;
}

/**
 * Starts the `flows` service: three schema-checked definitions, the registry
 * worker that runs them, one good digest flow, and one refused one.
 */
export async function startFlows(
  options: Pick<BunJobsOptions, "namespace" | "driver" | "logger">,
): Promise<FlowsService> {
  const jobs = new BunJobs<DigestJobs>({
    ...options,
    // What the Workers page groups its registry worker under.
    service: "flows",
    publishEvents: true,
  });

  // Each child checks its own result (`resultValidation: "error"`), so the
  // parent's typed read of it is a guarantee, not a claim.
  jobs.define(
    "fetch-figures",
    async (job) => {
      await job.log(`counting the ${job.data.month} figures`);
      await sleep(between(400, 1_200));
      return { rows: between(800, 9_000) };
    },
    {
      schema: { data: Month, result: z.object({ rows: z.number().int() }) },
      resultValidation: "error",
    },
  );

  jobs.define(
    "render-glance",
    async (job) => {
      await job.log(`rendering the ${job.data.month} glance`);
      await sleep(between(400, 1_200));
      return { chart: `glance-${job.data.month}.png` };
    },
    {
      schema: { data: Month, result: z.object({ chart: z.string() }) },
      resultValidation: "error",
    },
  );

  jobs.define(
    "pack-digest",
    async (job) => {
      const values = await job.getChildrenValues();
      const figures = values["jobs:figures-2026-10"];
      const glance = values["jobs:glance-2026-10"];
      await job.log(`packed ${figures.rows} rows and ${glance.chart}`);
      return `digest ${job.data.month}: ${figures.rows} rows, ${glance.chart}`;
    },
    { schema: { data: Month } },
  );

  // The registry worker. The main context never starts one, so this is the
  // only consumer of the namespace's `jobs` queue.
  await jobs.start({ pollInterval: 50 });

  // The seed. Fixed ids: on a backend that survives a restart
  // (`PLAYGROUND_DRIVER=sqlite`) a second start answers duplicates instead.
  const registry = jobs.queue("jobs");
  await registry.addFlow(digestFlow);

  // And one that is refused: the bad month fails the child's schema before
  // the first write, so nothing of it is written, on any queue.
  try {
    await registry.addFlow({
      name: "pack-digest",
      data: { month: "2026-10" },
      opts: { jobId: "digest-pack-refused" },
      children: [{ name: "fetch-figures", data: { month: "2026/10" } }],
    });
  } catch (error) {
    if (error instanceof JobDataValidationError) {
      console.log(
        `flows: a digest flow with a bad month was refused, nothing written (${error.message})`,
      );
    } else {
      throw error;
    }
  }

  return { jobs, stop: () => jobs.close() };
}
