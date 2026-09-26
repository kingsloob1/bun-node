import type {
  BunRunner,
  BunRunnerOptions,
  DriverConfig,
  JobsDriver,
} from "@kingsleyweb/bun-jobs";
import type { FetchLike } from "../../../app/api/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  JOBS_API_ACTIONS,
  MemoryDriver,
  SqlDriver,
} from "@kingsleyweb/bun-jobs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { GATES } from "./fixtures/clear-actions/gated-runner";

/**
 * The runner screen's "Settings…" editor (`PUT` / `DELETE
 * /runners/:runner/config`) against a REAL `createJobsApi` over real runners:
 * the one feature of its round built only against mocked HTTP. It proves the
 * dialog opens on the owner's real configuration, sends exactly the merge
 * patch the API expects, that the owner adopts what it stores (and really
 * runs with it), that a mode the code does not permit is neither offered nor
 * accepted, how an override the owner refuses at adoption reads on the
 * summary, the opt-in gate, and a runner registered in another context.
 *
 * Each deployment — memory, and SQLite in a temp dir — has four contexts
 * sharing ONE driver: `api`, which serves the API and owns the local runners;
 * `remote`, owning a runner the API knows only through the store; and `old`
 * and `renewed`, the same runner before and after a redeploy that changed its
 * code (two contexts, so the API never resolves a stopped instance as local).
 *
 * The API is created with `actions: [...JOBS_API_ACTIONS]`, so the opt-in
 * `runners.configure` is served; a second one over the same context keeps the
 * default actions, which leave it out.
 *
 * Compiled without the DOM lib (see tsconfig.json): the DOM side is loaded by
 * dynamic imports the compiler does not follow, and the interfaces below
 * restate the little this file uses of them. Each scenario owns its runner,
 * so the suite passes under `bun test --randomize`.
 */

/** What this file uses of `../dom`. */
interface DomModule {
  /** Registers happy-dom and the per-test cleanup. */
  setupDom: () => void;
}

/** What this file uses of `../register-dom`. */
interface RegisterDomModule {
  /** Bun's own networking globals, captured before happy-dom replaced them. */
  native: { Request: typeof Request; Response: typeof Response };
}

/** One summary row (`../runners/realApiConfig`' `SummaryRow`). */
interface SummaryRow {
  /** The row's value, without its hint. */
  value: string;
  /** The hint's text, or `null`. */
  hint: string | null;
}

/** What the runner screen shows (`ConfigScreenView`). */
interface ConfigScreenView {
  /** Whether "Settings…" is offered. */
  settingsOffered: boolean;
  /** Whether the "Runner actions" group is rendered. */
  hasActionGroup: boolean;
  /** The summary rows the editor touches. */
  summary: {
    /** "Execution mode". */
    executionMode: SummaryRow | null;
    /** "Run mode". */
    runMode: SummaryRow | null;
    /** "Max concurrency". */
    maxConcurrency: SummaryRow | null;
    /** "Settings override". */
    override: SummaryRow | null;
  };
}

/** What the open dialog shows (`ConfigDialogView`). */
interface ConfigDialogView {
  /** The execution mode picker's option values. */
  modeOptions: string[];
  /** The execution mode selected. */
  executionMode: string;
  /** The run mode selected. */
  runMode: string;
  /** The cap field's raw value. */
  maxConcurrency: string;
  /** Whether the cap field is disabled. */
  capDisabled: boolean;
  /** The two "where this comes from" lines. */
  sources: { executionMode: string; concurrency: string };
  /** The "not offered" note, or `null`. */
  modesLimited: string | null;
  /** The "owner refused" note, or `null`. */
  refused: string | null;
  /** The "not adopted yet" note, or `null`. */
  pending: string | null;
  /** The field hints. */
  hints: { executionMode: string; runMode: string; maxConcurrency: string };
  /** Whether "Save settings" is disabled. */
  saveDisabled: boolean;
  /** Whether "Reset to code defaults" is offered. */
  resetOffered: boolean;
  /** The problem banner's text, or `null`. */
  banner: string | null;
}

/** What a dialog write resolves. */
interface Submitted {
  /** Whether the dialog closed. */
  closed: boolean;
  /** The success toasts' text. */
  toast: string;
  /** The banner's text when it stayed open. */
  banner: string | null;
}

/** The open dialog's driver (`ConfigDialogDriver`). */
interface ConfigDialogDriver {
  /** What it shows now. */
  view: () => ConfigDialogView;
  /** Picks an execution mode. */
  setExecutionMode: (mode: string) => void;
  /** Picks a run mode. */
  setRunMode: (mode: string) => void;
  /** Types a cap. */
  setMaxConcurrency: (value: string) => void;
  /** Clicks one setting's "Use the code default". */
  pickCodeDefault: (which: "execution-mode" | "concurrency") => void;
  /** Clicks "Save settings". */
  save: () => Promise<Submitted>;
  /** Clicks "Reset to code defaults". */
  reset: () => Promise<Submitted>;
  /** Clicks Cancel. */
  cancel: () => Promise<void>;
}

