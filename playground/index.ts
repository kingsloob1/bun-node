/**
 * The bun-node playground: bun-jobs, its management API and the bun-jobs-ui
 * app on one BunHttpAdapter, with a live simulation behind them, for trying
 * things by hand and seeing how they look.
 *
 * ```bash
 * bun playground/index.ts                         # http://localhost:4000/jobs
 * PORT=3000 bun playground/index.ts               # another port
 * PLAYGROUND_DRIVER=sqlite bun playground/index.ts   # survives a restart
 * PLAYGROUND_DRIVER=memory bun playground/index.ts   # no disk, no summoning
 * PLAYGROUND_INTERVAL_MS=0 bun playground/index.ts   # seed only, then quiet
 * PLAYGROUND_SHARED_UNIT=mailer bun playground/index.ts  # uploads unit's controller on the mailer
 * cd playground && bun run dev                    # restart on file changes
 * ```
 *
 * See README.md for what is where. Everything is allowed: this API's
 * `authorize` says yes to every action, the opt-ins (`Add job`, `Edit`)
 * included, so it must never be exposed beyond your machine. It listens on
 * 127.0.0.1 only.
 */
import "reflect-metadata";
import process from "node:process";
import {
  BunHttpAdapter,
  defineRoutes,
  getPort,
  listRoutes,
  noopLogger,
  toJsonSchema,
  useClassDtos,
  validate,
} from "@kingsleyweb/bun-common";
import {
  docsRouter,
  generateAsyncApi,
  generateOpenApi,
} from "@kingsleyweb/bun-common/lib/docs";
import { plainToInstance } from "class-transformer";
import {
  IsInt,
  IsString,
  Min,
  validate as classValidate,
} from "class-validator";
import { targetConstructorToSchema } from "class-validator-jsonschema";
import {
  BunJobs,
  createDriver,
  createJobsApi,
  JOBS_API_ACTIONS,
} from "@kingsleyweb/bun-jobs";
import { jobsUi } from "@kingsleyweb/bun-jobs-ui";
import { docsUi } from "@kingsleyweb/bun-api-docs-ui";
import {
  isCrossProcess,
  playgroundBackend,
  playgroundDriver,
  removeTempData,
} from "./backend";
import { mountChatChannel } from "./chat";
import { startMailer } from "./mailer";
import { startFlows } from "./flows";
import { startRunners } from "./runners";
import { startSimulation } from "./simulation";
import { createSummoning } from "./summoning";

/**
 * The port to listen on (`PORT`, default 4000; `PORT=0` picks a free one
 * before listening).
 */
const port = Number(process.env.PORT ?? 4000) || (await getPort());
/** How often the simulation adds a job (`PLAYGROUND_INTERVAL_MS`, default 2000; 0 = never). */
const intervalMs = Number(process.env.PLAYGROUND_INTERVAL_MS ?? 2_000);

// A `temp` database, or a units log, a killed playground left behind.
removeTempData("stale");

/**
 * The one driver both contexts share. It is an instance, not a config: with
 * `memory` each context would otherwise build its own `Map`s and the two
 * services would not see each other's queues.
 */
const driver = createDriver(playgroundDriver());

// Summoning (`summoning.ts`): its `localCompute()` instances, and the summon
// groups and records naming them, exist before the context, whose `summon`
// option they are.
const summoning = await createSummoning({
  // What a summoned worker process opens: the same backend, as a config.
  driver: isCrossProcess() ? playgroundDriver() : undefined,
});

const jobs = new BunJobs({
  namespace: "playground",
  // Names this process in the worker inventory and in every worker's stable
  // key, so the Workers page groups by it: `api.emails`, `api.reports`, …
  service: "api",
  driver,
  // Every queue, worker and runner publishes its events, so the UI goes live.
  publishEvents: true,
  // Groups and records: every summoned queue, by `localCompute()` units.
  summon: summoning.summon,
  logger: noopLogger,
});

const simulation = await startSimulation(jobs, { intervalMs });
// A second service on the same backend, so the Workers page has two to group.
// With `PLAYGROUND_SHARED_UNIT=mailer` it also hosts the uploads shared
// unit's controller, which the API on this context then reads from storage.
const mailer = await startMailer({
  namespace: "playground",
  driver,
  logger: noopLogger,
  summon: summoning.mailerSummon,
});
const { stop: stopRunners } = await startRunners(jobs);
// A third service: the schema-checked digest flow (flows.ts), the only
// registry worker in the namespace.
const flows = await startFlows({
  namespace: "playground",
  driver,
  logger: noopLogger,
});

