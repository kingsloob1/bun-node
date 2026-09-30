import type { BunHttpAdapter, BunResponse } from "@kingsleyweb/bun-common";
import type { Subprocess } from "bun";
import process from "node:process";

/**
 * "Local Compute": a made-up compute platform whose units are **real
 * processes on this machine**. It is what the playground's compute provider
 * (`provider.ts`) talks to, over HTTP, exactly as a provider for a cloud
 * platform talks to that platform's API.
 *
 * The API lives on the playground's own port, under `/local-compute/v1`:
 *
 * | Route | What it does |
 * |---|---|
 * | `GET  /v1/whoami` | checks the bearer token; the preflight's call |
 * | `POST /v1/units` | starts `count` units, each `bun compute/worker.ts <argv>`, deduped by `token` |
 * | `GET  /v1/units?handles=a,b` | what became of units |
 * | `POST /v1/units/cancel` | stops units |
 *
 * And, for you rather than for the provider, a control page at
 * `/local-compute` listing the units and queueing **faults**: each one is
 * spent by the next `POST /v1/units`, so the Summon panel shows what the
 * controller makes of that answer.
 *
 * | Fault | The platform answers | What the controller does |
 * |---|---|---|
 * | `throttled` | 429 with `Retry-After: 8` | `unavailable`, not counted, backs off at least 8 s |
 * | `quota` | 402 `QuotaExceeded`, `Retry-After: 20` | `unavailable`, **counted**, backs off at least 20 s |
 * | `auth` | 401 `TokenRevoked` | `failed`, and the circuit opens **at once** |
 * | `misconfigured` | 404 `PoolNotFound` | as `auth` |
 * | `transient` | 503 `ServiceUnavailable` | `failed`, counted, the usual backoff |
 * | `crash` | 201: a unit that exits 1 before its worker reports | `lost` once the boot budget passes, explained by the unit's detail |
 * | `die` | 201: a unit that is `SIGKILL`ed after its first job | `lost`, detail `died`, once its grace passes |
 */

/** A fault the next `POST /v1/units` answers with. */
export type Fault =
  | "throttled"
  | "quota"
  | "auth"
  | "misconfigured"
  | "transient"
  | "crash"
  | "die";

/** Every fault, in the order the control page offers them. */
export const FAULTS: readonly Fault[] = [
  "throttled",
  "quota",
  "auth",
  "misconfigured",
  "transient",
  "crash",
  "die",
];

/** What the control page says each fault does. */
const FAULT_TEXT: Record<Fault, string> = {
  throttled: "429, Retry-After 8 s: unavailable, uncounted",
  quota: "402 QuotaExceeded, Retry-After 20 s: unavailable, counted",
  auth: "401 TokenRevoked: the circuit opens at once",
  misconfigured: "404 PoolNotFound: the circuit opens at once",
  transient: "503: failed, counted",
  crash: "a unit that exits 1 before reporting: lost after the boot budget",
  die: "a unit SIGKILLed after its first job: lost, detail died",
};

/** The body of `POST /v1/units`. */
export interface StartBody {
  /** The idempotency token: the same token never starts units twice. */
  token: string;
  /** Arguments for the worker process: the summon's identity. */
  args: string[];
  /** Static environment for the process. */
  env: Record<string, string>;
  /** How many units to start. */
  count: number;
  /** The longest a unit may live, in seconds; the platform stops it then. */
  lifetimeSeconds: number;
}

/** One unit, as `GET /v1/units` reports it. */
export interface UnitView {
  /** Its handle. */
  handle: string;
  /** Where it is in its life. */
  state: "pending" | "running" | "exited" | "failed" | "unknown";
  /** Its exit code, once it exited. */
  exitCode?: number;
  /** Why it failed, in the platform's words. */
  detail?: string;
}

/** A unit the platform started. */
interface Unit {
  /** Its handle, `lc-<n>`. */
  handle: string;
  /** The token it was started under. */
  token: string;
  /** The worker process. */
  child: Subprocess<"ignore", "ignore", "pipe">;
  /** When it started, epoch ms. */
  startedAt: number;
  /** The fault it was started with, if any. */
  fault?: Fault;
  /** Its exit code, once it exited. */
  exitCode?: number;
  /** The signal that ended it, if one did. */
  signal?: string;
  /** Why it failed, from its last line of stderr. */
  detail?: string;
  /** The lifetime timer. */
  lifetime?: ReturnType<typeof setTimeout>;
}