/** What this file uses of `../runners/realApiConfig`. */
interface ConfigModule {
  /** Renders the app on a runner's screen. */
  mountRunnerConfig: (
    fetch: FetchLike,
    csrfHeader: string,
    id: string,
  ) => Promise<{
    view: () => ConfigScreenView;
    awaitView: (
      ready: (view: ConfigScreenView) => boolean,
      timeoutMs?: number,
    ) => Promise<ConfigScreenView>;
    openSettings: () => Promise<ConfigDialogDriver>;
    refresh: () => Promise<void>;
    unmount: () => void;
  }>;
}

/** One request made through a deployment's fetch, with what the API answered. */
interface Exchange {
  /** The method. */
  method: string;
  /** The path under the API's base, without the query. */
  path: string;
  /** The CSRF header's value, or `null`. */
  csrf: string | null;
  /** The request body as sent, or `undefined`. */
  body: string | undefined;
  /** The status the API answered with. */
  status: number;
  /** The parsed answer, for a JSON body. */
  json: unknown;
  /** Whether the test made it directly, rather than the UI. */
  direct: boolean;
  /** Which API answered: with `runners.configure`, or the default actions. */
  api: "full" | "default";
}

/** `RunnerConfigDto`, as the API answers it. */
interface ConfigDto {
  /** What the owner runs with. */
  effective: {
    executionMode: string;
    runMode: string;
    maxConcurrency: number | null;
  };
  /** What the owner's code asks for. */
  code?: {
    executionMode: string;
    runMode: string;
    maxConcurrency: number | null;
  };
  /** The overridden settings. */
  overridden: string[];
  /** The modes an override may choose. */
  allowed?: string[];
  /** The override's version. */
  seq: number;
  /** The version the owner adopted. */
  appliedSeq?: number;
  /** Why the owner refused part of it. */
  error?: { at: number; message: string };
}

/** One deployment under test. */
interface Deployment {
  /** How it is named in the test titles. */
  label: string;
  /** The driver every context shares. */
  driver: JobsDriver;
  /** A driver config a child could reach the same backend with. */
  childDriver: DriverConfig;
  /** Whether the backend pushes `control` events (so `control: "auto"` subscribes). */
  pushes: boolean;
  /** The context serving the API and owning the local runners. */
  api: BunJobs;
  /** The context owning the remote runner. */
  remote: BunJobs;
  /** The redeploy scenarios' "before" context. */
  old: BunJobs;
  /** The redeploy scenarios' "after" context. */
  renewed: BunJobs;
  /** The fetch into the API that serves `runners.configure`. */
  fetch: FetchLike;
  /** The fetch into an API with the default actions (no opt-ins). */
  defaults: FetchLike;
  /** Every request made through either fetch, oldest first. */
  exchanges: Exchange[];
  /** Every runner started, stopped in `afterAll`. */
  runners: BunRunner[];
}

/** Imports a module by a specifier the compiler does not resolve. */
function load<T>(specifier: string): Promise<T> {
  return import(specifier) as Promise<T>;
}

const dom = await load<DomModule>(["..", "dom"].join("/"));
const { native } = await load<RegisterDomModule>(
  ["..", "register-dom"].join("/"),
);
dom.setupDom();

const CSRF = "x-bun-jobs-csrf";
const BASE = "/jobs-api";
const RUNNER_FILE = join(
  import.meta.dir,
  "fixtures",
  "clear-actions",
  "gated-runner.ts",
);
/** Each scenario renders the whole app over real reads. */
const TEST_TIMEOUT_MS = 30_000;
/** The SQLite remote runner's sync: no `control` subscription there under `"auto"`. */
const POLLED_SYNC_MS = 300;

/** The gates held runs wait on, shared with the in-process runner. */
const gates = new Map<string, Promise<void>>();
const releases = new Map<string, () => void>();

/** Creates the gate `name`. */
function gate(name: string): string {
  gates.set(
    name,
    new Promise<void>((resolve) => {
      releases.set(name, resolve);
    }),
  );
  return name;
}

/** Opens the gate `name`. */
function release(name: string): void {
  releases.get(name)?.();
}

let tmp: string;
const deployments: Deployment[] = [];
/** Set while the test itself makes a request, so it is not taken for the UI's. */
let directCall = false;

/**
 * Runs `fn` with Bun's `Response` as the global: the API builds its
 * responses from the global, which happy-dom has replaced.
 */
