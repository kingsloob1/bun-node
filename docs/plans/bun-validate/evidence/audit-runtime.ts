/**
 * Part A, runtime: what BunValidate does today, measured through `fetch()`
 * (no socket) on develop. Run from this directory:
 *
 *   bun audit-runtime.ts > results-runtime.txt
 *
 * Each line is `<id> <what> => <observed>`; the plan cites the ids.
 */
import { BunHttpAdapter, BunRouter, validate } from "@kingsleyweb/bun-common";
import { BunQueue, BunQueueWorker, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { s } from "@kingsleyweb/bun-jobs/lib/api";
import { z } from "zod";

const out: string[] = [];
const log = (id: string, what: string, observed: unknown) =>
  out.push(`${id} ${what} => ${typeof observed === "string" ? observed : JSON.stringify(observed)}`);

async function show(res: Response): Promise<string> {
  const text = await res.text();
  return `${res.status} ${res.headers.get("content-type") ?? "-"} ${text.slice(0, 160)}`;
}

const User = z.object({ id: z.string(), name: z.string() });
const PageQuery = z.object({ page: z.coerce.number().int().min(1) });

/* R1: is a response checked? There is no `responses` option; pass one anyway. */
{
  const r = new BunRouter();
  // The option does not exist in the type; cast so the runtime can be asked.
  const opts = { responses: { 200: User }, validateResponses: "throw" } as unknown as Parameters<typeof validate>[1];
  r.get("/r1", validate({ query: PageQuery }, opts), (_req, res) =>
    res.status(200).json({ totally: "wrong" }),
  );
  log("R1", "handler sends a body violating a 'responses' schema", await show(await r.fetch("/r1?page=1")));
}

/* R2: request failure modes and the error shape. */
{
  // Only the keys given are passed: an explicit `undefined` overrides the
  // default (R2h).
  const make = (onFailure?: "next" | "throw" | "respond", status?: number) => {
    const r = new BunRouter();
    const opts = { ...(onFailure ? { onFailure } : {}), ...(status ? { status } : {}) };
    r.get("/q", validate({ query: PageQuery }, opts), (req, res) =>
      res.json({ page: req.query.page }),
    );
    return r;
  };
  log("R2a", "valid query, z.coerce.number()", await show(await make().fetch("/q?page=2")));
  const settle = (p: Promise<Response>) => p.then(show, (e: unknown) => `rejected: ${(e as Error).name}: ${(e as Error).message} (status ${(e as { status?: unknown }).status})`);
  log("R2b", "invalid, default onFailure ('next'), BunRouter.fetch, no error handler", await settle(make().fetch("/q?page=x")));
  log("R2c", "invalid, onFailure 'respond'", await show(await make("respond").fetch("/q?page=x")));
  log("R2d", "invalid, onFailure 'respond', status 422", await show(await make("respond", 422).fetch("/q?page=x")));
  log("R2e", "invalid, onFailure 'throw', BunRouter.fetch", await settle(make("throw").fetch("/q?page=x")));
  {
    const r = new BunRouter();
    r.get("/q", validate({ query: PageQuery }, { onFailure: "respond", status: undefined }), (req, res) => res.json({ page: req.query.page }));
    log("R2h", "onFailure 'respond' with status: undefined passed explicitly", await settle(r.fetch("/q?page=x")));
  }

  const adapter = new BunHttpAdapter();
  adapter.get("/q", validate({ query: PageQuery }), (req, res) => res.json({ page: req.query.page }));
  log("R2f", "invalid, default 'next', BunHttpAdapter.fetch (adapter's final handler)", await show(await adapter.fetch("/q?page=x")));

  const withHandler = make();
  withHandler.use(((err: unknown, _req, res, _next) => {
    const e = err as { name: string; status: number; issues: unknown; targets: unknown };
    res.status(e.status).json({ name: e.name, targets: e.targets, issues: e.issues });
  }) satisfies import("@kingsleyweb/bun-common").RouterErrorMiddlewareHandler);
  log("R2g", "invalid, default 'next', app error handler reads ValidationError", await show(await withHandler.fetch("/q?page=x")));
}

/* R3: coercion is the schema's job, not BunValidate's. */
{
  const r = new BunRouter();
  r.get("/n", validate({ query: z.object({ page: z.number() }) }, { onFailure: "respond" }), (req, res) =>
    res.json({ page: req.query.page }),
  );
  log("R3", "query 'page=2' against z.number() (no coerce)", await show(await r.fetch("/n?page=2")));
}

/* R4: headers are validated, never written back. */
{
  const r = new BunRouter();
  r.get(
    "/h",
    validate({ headers: z.object({ "x-n": z.coerce.number() }) }, { onFailure: "respond" }),
    (req, res) => res.json({ raw: req.headers["x-n"], typeofRaw: typeof req.headers["x-n"] }),
  );
  log("R4a", "x-n: 5 against z.coerce.number()", await show(await r.fetch("/h", { headers: { "x-n": "5" } })));
  log("R4b", "x-n: five", await show(await r.fetch("/h", { headers: { "x-n": "five" } })));
}

/* R5: a target BunValidate does not know (cookies) is silently ignored at runtime. */
{
  const r = new BunRouter();
  const schemas = { cookies: z.object({ sid: z.string().min(10) }) } as unknown as Parameters<typeof validate>[0];
  r.get("/c", validate(schemas, { onFailure: "respond" }), (_req, res) => res.json({ reached: true }));
  log("R5", "validate({ cookies }) with a failing cookie", await show(await r.fetch("/c", { headers: { cookie: "sid=x" } })));
}

/* R6: params coercion is written back; body validated after parsing. */
{
  const r = new BunRouter();
  r.post(
    "/p/:id",
    validate({ params: z.object({ id: z.coerce.number() }), body: z.object({ title: z.string() }) }, { onFailure: "respond" }),
    (req, res) => res.json({ id: req.params.id, typeofId: typeof req.params.id, body: req.body }),
  );
  log("R6a", "params coerced, JSON body valid", await show(await r.fetch("/p/7", { method: "POST", body: JSON.stringify({ title: "t" }), headers: { "content-type": "application/json" } })));
  log("R6b", "both invalid: issues collected from every target", await show(await r.fetch("/p/x", { method: "POST", body: JSON.stringify({ title: 1 }), headers: { "content-type": "application/json" } })));
}

/* R7: bun-jobs' `s` schemas are Standard Schemas bun-common's validate() takes. */
{
  const r = new BunRouter();
  r.get("/s", validate({ query: s.query(s.object({ page: s.integer({ minimum: 1 }) })) }, { onFailure: "respond" }), (req, res) =>
    res.json({ page: req.query.page, typeofPage: typeof req.query.page }),
  );
  log("R7a", "s.query(s.object({ page: s.integer })) with page=3", await show(await r.fetch("/s?page=3")));
  log("R7b", "same, page=0", await show(await r.fetch("/s?page=0")));
  const probe = s.object({ a: s.string() });
  log("R7c", "s schema: ~standard.vendor, has ~standard.jsonSchema, has .json", {
    vendor: probe["~standard"].vendor,
    jsonSchema: "jsonSchema" in probe["~standard"],
    json: typeof probe.json,
  });
}

/* R8: job data is not validated anywhere: add anything, the worker receives it. */
{
  interface Email { to: string }
  const driver = new MemoryDriver();
  const namespace = `probe-${process.pid}`;
  const emails = new BunQueue<Email, string>("emails", { namespace, driver });
  const seen: unknown[] = [];
  const worker = new BunQueueWorker<Email, string>(
    "emails",
    async (job) => {
      seen.push(job.data);
      return `sent ${typeof job.data.to}`;
    },
    { namespace, driver },
  );
  const done = new Promise<unknown>((resolve) => worker.on("completed", (_job, result) => resolve(result)));
  void worker.run();
  // Cast: the type would refuse it, but a producer in another deployment, or the
  // management API's POST /queues/:queue/jobs, is not checked by this type.
  await emails.add("welcome", { to: 42 } as unknown as Email);
  const result = await done;
  await worker.close();
  log("R8", "job added with { to: 42 } for a BunQueue<{ to: string }>", { workerSaw: seen[0], result });
}

/* R9: are a validator's schemas reachable from the registered route (for OpenAPI / the route model)? */
{
  const mw = validate({ query: PageQuery });
  const r = new BunRouter();
  r.get("/doc", mw, (_req, res) => res.end());
  const route = r.routes().find((x) => x.path === "/doc");
  const cb = route?.callbacks?.[0] as unknown as Record<string, unknown> | undefined;
  log("R9", "own keys of validate()'s middleware; route callback is it; carries schemas", {
    keys: Reflect.ownKeys(mw).map(String),
    sameFn: cb === (mw as unknown),
    schemas: cb ? ["__schemas", "schemas", "__shape"].filter((k) => k in cb) : "no route",
  });
}

console.log(out.join("\n"));
process.exit(0);