/** Options for {@link LocalCompute}. */
export interface LocalComputeOptions {
  /** The API tokens it accepts. */
  tokens: readonly string[];
  /** The worker entry each unit runs. */
  entry: string;
  /** The most units alive at once; beyond it a start answers "no capacity". Defaults to 4. */
  maxUnits?: number;
  /** How long a unit gets after `SIGTERM` before `SIGKILL`, in ms. Defaults to 10 000. */
  graceMs?: number;
}

/** Waits `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** An error answer in the platform's shape. */
function failure(
  status: number,
  code: string,
  headers: Record<string, string> = {},
): { status: number; body: object; headers: Record<string, string> } {
  return { status, body: { error: { code } }, headers };
}

/** HTML-escapes a string for the control page. */
function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}

/** The platform: its units, its fault queue, and its HTTP API. */
export class LocalCompute {
  /** Where its routes are mounted on the playground's adapter. */
  readonly basePath = "/local-compute";
  /** Every unit it started, by handle, newest last. */
  readonly #units = new Map<string, Unit>();
  /** The handles each token started. */
  readonly #byToken = new Map<string, string[]>();
  /** Faults the next starts answer with, oldest first. */
  readonly #faults: Fault[] = [];
  /** The next handle's number. */
  #next = 1;
  /** Set once {@link stop} began: no more units start. */
  #stopping = false;
  /** Its options, defaulted. */
  readonly #options: Required<LocalComputeOptions>;

  constructor(
    /** What it accepts, runs, and allows. */
    options: LocalComputeOptions,
  ) {
    this.#options = { maxUnits: 4, graceMs: 10_000, ...options };
  }

  /** Queues a fault for the next start. */
  inject(fault: Fault): void {
    this.#faults.push(fault);
  }

  /** The faults still queued. */
  get pendingFaults(): readonly Fault[] {
    return [...this.#faults];
  }

  /** Units whose process is still alive. */
  get alive(): number {
    let count = 0;
    for (const unit of this.#units.values()) {
      count += this.#isAlive(unit) ? 1 : 0;
    }
    return count;
  }

  /** Whether a unit's process is still running. */
  #isAlive(unit: Unit): boolean {
    return unit.child.exitCode === null && unit.child.signalCode === null;
  }