async function withBunGlobals<T>(fn: () => Promise<T>): Promise<T> {
  const saved = globalThis.Response;
  globalThis.Response = native.Response;
  try {
    return await fn();
  } finally {
    globalThis.Response = saved;
  }
}

/** Resolves once `check` holds, reporting `what` if it never does. */
async function until(
  check: () => boolean | Promise<boolean>,
  what: () => string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out: ${what()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Mounts an API over `jobs` and returns the recording fetch shim into it. */
function mountApi(
  jobs: BunJobs,
  exchanges: Exchange[],
  which: Exchange["api"],
): FetchLike {
  const api = createJobsApi({
    jobs,
    mode: "both",
    basePath: BASE,
    authorize: () => true,
    logger: noopLogger,
    csrf: { header: CSRF },
    ...(which === "full" ? { actions: [...JOBS_API_ACTIONS] } : {}),
  });
  const root = new BunRouter();
  root.use(api.basePath, api.router);
  // The app's AbortSignal is happy-dom's, which Bun's Request refuses.
  return async (input, { signal: _signal, ...init }) =>
    withBunGlobals(async () => {
      const url = new URL(input, "http://localhost");
      const request = new native.Request(url.href, init);
      const csrf = request.headers.get(CSRF);
      const response = await root.fetch(request);
      const text = await response.text();
      let json: unknown;
      try {
        json = text === "" ? undefined : JSON.parse(text);
      } catch {
        json = undefined;
      }
      exchanges.push({
        method: request.method,
        path: url.pathname.slice(BASE.length),
        csrf,
        body: typeof init.body === "string" ? init.body : undefined,
        status: response.status,
        json,
        direct: directCall,
        api: which,
      });
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      });
    });
}