const api = createJobsApi({
  jobs,
  basePath: "/jobs-api",
  // A real host decides from a session; the playground allows everything.
  authorize: () => true,
  // Every action, the opt-in `jobs.add` and `jobs.update` included.
  actions: [...JOBS_API_ACTIONS],
  // `Add job` accepts any name.
  addableNames: "any",
  // The runner Trigger… dialog may pass arguments (see handlers/work.ts).
  runnerTriggerArgs: true,
  // The UI reads this from `api.info` and sends it on every mutation.
  csrf: { header: "x-bun-jobs-csrf" },
  // Failure panels show stack traces, and a worker's Target card shows the
  // processor file it runs (see targets.ts). Both are paths a real host may
  // prefer to keep to itself; the playground's are in this repo anyway.
  serialize: { exposeStacks: true, exposeProcessorFiles: true },
  // Queue state straight from the backend, so Pause shows at once.
  limits: { queueCacheMs: 0 },
  logger: noopLogger,
});
const ui = jobsUi({
  api,
  title: "bun-node playground",
  logger: noopLogger,
  // Always build the app from the source on disk. Unset, `jobsUi()` prefers a
  // prebuilt `dist/` whenever one exists — and packing the package (`prepack`,
  // which the consumer check runs) leaves one behind, so the playground then
  // served a stale snapshot and hid every UI change made after it.
  dev: true,
});

const app = new BunHttpAdapter();
// The summoned units' control page (`/playground/compute`) goes on this adapter.
summoning.mount(app);
// The validated chat channel (bun-validate V8, chat.ts): one `ws()` call —
// `app.ws(chat.path, chat.checks(), chat.handler(…), chat.options(…))` — at
// `/playground/chat/:room`.
mountChatChannel(app);
app.use(api.basePath, api.router);
app.use(ui.basePath, ui.router);
app.get("/", (_req, res) => res.redirect(ui.basePath));
// The playground's own small route group, declared through defineRoutes
// (AD (a2)): the property names are the routes' operationIds in the document
// below, with no .describe() annotation. Mounted as an ordinary sub-router.
// The playground's own small route group, declared through defineRoutes
// (AD (a2)): the property names are the routes' operationIds in the document
// below, with no .describe() annotation. Mounted as an ordinary sub-router.
//
// AD (b2): one DTO-validated endpoint. The class-validator /
// class-transformer surface is injected, never imported by bun-common;
// `useClassDtos` runs once here, before the validator is built, and the
// `toJsonSchema` injection is what the OpenAPI document reads for the DTO.
useClassDtos(
  { plainToInstance, validate: classValidate },
  { toJsonSchema: (cls) => targetConstructorToSchema(cls) },
);

/** The `/playground/dto-search` query: every wire value arrives as a string. */
class DtoSearchQuery {
  @IsInt()
  @Min(1)
  page!: number;

  @IsString()
  q!: string;
}

const playgroundRoutes = defineRoutes("/playground", (r) => ({
  // A class DTO on `query` (AD (b2)): "42" arrives as the number 42 on a
  // SearchQuery instance (implicit conversion), a failing query answers 400
  // with the issues, and the route documents itself in openapi.json.
  dtoSearch: r.get(
    "/dto-search",
    validate({ query: DtoSearchQuery }, { onFailure: "respond" }),
    (req, res) => {
      res.json({
        page: req.query.page,
        q: req.query.q,
        instance: req.query instanceof DtoSearchQuery,
      });
    },
  ),
  // The route model (bun-validate V12): every route on this adapter with the
  // contract it runs under — the jobs API's routes carry theirs (V4). Each
  // row's schema is shown converted to JSON Schema (AD (b)'s toJsonSchema —
  // the jobs API's `s` schemas carry `~standard.jsonSchema`, so they convert
  // on the primary path): requests with `input`, responses with `input` too,
  // except under `responseOutput: "parsed"` (then `output`). A row whose
  // schema converts to nothing gets `{}` and a warning, never an error.
  routes: r.get("/routes", (_req, res) => {
    res.json({
      routes: listRoutes(app).map((route) => ({
        ...route,
        contract:
          route.contract &&
          route.contract.entries.map(({ schema, ...row }) => ({
            ...row,
            jsonSchema:
              schema == null
                ? null
                : toJsonSchema(schema, {
                    direction:
                      row.side === "outbound" &&
                      route.responseOutput === "parsed"
                        ? "output"
                        : "input",
                  }),
          })),
      })),
    });
  }),
  // The OpenAPI document (AD (a)'s generateOpenApi) for everything mounted on
  // this adapter — the jobs API's routes document themselves from their
  // contracts; what cannot be expressed (a wildcard, an `all()` route) is a
  // warning, never an error.
  openapi: r.get("/openapi.json", (_req, res) => {
    const { document, warnings } = generateOpenApi(app, {
      title: "bun-node playground",
      version: "1.0.0",
    });
    res.json({ document, warnings });
  }),
}));
app.use(playgroundRoutes.mount, playgroundRoutes.router);
// The same document served by AD (c)'s docsRouter, with a viewer page: the
// thunk re-generates per request, so it is always the adapter as it is now;
// every docs route is `hidden`, so it never documents itself. The playground's
// auth is the API's `authorize: () => true` — everything is allowed — so the
// docs' authorizer does the same (a real host would decide from a session).
// Redoc rather than the Scalar default, to show a named viewer.
// The AsyncAPI half (AD (e)): the chat channel documents itself — the
// upgrade's room param, the frames in their envelope, the `say`→`said` reply,
// the implicit error frame.
app.use(
  "/playground/docs",
  docsRouter({
    openapi: () =>
      generateOpenApi(app, {
        title: "bun-node playground",
        version: "1.0.0",
      }).document,
    asyncapi: () =>
      generateAsyncApi(app, {
        title: "bun-node playground (events)",
        version: "1.0.0",
      }).document,
    viewer: { openapi: "redoc", asyncapi: "asyncapi" },
    authorize: (_req, _res, next) => next(),
  }),
);
// The same two documents in the self-hosted viewer (AD (f) F1): docsUi()
// bundles its own React app (nothing from a CDN, a strict self-only CSP),
// serving each thunk's document itself at <basePath>/document.json. `dev`
// rebuilds from the source on disk, for the same reason the jobs UI's does.
const apiDocs = docsUi({
  document: () =>
    generateOpenApi(app, {
      title: "bun-node playground",
      version: "1.0.0",
    }).document,
  basePath: "/playground/api-docs",
  logger: noopLogger,
  dev: true,
});
const wsDocs = docsUi({
  document: () =>
    generateAsyncApi(app, {
      title: "bun-node playground (events)",
      version: "1.0.0",
    }).document,
  basePath: "/playground/ws-docs",
  title: "bun-node playground (events)",
  logger: noopLogger,
  dev: true,
});
app.use(apiDocs.basePath, apiDocs.router);
app.use(wsDocs.basePath, wsDocs.router);
// The live-events socket, on the same port: `/meta` names its path.
api.websocket?.attach(app);