  /** Whether a request carries an accepted bearer token. */
  #authorized(header: string | null): boolean {
    const token = header?.replace(/^Bearer\s+/i, "");
    return token !== undefined && this.#options.tokens.includes(token);
  }

  /** `GET /v1/whoami`. */
  whoami(authorization: string | null): {
    status: number;
    body: object;
    headers?: Record<string, string>;
  } {
    if (!this.#authorized(authorization)) {
      return failure(401, "InvalidToken");
    }
    return {
      status: 200,
      body: {
        account: "playground",
        maxUnits: this.#options.maxUnits,
        running: this.alive,
      },
    };
  }

  /** `POST /v1/units`. */
  start(
    authorization: string | null,
    body: StartBody,
  ): { status: number; body: object; headers?: Record<string, string> } {
    if (!this.#authorized(authorization)) {
      return failure(401, "InvalidToken");
    }
    const earlier = this.#byToken.get(body.token);
    if (earlier) {
      return { status: 200, body: { deduped: true, handles: earlier } };
    }
    const fault = this.#faults.shift();
    switch (fault) {
      case "throttled":
        return failure(429, "RateLimited", { "retry-after": "8" });
      case "quota":
        return failure(402, "QuotaExceeded", { "retry-after": "20" });
      case "auth":
        return failure(401, "TokenRevoked");
      case "misconfigured":
        return failure(404, "PoolNotFound");
      case "transient":
        return failure(503, "ServiceUnavailable");
      default:
        break;
    }
    if (this.#stopping) {
      return failure(503, "ShuttingDown");
    }
    const count = Math.max(1, Math.floor(body.count));
    if (this.alive + count > this.#options.maxUnits) {
      // A normal answer, not an error: the provider maps it to `unavailable`.
      return {
        status: 200,
        body: {
          failures: [
            {
              reason: `no free slot: ${this.alive} of ${this.#options.maxUnits} units running`,
            },
          ],
        },
      };
    }
    const handles: string[] = [];
    for (let i = 0; i < count; i++) {
      handles.push(this.#spawn(body, fault).handle);
    }
    this.#byToken.set(body.token, handles);
    return { status: 201, body: { handles } };
  }

  /** Starts one unit: a real worker process with the summon's arguments. */
  #spawn(body: StartBody, fault: Fault | undefined): Unit {
    const handle = `lc-${this.#next++}`;
    const child = Bun.spawn({
      cmd: [process.execPath, this.#options.entry, ...body.args],
      // Explicit, always: with no `env` Bun hands the child the environment
      // this process *started* with. Identity never travels here, only in
      // the arguments.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...(process.env.TMPDIR === undefined
          ? {}
          : { TMPDIR: process.env.TMPDIR }),
        ...body.env,
        LOCAL_COMPUTE_UNIT: handle,
        ...(fault === undefined ? {} : { LOCAL_COMPUTE_FAULT: fault }),
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const unit: Unit = {
      handle,
      token: body.token,
      child,
      startedAt: Date.now(),
      ...(fault === undefined ? {} : { fault }),
    };
    this.#units.set(handle, unit);
    void new Response(child.stderr).text().then((text) => {
      const last = text.trim().split("\n").at(-1);
      if (last) {
        unit.detail = last.slice(0, 120);
      }
    });
    void child.exited.then((code) => {
      clearTimeout(unit.lifetime);
      unit.exitCode = code;
      unit.signal = child.signalCode ?? undefined;
    });
    // The platform's own cap on a unit's life.
    unit.lifetime = setTimeout(
      () => void this.#terminate(unit),
      body.lifetimeSeconds * 1_000,
    );
    return unit;
  }

  /** `GET /v1/units?handles=`. */
  status(
    authorization: string | null,
    handles: string[],
  ): {
    status: number;
    body: object;
  } {
    if (!this.#authorized(authorization)) {
      return failure(401, "InvalidToken");
    }
    const units: UnitView[] = handles.map((handle) => {
      const unit = this.#units.get(handle);
      if (!unit) {
        return { handle, state: "unknown" };
      }
      if (this.#isAlive(unit)) {
        return { handle, state: "running" };
      }
      const exitCode = unit.child.exitCode ?? undefined;
      if (exitCode === 0) {
        return { handle, state: "exited", exitCode };
      }
      return {
        handle,
        state: "failed",
        ...(exitCode === undefined ? {} : { exitCode }),
        detail:
          unit.child.signalCode !== null
            ? `Killed: ${unit.child.signalCode}`
            : `ExitCode${exitCode}${unit.detail ? `: ${unit.detail}` : ""}`,
      };
    });
    return { status: 200, body: { units } };
  }

  /** `POST /v1/units/cancel`. */
  cancel(
    authorization: string | null,
    handles: string[],
  ): {
    status: number;
    body: object;
  } {
    if (!this.#authorized(authorization)) {
      return failure(401, "InvalidToken");
    }
    for (const handle of handles) {
      const unit = this.#units.get(handle);
      if (unit) {
        void this.#terminate(unit);
      }
    }
    return { status: 202, body: {} };
  }

  /** `SIGTERM`, then `SIGKILL` once the grace has passed. */
  async #terminate(unit: Unit, graceMs = this.#options.graceMs): Promise<void> {
    if (!this.#isAlive(unit)) {
      return;
    }
    unit.child.kill("SIGTERM");
    const done = await Promise.race([
      unit.child.exited.then(() => true),
      sleep(graceMs).then(() => false),
    ]);
    if (!done && this.#isAlive(unit)) {
      unit.child.kill("SIGKILL");
    }
  }

  /**
   * Stops every unit still running: `SIGTERM`, a short grace, then `SIGKILL`.
   * Called when the playground stops, so no worker process outlives it.
   */
  async stop(graceMs = 3_000): Promise<void> {
    this.#stopping = true;
    await Promise.all(
      [...this.#units.values()].map((unit) => this.#terminate(unit, graceMs)),
    );
  }

  /** `SIGKILL`s every unit still running: the last resort, on `exit`. */
  killAll(): void {
    for (const unit of this.#units.values()) {
      if (this.#isAlive(unit)) {
        unit.child.kill("SIGKILL");
      }
    }
  }

  /** The control page's data. */
  snapshot(): {
    faults: readonly Fault[];
    units: (UnitView & { pid: number; startedAt: string; fault?: Fault })[];
  } {
    const units = [...this.#units.values()].reverse().map((unit) => ({
      ...(
        this.status(`Bearer ${this.#options.tokens[0]}`, [unit.handle])
          .body as { units: UnitView[] }
      ).units[0]!,
      pid: unit.child.pid,
      startedAt: new Date(unit.startedAt).toISOString(),
      ...(unit.fault === undefined ? {} : { fault: unit.fault }),
    }));
    return { faults: this.pendingFaults, units };
  }

  /** The control page. */
  #page(): string {
    const { faults, units } = this.snapshot();
    const buttons = FAULTS.map(
      (fault) =>
        `<form method="post" action="${this.basePath}/faults?kind=${fault}"><button>${fault}</button> <span>${escapeHtml(FAULT_TEXT[fault])}</span></form>`,
    ).join("\n");
    const rows = units
      .slice(0, 50)
      .map(
        (unit) =>
          `<tr><td>${unit.handle}</td><td>${unit.pid}</td><td>${unit.state}</td><td>${unit.exitCode ?? ""}</td><td>${unit.fault ?? ""}</td><td>${escapeHtml(unit.detail ?? "")}</td><td>${unit.startedAt}</td></tr>`,
      )
      .join("\n");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="3">