/** A request the test makes itself, with the CSRF header. */
async function direct(
  deployment: Deployment,
  method: string,
  path: string,
  body?: unknown,
  via: FetchLike = deployment.fetch,
): Promise<{ status: number; json: unknown }> {
  directCall = true;
  try {
    const response = await via(`${BASE}${path}`, {
      method,
      headers: {
        [CSRF]: "1",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  } finally {
    directCall = false;
  }
}

/** The runner's configuration, as `GET /runners/:runner` reports it. */
async function configOf(
  deployment: Deployment,
  id: string,
): Promise<ConfigDto> {
  const { status, json } = await direct(deployment, "GET", `/runners/${id}`);
  expect(`${id} ${status}`).toBe(`${id} 200`);
  return (json as { config: ConfigDto }).config;
}

/** Every write the UI sent to `/runners/:id/config`. */
function uiConfigWrites(deployment: Deployment, id: string): Exchange[] {
  return deployment.exchanges.filter(
    (one) =>
      !one.direct &&
      one.method !== "GET" &&
      one.path === `/runners/${id}/config`,
  );
}

/** Every write the UI sent, to anything, since exchange `from`. */
function uiWritesSince(deployment: Deployment, from: number): Exchange[] {
  return deployment.exchanges
    .slice(from)
    .filter((one) => !one.direct && one.method !== "GET");
}

/** Starts a runner in `jobs` over the gated fixture. */
async function startRunner(
  deployment: Deployment,
  jobs: BunJobs,
  id: string,
  options: Partial<Omit<BunRunnerOptions, "id" | "namespace" | "driver">> = {},
): Promise<BunRunner> {
  const runner = jobs.runner({
    id,
    name: id,
    file: RUNNER_FILE,
    executionMode: "in-process",
    waitToExit: false,
    logger: noopLogger,
    ...options,
  });
  await runner.start();
  deployment.runners.push(runner);
  if (jobs !== deployment.api) {
    // The API's context learns of a runner elsewhere through the store.
    let last: { status: number; json: unknown } | undefined;
    await until(
      async () => {
        last = await direct(deployment, "GET", `/runners/${id}`);
        return last.status === 200;
      },
      () =>
        `${deployment.label}: the API never discovered ${id}: ${JSON.stringify(last)}`,
    );
  }
  return runner;
}

/** Triggers a held run on `runner` and waits for it to be recorded running. */
async function hold(runner: BunRunner, name: string): Promise<string> {
  const outcome = await runner.trigger({ args: { hold: gate(name) } });
  if (outcome.outcome !== "started") {
    throw new Error(`${runner.id}: trigger ${JSON.stringify(outcome)}`);
  }
  const { runId } = outcome;
  await until(
    async () =>
      (await runner.history()).find((one) => one.runId === runId)?.status ===
      "running",
    () => `${runner.id}: run ${runId} never recorded`,
  );
  return runId;
}

/** Waits until every run of `runner` has settled. */
async function settled(runner: BunRunner) {
  await until(
    async () =>
      (await runner.history()).every((one) => one.status !== "running"),
    () => `${runner.id}: a run never settled`,
  );
}

/** Builds a deployment over `driver` (see the file's comment). */
function populate(
  label: string,
  driver: JobsDriver,
  childDriver: DriverConfig,
  pushes: boolean,
  namespace: string,
): Deployment {
  const context = (service: string) =>
    new BunJobs({ namespace, service, driver, logger: noopLogger });
  const api = context("api");
  const exchanges: Exchange[] = [];
  const deployment: Deployment = {
    label,
    driver,
    childDriver,
    pushes,
    api,
    remote: context("remote"),
    old: context("old"),
    renewed: context("renewed"),
    fetch: mountApi(api, exchanges, "full"),
    defaults: mountApi(api, exchanges, "default"),
    exchanges,
    runners: [],
  };
  deployments.push(deployment);
  return deployment;
}

beforeAll(() => {
  (globalThis as Record<symbol, unknown>)[GATES] = gates;
  tmp = mkdtempSync(join(tmpdir(), "bun-jobs-ui-config-"));
  populate(
    "memory",
    new MemoryDriver(),
    { type: "memory" },
    true,
    "ui-config-memory",
  );
  const url = `sqlite://${join(tmp, "config.db")}`;
  populate(
    "SQLite",
    new SqlDriver({ url }),
    { type: "sql", url },
    false,
    "ui-config-sqlite",
  );
});

afterAll(async () => {
  for (const open of releases.values()) {
    open();
  }
  for (const deployment of deployments) {
    for (const runner of deployment.runners) {
      await runner.stop({ force: true }).catch(() => undefined);
    }
    // The contexts share one driver, which the first to close closes.
    for (const jobs of [
      deployment.renewed,
      deployment.old,
      deployment.remote,
      deployment.api,
    ]) {
      await jobs.close().catch(() => undefined);
    }
  }
  if ((globalThis as Record<symbol, unknown>)[GATES] === gates) {
    delete (globalThis as Record<symbol, unknown>)[GATES];
  }
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/** Loads the runner screen's harness. */
function harness(): Promise<ConfigModule> {
  return load<ConfigModule>(["..", "runners", "realApiConfig"].join("/"));
}

/** The deployment named `label`. */
function deployment(label: string): Deployment {
  return deployments.find((one) => one.label === label)!;
}

for (const label of ["memory", "SQLite"]) {
  describe(`the runner Settings… editor against a real API (${label})`, () => {
    it(
      "opens on the owner's real configuration and offers only the modes its code permits",
      async () => {
        const deploy = deployment(label);
        const id = "cfg-view";
        await startRunner(deploy, deploy.api, id, {
          childDriver: deploy.childDriver,
          allowedOverrides: { executionModes: ["in-process", "worker-thread"] },
        });
        const config = await configOf(deploy, id);
        expect(config).toMatchObject({
          effective: { executionMode: "in-process", runMode: "single" },
          code: { executionMode: "in-process", runMode: "single" },
          overridden: [],
          allowed: ["worker-thread", "in-process"],
          seq: 0,
        });
        expect(config.error).toBeUndefined();

        const ui = await (
          await harness()
        ).mountRunnerConfig(deploy.fetch, CSRF, id);
        const screen = await ui.awaitView((view) => view.settingsOffered);
        expect(screen.summary.override).toEqual({
          value: "None: as the runner's code asks",
          hint: null,
        });
        expect(screen.summary.executionMode).toEqual({
          value: "in-process",
          hint: null,
        });
        expect(screen.summary.runMode).toEqual({ value: "single", hint: null });

        const dialog = await ui.openSettings();
        const view = dialog.view();
        // `allowed` is what is offered: child-process is not, and the note says why.
        expect(view.modeOptions).toEqual(["worker-thread", "in-process"]);
        expect(view.modesLimited).toContain(
          "child-process is not offered: this runner's code permits only worker-thread, in-process",
        );
        expect(view.executionMode).toBe("in-process");
        expect(view.runMode).toBe("single");
        // The cap means nothing under single.
        expect(view.capDisabled).toBe(true);
        expect(view.hints.maxConcurrency).toContain("Only applies in parallel");
        expect(view.hints.executionMode).toContain(
          "This runner's code asks for in-process.",
        );
        expect(view.hints.runMode).toContain(
          "This runner's code asks for single.",
        );
        expect(view.sources).toEqual({
          executionMode: "Execution mode: as the runner's code asks.",
          concurrency:
            "Run mode and max concurrency: as the runner's code asks.",
        });
        expect(view.pending).toBeNull();
        expect(view.refused).toBeNull();
        expect(view.resetOffered).toBe(false);
        expect(view.saveDisabled).toBe(true);
        // Parallel enables the cap.
        dialog.setRunMode("parallel");
        expect(dialog.view().capDisabled).toBe(false);
        await dialog.cancel();
        ui.unmount();
        expect(uiConfigWrites(deploy, id)).toEqual([]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "saves parallel with a cap of 3 as one merge patch, the owner adopts it, and runs overlap up to 3",
      async () => {
        const deploy = deployment(label);
        const id = "cfg-parallel";
        const runner = await startRunner(deploy, deploy.api, id);

        // Under the code's single, a second run while one is held is refused.
        const first = `${label}:${id}:single`;
        await hold(runner, first);
        const refused = await runner.trigger({});
        expect(refused.outcome).toBe("skipped");
        release(first);
        await settled(runner);

        const before = await configOf(deploy, id);
        const ui = await (
          await harness()
        ).mountRunnerConfig(deploy.fetch, CSRF, id);
        await ui.awaitView((view) => view.settingsOffered);
        const dialog = await ui.openSettings();
        dialog.setRunMode("parallel");
        dialog.setMaxConcurrency("3");
        expect(dialog.view().saveDisabled).toBe(false);
        const saved = await dialog.save();
        expect(saved.closed).toBe(true);
        expect(saved.toast).toContain(`Saved the settings of ${id}`);
        expect(saved.toast).not.toContain("adopts them at its next sync");

        // Exactly one write: the merge patch, and nothing else.
        const writes = uiConfigWrites(deploy, id);
        expect(writes).toHaveLength(1);
        const put = writes[0]!;
        expect(put.method).toBe("PUT");
        expect(put.csrf).toBe("1");
        expect(JSON.parse(put.body!)).toEqual({
          concurrency: { runMode: "parallel", maxConcurrency: 3 },
        });
        expect(put.status).toBe(200);
        const answer = put.json as ConfigDto;
        expect(answer).toMatchObject({
          effective: {
            executionMode: "in-process",
            runMode: "parallel",
            maxConcurrency: 3,
          },
          code: before.code!,
          overridden: ["runMode", "maxConcurrency"],
        });
        expect(answer.seq).toBeGreaterThan(before.seq);
        // A local owner adopts at once.
        expect(answer.appliedSeq).toBe(answer.seq);
        expect(answer.error).toBeUndefined();
        expect(runner.config).toMatchObject({
          effective: { runMode: "parallel", maxConcurrency: 3 },
          seq: answer.seq,
          appliedSeq: answer.seq,
        });

        // The summary re-read the runner and marks both overrides.
        const codeCap =
          before.code!.maxConcurrency === null
            ? "unlimited"
            : String(before.code!.maxConcurrency);
        const after = await ui.awaitView(
          (view) => view.summary.runMode?.value === "parallel",
        );
        expect(after.summary.runMode).toEqual({
          value: "parallel",
          hint: "Overridden here; its code asks for single",
        });
        expect(after.summary.maxConcurrency).toEqual({
          value: "3",
          hint: `Overridden here; its code asks for ${codeCap}`,
        });
        expect(after.summary.executionMode?.hint).toBeNull();
        expect(after.summary.override).toEqual({
          value: "Run mode, Max concurrency",
          hint: null,
        });
        ui.unmount();

        // And the owner really runs with it: three overlap, a fourth is
        // refused by the cap.
        const held = [1, 2, 3].map((n) => `${label}:${id}:parallel-${n}`);
        for (const name of held) {
          await hold(runner, name);
        }
        expect(
          (await runner.history()).filter((one) => one.status === "running"),
        ).toHaveLength(3);
        expect(await runner.trigger({})).toEqual({
          outcome: "skipped",
          reason: "max-concurrency",
        });
        for (const name of held) {
          release(name);
        }
        await settled(runner);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "sends null for a setting put back to its code default, and DELETE for Reset to code defaults",
      async () => {
        const deploy = deployment(label);
        const id = "cfg-reset";
        const runner = await startRunner(deploy, deploy.api, id, {
          childDriver: deploy.childDriver,
        });
        const seeded = await direct(deploy, "PUT", `/runners/${id}/config`, {
          executionMode: "worker-thread",
          concurrency: { runMode: "parallel", maxConcurrency: 2 },
        });
        expect(seeded.status).toBe(200);
        expect(seeded.json).toMatchObject({
          effective: {
            executionMode: "worker-thread",
            runMode: "parallel",
            maxConcurrency: 2,
          },
          overridden: ["executionMode", "runMode", "maxConcurrency"],
        });
        const code = (seeded.json as ConfigDto).code!;

        const module = await harness();
        const ui = await module.mountRunnerConfig(deploy.fetch, CSRF, id);
        await ui.awaitView((view) => view.settingsOffered);
        const dialog = await ui.openSettings();
        expect(dialog.view()).toMatchObject({
          executionMode: "worker-thread",
          runMode: "parallel",
          maxConcurrency: "2",
          resetOffered: true,
          sources: {
            executionMode:
              "Execution mode: overridden here.Use the code default",
            concurrency:
              "Run mode and max concurrency: overridden here.Use the code default",
          },
        });
        dialog.pickCodeDefault("concurrency");
        const cleared = await dialog.save();
        expect(cleared.closed).toBe(true);

        const writes = uiConfigWrites(deploy, id);
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({
          method: "PUT",
          csrf: "1",
          status: 200,
        });
        expect(JSON.parse(writes[0]!.body!)).toEqual({ concurrency: null });
        const afterNull = writes[0]!.json as ConfigDto;
        expect(afterNull.overridden).toEqual(["executionMode"]);
        expect(afterNull.effective).toEqual({
          executionMode: "worker-thread",
          runMode: code.runMode,
          maxConcurrency: code.maxConcurrency,
        });
        expect(afterNull.appliedSeq).toBe(afterNull.seq);
        const partly = await ui.awaitView(
          (view) => view.summary.runMode?.value === code.runMode,
        );
        expect(partly.summary.runMode?.hint).toBeNull();
        expect(partly.summary.executionMode).toEqual({
          value: "worker-thread",
          hint: `Overridden here; its code asks for ${code.executionMode}`,
        });

        const again = await ui.openSettings();
        const reset = await again.reset();
        expect(reset.closed).toBe(true);
        expect(reset.toast).toContain(`Reset ${id} to its code defaults`);
        const both = uiConfigWrites(deploy, id);
        expect(both).toHaveLength(2);
        expect(both[1]).toMatchObject({
          method: "DELETE",
          csrf: "1",
          body: undefined,
          status: 200,
        });
        const afterReset = both[1]!.json as ConfigDto;
        expect(afterReset.overridden).toEqual([]);
        expect(afterReset.effective).toEqual(code);
        expect(afterReset.seq).toBeGreaterThan(afterNull.seq);
        expect(afterReset.appliedSeq).toBe(afterReset.seq);
        // What the owner itself now runs with (typed wider, as the DTO is).
        const owned: ConfigDto["effective"] = runner.config.effective;
        expect(owned).toEqual(code);
        const back = await ui.awaitView(
          (view) =>
            view.summary.override?.value === "None: as the runner's code asks",
        );
        expect(back.summary.executionMode).toEqual({
          value: code.executionMode,
          hint: null,
        });
        ui.unmount();
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "refuses a mode outside `allowed` with 409 CONFIG_NOT_ALLOWED, and explains it when the dialog reaches it",
      async () => {
        const deploy = deployment(label);

        // A runner whose code permits two modes.
        const limited = "cfg-limited";
        await startRunner(deploy, deploy.api, limited, {
          childDriver: deploy.childDriver,
          allowedOverrides: { executionModes: ["in-process", "worker-thread"] },
        });
        const childProcess = await direct(
          deploy,
          "PUT",
          `/runners/${limited}/config`,
          { executionMode: "child-process" },
        );
        expect(childProcess.status).toBe(409);
        expect(childProcess.json).toMatchObject({
          code: "CONFIG_NOT_ALLOWED",
          context: {
            runner: limited,
            executionMode: "child-process",
            allowed: ["worker-thread", "in-process"],
          },
        });
        expect((childProcess.json as { detail: string }).detail).toContain(
          "it permits worker-thread, in-process",
        );
        expect((await configOf(deploy, limited)).seq).toBe(0);

        // A runner built from a driver INSTANCE, its code permitting every
        // mode: `worker-thread` is refused up front, since it could not adopt it.
        const instance = "cfg-instance";
        await startRunner(deploy, deploy.api, instance);
        expect((await configOf(deploy, instance)).allowed).toEqual([
          "in-process",
        ]);
        const workerThread = await direct(
          deploy,
          "PUT",
          `/runners/${instance}/config`,
          { executionMode: "worker-thread" },
        );
        expect(workerThread.status).toBe(409);
        expect(workerThread.json).toMatchObject({
          code: "CONFIG_NOT_ALLOWED",
          context: { executionMode: "worker-thread", allowed: ["in-process"] },
        });

        // Reached from the dialog: opened while the owner permitted child-process,
        // saved after a redeploy narrowed its code to in-process.
        const narrowed = "cfg-narrowed";
        const before = await startRunner(deploy, deploy.old, narrowed, {
          childDriver: deploy.childDriver,
        });
        const ui = await (
          await harness()
        ).mountRunnerConfig(deploy.fetch, CSRF, narrowed);
        await ui.awaitView((view) => view.settingsOffered);
        const dialog = await ui.openSettings();
        expect(dialog.view().modeOptions).toEqual([
          "child-process",
          "worker-thread",
          "in-process",
        ]);
        expect(dialog.view().modesLimited).toBeNull();
        dialog.setExecutionMode("child-process");
        await before.stop({ force: true });
        await startRunner(deploy, deploy.renewed, narrowed, {
          allowedOverrides: { executionModes: ["in-process"] },
        });
        expect((await configOf(deploy, narrowed)).allowed).toEqual([
          "in-process",
        ]);
        const saved = await dialog.save();
        expect(saved.closed).toBe(false);
        expect(saved.banner).toContain("CONFIG_NOT_ALLOWED");
        expect(saved.banner).toContain(
          "The runner's own code does not permit that setting",
        );
        const writes = uiConfigWrites(deploy, narrowed);
        expect(writes).toHaveLength(1);
        expect(JSON.parse(writes[0]!.body!)).toEqual({
          executionMode: "child-process",
        });
        expect(writes[0]).toMatchObject({
          status: 409,
          json: {
            code: "CONFIG_NOT_ALLOWED",
            context: {
              executionMode: "child-process",
              allowed: ["in-process"],
            },
          },
        });
        await dialog.cancel();
        ui.unmount();
        const stored = await configOf(deploy, narrowed);
        expect(stored.overridden).toEqual([]);
        expect(stored.effective.executionMode).toBe("in-process");
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "words an override the owner refused at adoption as refused, not as in force",
      async () => {
        const deploy = deployment(label);
        const id = "cfg-refused";
        // Before: an owner with a driver config for its children adopts
        // `worker-thread` (and a parallel cap).
        const before = await startRunner(deploy, deploy.old, id, {
          childDriver: deploy.childDriver,
          ...(deploy.pushes ? {} : { syncInterval: POLLED_SYNC_MS }),
        });
        const written = await direct(deploy, "PUT", `/runners/${id}/config`, {
          executionMode: "worker-thread",
          concurrency: { runMode: "parallel", maxConcurrency: 2 },
        });
        expect(written.status).toBe(200);
        await until(
          () => before.config.appliedSeq === (written.json as ConfigDto).seq,
          () =>
            `${label}: the first owner never adopted: ${JSON.stringify(before.config)}`,
        );
        expect(before.config.effective).toEqual({
          executionMode: "worker-thread",
          runMode: "parallel",
          maxConcurrency: 2,
        });

        // After a redeploy, the runner is built from a driver instance: it
        // cannot hand a Worker a backend, so it refuses the stored `worker-thread`
        // and keeps the concurrency override.
        await before.stop({ force: true });
        await startRunner(deploy, deploy.renewed, id);
        const config = await configOf(deploy, id);
        expect(config).toMatchObject({
          effective: {
            executionMode: "in-process",
            runMode: "parallel",
            maxConcurrency: 2,
          },
          code: { executionMode: "in-process", runMode: "single" },
          overridden: ["executionMode", "runMode", "maxConcurrency"],
          allowed: ["in-process"],
          appliedSeq: config.seq,
          error: {
            message:
              'executionMode "worker-thread" needs a driver config for the child, and this runner was built from a driver instance',
            // The owner names what it refused; the concurrency override it
            // adopted is not listed.
            keys: ["executionMode"],
          },
        });

        const ui = await (
          await harness()
        ).mountRunnerConfig(deploy.fetch, CSRF, id);
        const view = await ui.awaitView((one) => one.settingsOffered);
        expect(view.summary.executionMode).toEqual({
          value: "in-process",
          hint: "Override refused by the owner; it runs what its code asks for, in-process",
        });
        expect(view.summary.runMode).toEqual({
          value: "parallel",
          hint: "Overridden here; its code asks for single",
        });
        expect(view.summary.override).toEqual({
          value: "Execution mode, Run mode, Max concurrency",
          hint: `The owner refused Execution mode: ${config.error!.message}`,
        });
        const dialog = await ui.openSettings();
        expect(dialog.view().refused).toContain(
          `The owner refused Execution mode`,
        );
        expect(dialog.view().refused).toContain(config.error!.message);
        expect(dialog.view().modeOptions).toEqual(["in-process"]);
        await dialog.cancel();
        ui.unmount();
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "offers no Settings… and writes nothing when `runners.configure` is left out of `actions`",
      async () => {
        const deploy = deployment(label);
        const id = "cfg-gated";
        await startRunner(deploy, deploy.api, id);
        const permissions = async (via: FetchLike) =>
          (
            (await direct(deploy, "GET", "/meta/permissions", undefined, via))
              .json as { actions: Record<string, boolean> }
          ).actions;
        expect((await permissions(deploy.fetch))["runners.configure"]).toBe(
          true,
        );
        const restricted = await permissions(deploy.defaults);
        expect("runners.configure" in restricted).toBe(false);
        expect(restricted["runners.trigger"]).toBe(true);

        // The control: over the full API it is offered.
        const module = await harness();
        const offered = await module.mountRunnerConfig(deploy.fetch, CSRF, id);
        await offered.awaitView((view) => view.settingsOffered);
        offered.unmount();

        const from = deploy.exchanges.length;
        const ui = await module.mountRunnerConfig(deploy.defaults, CSRF, id);
        const view = ui.view();
        expect(view.hasActionGroup).toBe(true);
        expect(view.settingsOffered).toBe(false);
        // The summary still reports the configuration (a read).
        expect(view.summary.override?.value).toBe(
          "None: as the runner's code asks",
        );
        ui.unmount();
        const sent = deploy.exchanges.slice(from);
        expect(sent.length).toBeGreaterThan(0);
        expect(sent.every((one) => one.api === "default")).toBe(true);
        expect(uiWritesSince(deploy, from)).toEqual([]);

        for (const [method, body] of [
          ["PUT", { concurrency: { runMode: "parallel", maxConcurrency: 2 } }],
          ["DELETE", undefined],
        ] as const) {
          const refused = await direct(
            deploy,
            method,
            `/runners/${id}/config`,
            body,
            deploy.defaults,
          );
          expect(refused.status).toBe(404);
          expect(refused.json).toMatchObject({ code: "ROUTE_NOT_FOUND" });
        }
        const config = await configOf(deploy, id);
        expect(config.seq).toBe(0);
        expect(config.overridden).toEqual([]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "offers Settings… for a runner registered in another context, and the change reaches its owner",
      async () => {
        const deploy = deployment(label);
        const id = "cfg-remote";
        const owner = await startRunner(deploy, deploy.remote, id, {
          // On a polled backend `"auto"` does not subscribe to control
          // events, so the owner adopts at its sync; shortened from 30 s.
          ...(deploy.pushes ? {} : { syncInterval: POLLED_SYNC_MS }),
        });
        const info = (await direct(deploy, "GET", `/runners/${id}`)).json as {
          isLocal: boolean;
        };
        expect(info.isLocal).toBe(false);

        const ui = await (
          await harness()
        ).mountRunnerConfig(deploy.fetch, CSRF, id);
        await ui.awaitView((view) => view.settingsOffered);
        const dialog = await ui.openSettings();
        dialog.setRunMode("parallel");
        dialog.setMaxConcurrency("2");
        const saved = await dialog.save();
        expect(saved.closed).toBe(true);
        const writes = uiConfigWrites(deploy, id);
        expect(writes).toHaveLength(1);
        expect(JSON.parse(writes[0]!.body!)).toEqual({
          concurrency: { runMode: "parallel", maxConcurrency: 2 },
        });
        const answer = writes[0]!.json as ConfigDto;
        expect(writes[0]!.status).toBe(200);
        expect(answer.overridden).toEqual(["runMode", "maxConcurrency"]);
        // The toast matches what the answer said about adoption.
        expect(saved.toast).toContain(
          (answer.appliedSeq ?? 0) < answer.seq
            ? "its owner adopts them at its next sync"
            : `Saved the settings of ${id}`,
        );

        // The owner, in the other context, adopts it.
        await until(
          () =>
            owner.config.appliedSeq === answer.seq &&
            owner.config.effective.runMode === "parallel",
          () =>
            `${label}: the remote owner never adopted: ${JSON.stringify(owner.config)}`,
        );
        expect(owner.config.effective.maxConcurrency).toBe(2);
        await until(
          async () => (await configOf(deploy, id)).appliedSeq === answer.seq,
          () => `${label}: the API never saw the adoption`,
        );
        await ui.refresh();
        const after = await ui.awaitView(
          (view) => view.summary.runMode?.value === "parallel",
        );
        expect(after.summary.runMode?.hint).toBe(
          "Overridden here; its code asks for single",
        );
        expect(after.summary.override?.hint).toBeNull();
        ui.unmount();

        // It runs with it: two overlap, a third is refused by the cap.
        const held = [1, 2].map((n) => `${label}:${id}:${n}`);
        for (const name of held) {
          await hold(owner, name);
        }
        expect(await owner.trigger({})).toEqual({
          outcome: "skipped",
          reason: "max-concurrency",
        });
        for (const name of held) {
          release(name);
        }
        await settled(owner);
      },
      TEST_TIMEOUT_MS,
    );
  });
}