const server = await app.listen(port, "127.0.0.1");
const origin = `http://localhost:${server.port}`;
// The bursts of jobs for the summoned queues; and the control page's view of
// every queue's summon status, `GET /summon` read over loopback, so after
// `listen` (the URL needs the port). A GET needs no CSRF header.
await summoning.start(jobs, { summonList: `${origin}${api.basePath}/summon` });

console.log(`
bun-node playground (${playgroundBackend()} driver)

  UI            ${origin}${ui.basePath}
  Queues        ${origin}${ui.basePath}/queues
  Workers       ${origin}${ui.basePath}/workers
  Runners       ${origin}${ui.basePath}/runners
  Events        ${origin}${ui.basePath}/events
  API docs      ${origin}${ui.basePath}/docs
  Providers     ${origin}${ui.basePath}/providers
  Summoning     ${origin}${ui.basePath}/queues/renders, …/obinna-queue, …/ledger${isCrossProcess() ? "" : "   (off: the memory driver cannot summon)"}
  Shared unit   ${origin}${ui.basePath}/queues/ingest (uploads: ingest, captions, search-index; controller on the ${summoning.sharedUnitHost === "mailer" ? "mailer context, so this API shows it read-only" : "main context"})
  Units/faults  ${origin}${summoning.basePath}
  API           ${origin}${api.basePath}/meta
  API reference ${origin}/playground/docs  (docsRouter: the adapter's live OpenAPI document + a Redoc page; the chat channel's AsyncAPI document at /playground/docs/asyncapi.json, its viewer at /playground/docs/asyncapi)
  Self-hosted  ${origin}/playground/api-docs  (bun-api-docs-ui: the same OpenAPI document, bundled viewer, no CDN)  ·  events: ${origin}/playground/ws-docs
  Class DTO     ${origin}/playground/dto-search?q=bun&page=42  (a class-validator DTO on query — try page=0)
  Chat channel  ws://localhost:${server.port}/playground/chat/lobby?name=ada  (V8's defineChannel: {"type":"say","data":{"text":"hi"}}; a bad room is a 400)

  A job is added every ${intervalMs > 0 ? `${intervalMs} ms` : "— never (PLAYGROUND_INTERVAL_MS=0)"}. Ctrl+C to stop.
`);

let stopping = false;
/**
 * Stops everything cleanly, once. Whatever fails on the way, the `finally`
 * still removes this run's own files (the `temp` database, the units log) and
 * exits; the units and the cgroup are `summoning.stop()`'s, first of all.
 */
async function shutdown(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  console.log("\nstopping…");
  let code = 0;
  try {
    // First, every summoned worker process, awaited to its exit: the units
    // are what must not outlive the playground, and they need the backend
    // open until they have closed their workers.
    const units = await summoning.stop();
    console.log(
      `waited for ${units} summoned unit${units === 1 ? "" : "s"} to exit`,
    );
    await simulation.stop();
    await mailer.stop();
    await flows.stop();
    await stopRunners();
    await api.close();
    await app.close();
    await jobs.close();
  } catch (error) {
    code = 1;
    console.error("playground: stopping failed:", error);
  } finally {
    removeTempData("mine");
    process.exit(code);
  }
}
// SIGHUP too (a closed terminal): `localCompute()`'s guard listens for it,
// and as that signal's only listener it would stop the units and re-raise
// it, ending the process without this shutdown. Every unit is killed on
// `exit` by the guard as well, however the process ends (short of SIGKILL).
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => void shutdown());
}