<title>Local Compute</title>
<style>
body{font:14px system-ui,sans-serif;margin:24px;max-width:960px;color:#1d1d1f;background:#fff}
@media (prefers-color-scheme:dark){body{color:#e6e6e6;background:#161616}}
table{border-collapse:collapse;width:100%}td,th{padding:4px 8px;border-bottom:1px solid #8884;text-align:left}
form{margin:4px 0}button{min-width:120px}span{opacity:.75}
</style></head><body>
<h1>Local Compute</h1>
<p>The made-up platform behind the playground's compute provider. Its units are real
<code>bun compute/worker.ts</code> processes on this machine. The UI's Providers screen is at
<a href="/jobs/providers">/jobs/providers</a>; the <code>renders</code> queue's Summon panel at
<a href="/jobs/queues/renders">/jobs/queues/renders</a>.</p>
<h2>Queue a fault for the next start</h2>
${buttons}
<form method="post" action="${this.basePath}/faults/clear"><button>clear</button> <span>forget queued faults</span></form>
<p>Queued: ${faults.length === 0 ? "none" : faults.join(", ")}</p>
<h2>Units (${this.alive} running)</h2>
<table><tr><th>Handle</th><th>pid</th><th>State</th><th>Exit</th><th>Fault</th><th>Detail</th><th>Started</th></tr>
${rows}
</table>
</body></html>`;
  }

  /**
   * Mounts the platform's API and its control page on the playground's
   * adapter. The API answers every request in the platform's own shape; the
   * control routes redirect a form post back to the page, and answer JSON
   * otherwise.
   */
  mount(app: BunHttpAdapter): void {
    const base = this.basePath;
    interface Answer {
      status: number;
      body: object;
      headers?: Record<string, string>;
    }
    const send = (res: BunResponse, answer: Answer): void => {
      for (const [name, value] of Object.entries(answer.headers ?? {})) {
        res.set(name, value);
      }
      res.status(answer.status).json(answer.body);
    };

    app.get(`${base}/v1/whoami`, (req, res) => {
      send(res, this.whoami(req.get("authorization")));
    });
    app.post(`${base}/v1/units`, (req, res) => {
      send(
        res,
        this.start(req.get("authorization"), req.body as unknown as StartBody),
      );
    });
    app.get(`${base}/v1/units`, (req, res) => {
      const handles = String((req.query as { handles?: string }).handles ?? "")
        .split(",")
        .filter(Boolean);
      send(res, this.status(req.get("authorization"), handles));
    });
    app.post(`${base}/v1/units/cancel`, (req, res) => {
      const { handles = [] } = (req.body ?? {}) as { handles?: string[] };
      send(res, this.cancel(req.get("authorization"), handles));
    });

    app.get(base, (_req, res) => {
      res.type("html").send(this.#page());
    });
    app.get(`${base}/state`, (_req, res) => {
      res.json(this.snapshot());
    });
    app.post(`${base}/faults`, (req, res) => {
      const kind = (req.query as { kind?: string }).kind as Fault | undefined;
      if (kind === undefined || !FAULTS.includes(kind)) {
        res
          .status(400)
          .json({ error: `kind must be one of ${FAULTS.join(", ")}` });
        return;
      }
      this.inject(kind);
      const wantsHtml = (req.get("accept") ?? "").includes("text/html");
      if (wantsHtml) {
        res.redirect(base, 303);
        return;
      }
      res.json({ queued: this.pendingFaults });
    });
    app.post(`${base}/faults/clear`, (req, res) => {
      this.#faults.length = 0;
      if ((req.get("accept") ?? "").includes("text/html")) {
        res.redirect(base, 303);
        return;
      }
      res.json({ queued: [] });
    });
  }
}
