import type {
  BunQueueOptions,
  BunQueueWorkerOptions,
  Job,
  JobDefinition,
  JobMapFromSchemas,
  JobProcessor,
} from "../lib/index";
import { z } from "zod";
import { s } from "../lib/api/schema/builder";
import { BunJobs, BunQueue, BunQueueWorker, MemoryDriver } from "../lib/index";

/**
 * Compile-time guarantees for job data and result schemas (bun-validate V5a,
 * plan §4.8.1): what `schema: { data, result }` infers on `define()`, a bare
 * `BunQueue` and a bare `BunQueueWorker`, `JobMapFromSchemas`, and that
 * `define()` lifts the schema out of `definition.options`.
 *
 * Checked by `bun run check`, not `bun test`. Each `@ts-expect-error` is a
 * negative control (`bun scripts/prove-type-controls.ts
 * __tests__/jobSchema.type-test.ts` removes each in turn and requires an
 * error), and each guarded call is kept to one line so the directive
 * reaches it. Nothing here runs.
 */

/** Resolves to `true` only when `A` and `B` are the same type. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Fails to compile unless given `true`. */
type Expect<T extends true> = T;

/** A zod data schema whose output differs from its input (a coercion and a default). */
const Email = z.object({
  to: z.email(),
  retries: z.coerce.number().default(3),
});

/** A zod result schema. */
const Sent = z.object({ id: z.string() });

/** The same shape in bun-jobs' own `s`. */
const SEmail = s.object({ to: s.string(), retries: s.integer() });

/** Schemas for a whole registry. */
const schemas = {
  sendEmail: { data: Email, result: Sent },
  reindex: { result: z.number() },
  ping: {},
  sEmail: { data: SEmail },
};

export async function jobSchemaTypeChecks(): Promise<void> {
  const driver = new MemoryDriver();

  /* --- JobMapFromSchemas ------------------------------------------------ */

  type Map = JobMapFromSchemas<typeof schemas>;
  type SendData = Equal<
    Map["sendEmail"]["data"],
    { to: string; retries: number }
  >;
  type _SendData = Expect<SendData>;
  type SendResult = Equal<Map["sendEmail"]["result"], { id: string }>;
  type _SendResult = Expect<SendResult>;
  type ReindexData = Equal<Map["reindex"]["data"], unknown>;
  type _ReindexData = Expect<ReindexData>;
  type ReindexResult = Equal<Map["reindex"]["result"], number>;
  type _ReindexResult = Expect<ReindexResult>;
  type SData = Equal<Map["sEmail"]["data"], { to: string; retries: number }>;
  type _SData = Expect<SData>;

  // Negative control: the map is the schemas' types, not anything at all.
  // @ts-expect-error -- `to` is a string in the map
  type _Wrong = Expect<Equal<Map["sendEmail"]["data"], { to: number }>>;

  /* --- a typed context: the map types the registry ------------------------ */

  const typed = new BunJobs<Map>({ namespace: "types", driver });
  typed.define(
    "sendEmail",
    async (job) => {
      type Data = Equal<typeof job.data, { to: string; retries: number }>;
      type _Data = Expect<Data>;
      return { id: job.data.to };
    },
    { attempts: 3, schema: schemas.sendEmail },
  );
  void typed.now("sendEmail", { to: "a@b.c", retries: 1 });
  // @ts-expect-error -- the map's data, so `to` must be a string
  void typed.now("sendEmail", { to: 1, retries: 1 });
  // @ts-expect-error -- a schema whose output is not the declared data
  typed.define("sendEmail", async () => ({ id: "x" }), {
    schema: { data: z.object({ to: z.number() }) },
  });

  /* --- define() on an untyped context ------------------------------------ */

  const jobs = new BunJobs({ namespace: "types", driver });

  // The handler's data is the data schema's output; it answers with the
  // result schema's input.
  jobs.define(
    "sendEmail",
    async (_job) => {
      type Data = Equal<typeof _job.data, { to: string; retries: number }>;
      type _Data = Expect<Data>;
      return { id: "x" };
    },
    { attempts: 5, schema: { data: Email, result: Sent } },
  );
  const both = { schema: { data: Email, result: Sent } };
  // @ts-expect-error -- the result schema wants { id: string }
  jobs.define("badResult", async () => ({ id: 1 }), both);

  // A data schema alone leaves the result open.
  jobs.define(
    "dataOnly",
    async (_job) => {
      type Data = Equal<typeof _job.data, { to: string; retries: number }>;
      type _Data = Expect<Data>;
      return 42;
    },
    { schema: { data: Email } },
  );

  // bun-jobs' own `s` works the same way.
  jobs.define(
    "withS",
    async (_job) => {
      type Data = Equal<typeof _job.data, { to: string; retries: number }>;
      type _Data = Expect<Data>;
    },
    { schema: { data: SEmail } },
  );
  const withS = { schema: { data: SEmail } };
  // @ts-expect-error -- `to` is a string under `s` too
  jobs.define("withSBad", async (job) => job.data.to.toFixed(), withS);

  // Without a schema, define() is as it was.
  jobs.define<{ n: number }, string>("plain", async (job) =>
    String(job.data.n),
  );
  const notSchema = { schema: { data: { parse: () => 1 } } };
  // @ts-expect-error -- not a Standard Schema
  jobs.define("notSchema", async () => 1, notSchema);

  /* --- define() lifts the schema out of the options ---------------------- */

  const [definition] = jobs.definitions();
  type Options = typeof definition.options;
  type NoSchemaKey = "schema" extends keyof Options ? false : true;
  type _NoSchemaKey = Expect<NoSchemaKey>;
  type NoPolicyKey = "dataValidation" extends keyof Options ? false : true;
  type _NoPolicyKey = Expect<NoPolicyKey>;
  // @ts-expect-error -- the schema is beside the options, never in them
  void definition.options.schema;
  const _lifted: JobDefinition["schema"] = definition.schema;

  /* --- a bare BunQueue infers what add takes ----------------------------- */

  const queue = new BunQueue("mail", {
    namespace: "types",
    driver,
    schema: { data: z.object({ to: z.string() }) },
  });
  void queue.add("send", { to: "a" });
  // @ts-expect-error -- the data schema's input wants a string
  void queue.add("send", { to: 1 });

  // Options typed without a schema still pass to a queue whose types are given.
  const plainOptions: BunQueueOptions = { namespace: "types", driver };
  const _typedQueue = new BunQueue<{ id: number }>("typed", plainOptions);

  /* --- a bare BunQueueWorker infers what its processor gets -------------- */

  const _worker = new BunQueueWorker(
    "mail",
    async (job) => {
      type Data = Equal<typeof job.data, { to: string; retries: number }>;
      type _Data = Expect<Data>;
      return { id: job.data.to };
    },
    { namespace: "types", driver, schema: { data: Email, result: Sent } },
  );
  const sent = { namespace: "types", driver, schema: { result: Sent } };
  // @ts-expect-error -- the processor must answer with the result schema's input
  const _badWorker = new BunQueueWorker("mail", async () => ({ id: 1 }), sent);

  const plainWorkerOptions: BunQueueWorkerOptions = {
    namespace: "types",
    driver,
  };
  const processor: JobProcessor<{ id: number }, string> = (job) =>
    String(job.data.id);
  const _typedWorker = new BunQueueWorker<{ id: number }, string>(
    "typed",
    processor,
    plainWorkerOptions,
  );

  // jobs.worker() infers the same way.
  const _ctxWorker = jobs.worker(
    "mail",
    async (job: Job<{ to: string; retries: number }>) => job.data.to,
    { schema: { data: Email } },
  );
  const email = { schema: { data: Email } };
  const wrong = async (job: Job<{ to: number }>) => job.data.to;
  // @ts-expect-error -- a processor typed for other data than the schema's output
  const _ctxWorkerBad = jobs.worker("mail", wrong, email);
}
