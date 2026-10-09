import type { Logger } from "../../shared/logger";
import type { ContainerOwner, ResolvedContainerTarget } from "./target";
import { randomBytes } from "node:crypto";
import { buildChildEnv } from "../../shared/childEnv";
import { IsolationUnavailableError } from "../../shared/errors";
import { CONTAINER_LABELS, CONTAINER_PROBE, containerRunArgs } from "./target";

/**
 * The container engine, driven through its CLI with `Bun.spawn`: no SDK, so
 * no dependency. Every command runs with an **explicit** environment — the
 * child allowlist plus the engine's own variables — because `Bun.spawn`
 * without one passes the environment this process *started* with. None of it
 * reaches a container: `docker run` copies nothing from its caller's
 * environment unless asked by name, which the argument list never does.
 */

/**
 * The engine's own variables, passed to the CLI (never to a container) when
 * the worker's environment sets them: where the engine is, how to reach it,
 * and where the CLI keeps its configuration.
 */
const ENGINE_ENV = [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "DOCKER_API_VERSION",
  "CONTAINER_HOST",
  "CONTAINER_CONNECTION",
  "CONTAINERS_CONF",
  "CONTAINERS_REGISTRIES_CONF",
  "CONTAINERS_STORAGE_CONF",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

/** How long one probe or housekeeping command may take, in ms. */
export const ENGINE_COMMAND_TIMEOUT = 60_000;

/** How long the probe's pull may take, in ms: an image can be large. */
export const ENGINE_PULL_TIMEOUT = 10 * 60_000;

/**
 * How old a container must be before the orphan sweep removes it, in ms. A
 * worker that has just started may own a container before its first report
 * has landed, so a sweep running at that moment must not take it for an
 * orphan. A dead worker's record lapses only after three report intervals in
 * any case, so this costs no orphan its removal.
 */
export const SWEEP_MIN_AGE = 60_000;

/** What one CLI command did. */
export interface EngineResult {
  /** Its exit code; `null` when a signal (a timeout, an abort) ended it. */
  code: number | null;
  /** What it wrote to stdout. */
  stdout: string;
  /** What it wrote to stderr, trimmed. */
  stderr: string;
}

/** The most of one CLI command's stdout, or of its stderr, read: 1 MiB. */
const ENGINE_OUTPUT_LIMIT = 1024 * 1024;

/**
 * A stream's text, up to `limit` bytes: the rest is read and dropped, so the
 * writer is never blocked on a full pipe.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  let kept = 0;
  for await (const chunk of stream) {
    if (kept >= limit) {
      continue;
    }
    const part =
      chunk.byteLength > limit - kept ? chunk.subarray(0, limit - kept) : chunk;
    kept += part.byteLength;
    text += decoder.decode(part, { stream: true });
  }
  return text + decoder.decode();
}

/** The most of the engine's stderr an error message carries. */
const STDERR_LIMIT = 2_000;

/** `text`, cut to {@link STDERR_LIMIT} characters with a marker when longer. */
export function clipStderr(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_LIMIT
    ? `${trimmed.slice(0, STDERR_LIMIT)}… (${trimmed.length - STDERR_LIMIT} more characters)`
    : trimmed;
}

/** A random container name: `bun-jobs-` and 12 hex digits. */
export function containerName(): string {
  return `bun-jobs-${randomBytes(6).toString("hex")}`;
}

/** The engine one target talks to. Internal. */
export class ContainerEngine {
  /** The CLI's name, `"docker"` or `"podman"`. */
  readonly cli: "docker" | "podman";
  /** The endpoint, when the target named one. */
  readonly #host: string | undefined;

  constructor(
    /** The resolved target, for its CLI and endpoint. */
    target: Pick<ResolvedContainerTarget, "cli" | "host">,
  ) {
    this.cli = target.cli;
    this.#host = target.host;
  }

  /**
   * The CLI's environment, built now from the live `process.env`: the child
   * allowlist, the engine's own variables, and the target's endpoint over
   * them.
   */
  env(): Record<string, string> {
    return buildChildEnv({
      passEnv: ENGINE_ENV,
      env:
        this.#host === undefined
          ? {}
          : {
              [this.cli === "podman" ? "CONTAINER_HOST" : "DOCKER_HOST"]:
                this.#host,
            },
    });
  }

  /**
   * The CLI's absolute path, found on the `PATH` it will run with, or an
   * `IsolationUnavailableError` saying it is not installed.
   */
  path(env: Record<string, string> = this.env()): string {
    const found = Bun.which(this.cli, { PATH: env.PATH ?? "" });
    if (!found) {
      throw new IsolationUnavailableError(
        "engine",
        `the ${this.cli} CLI is not on PATH`,
        "",
        { cli: this.cli },
      );
    }
    return found;
  }

  /**
   * Runs one CLI command to its end and returns what it did. Never throws for
   * a command that failed; `signal` kills it.
   */
  async exec(
    args: readonly string[],
    options: {
      /** The longest it may run, in ms; then it is killed. */
      timeout?: number;
      /** Kills it when aborted. */
      signal?: AbortSignal;
    } = {},
  ): Promise<EngineResult> {
    const env = this.env();
    const proc = Bun.spawn([this.path(env), ...args], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: options.timeout ?? ENGINE_COMMAND_TIMEOUT,
      killSignal: "SIGKILL",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    // Capped: the probe container's output is the image's, and a sweep's
    // listing grows with the engine's; neither is read whole into memory.
    const [stdout, stderr, code] = await Promise.all([
      readCapped(proc.stdout, ENGINE_OUTPUT_LIMIT),
      readCapped(proc.stderr, ENGINE_OUTPUT_LIMIT),
      proc.exited,
    ]);
    return {
      code: proc.signalCode === null ? code : null,
      stdout,
      stderr: clipStderr(stderr),
    };
  }

  /**
   * The start-up probe (I5): the engine answers, the runtime is listed, the
   * image is present or pulled, and a container with the target's exact
   * flags runs. Throws `IsolationUnavailableError` naming the failed step
   * and carrying the engine's stderr. Resolves with nothing on success.
   */
  async probe(
    target: ResolvedContainerTarget,
    run: {
      /** Whose the probe container is, for its labels. */
      owner: ContainerOwner;
      /** The processor's path inside the image. */
      processor: string;
      /** The variables bun-jobs sets, exactly as an attempt gets them. */
      markers: Readonly<Record<string, string>>;
      /** Aborts the probe: a close during start-up. */
      signal?: AbortSignal;
    },
  ): Promise<void> {
    const { signal } = run;
    const context = { cli: this.cli, image: target.image };

    const version = await this.exec(["version"], { signal });
    if (version.code !== 0) {
      throw new IsolationUnavailableError(
        "engine",
        `${this.cli} version exited ${version.code ?? "on a signal"}`,
        version.stderr,
        context,
      );
    }

    if (target.runtime !== undefined) {
      await this.#checkRuntime(target.runtime, context, signal);
    }

    await this.#checkImage(target, context, signal);

    // The probe container: the attempt's argument list exactly, with a
    // script that checks the entry resolves and the processor is there.
    const name = `${containerName()}-probe`;
    const args = containerRunArgs(target, {
      name,
      owner: run.owner,
      prefix: randomBytes(16).toString("hex"),
      processor: run.processor,
      script: CONTAINER_PROBE,
      markers: run.markers,
    });
    let result: EngineResult;
    try {
      result = await this.exec(args, { signal });
    } finally {
      if (signal?.aborted) {
        // The CLI was killed, which does not stop a container already
        // started: remove it by name.
        await this.exec(["rm", "--force", name]).catch(() => undefined);
      }
    }
    if (result.code !== 0) {
      throw new IsolationUnavailableError(
        "probe",
        `a probe container with the target's flags exited ${result.code ?? "on a signal"}${probeHint(result.stderr)}`,
        result.stderr,
        { ...context, exitCode: result.code },
      );
    }
  }

  /** Step 2: the requested runtime is one the engine lists. */
  async #checkRuntime(
    runtime: string,
    context: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const format =
      this.cli === "podman"
        ? "{{json .Host.OCIRuntime.Name}}"
        : "{{json .Runtimes}}";
    const info = await this.exec(["info", `--format=${format}`], { signal });
    if (info.code !== 0) {
      throw new IsolationUnavailableError(
        "runtime",
        `${this.cli} info exited ${info.code ?? "on a signal"}`,
        info.stderr,
        { ...context, runtime },
      );
    }
    let listed: string[] = [];
    try {
      const parsed: unknown = JSON.parse(info.stdout.trim() || "null");
      listed =
        typeof parsed === "string"
          ? [parsed]
          : parsed && typeof parsed === "object"
            ? Object.keys(parsed)
            : [];
    } catch {
      listed = [];
    }
    if (!listed.includes(runtime)) {
      throw new IsolationUnavailableError(
        "runtime",
        `the runtime "${runtime}" is not one the engine lists (${listed.join(", ") || "none read"})`,
        info.stderr,
        { ...context, runtime, listed },
      );
    }
  }

  /** Step 3: the image is present, or pulled as `pull` allows. */
  async #checkImage(
    target: ResolvedContainerTarget,
    context: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const present =
      target.pull === "always"
        ? false
        : (
            await this.exec(
              ["image", "inspect", "--format={{.Id}}", target.image],
              {
                signal,
              },
            )
          ).code === 0;
    if (present) {
      return;
    }
    if (target.pull === "never") {
      throw new IsolationUnavailableError(
        "image",
        `the image ${target.image} is not present, and pull is "never"`,
        "",
        context,
      );
    }
    const pulled = await this.exec(["pull", target.image], {
      signal,
      timeout: ENGINE_PULL_TIMEOUT,
    });
    if (pulled.code !== 0) {
      throw new IsolationUnavailableError(
        "image",
        `${this.cli} pull ${target.image} exited ${pulled.code ?? "on a signal"}`,
        pulled.stderr,
        context,
      );
    }
  }

  /**
   * Removes the containers labelled with `owner`'s key, namespace and queue
   * whose worker id is not in `live` (and is not `owner`'s own), and which
   * are older than `minAge` ms. Returns the names removed. Never throws: a
   * sweep that cannot run is logged, and the worker starts anyway.
   */
  async sweep(
    owner: ContainerOwner,
    live: ReadonlySet<string>,
    logger: Logger,
    options: {
      /** The youngest container the sweep may remove, in ms. Defaults to {@link SWEEP_MIN_AGE}. */
      minAge?: number;
      /** Aborts the sweep: a close during start-up. */
      signal?: AbortSignal;
    } = {},
  ): Promise<string[]> {
    const { signal } = options;
    const minAge = options.minAge ?? SWEEP_MIN_AGE;
    try {
      const listed = await this.exec(
        [
          "ps",
          "--all",
          "--quiet",
          "--no-trunc",
          `--filter=label=${CONTAINER_LABELS.workerKey}=${owner.workerKey}`,
          `--filter=label=${CONTAINER_LABELS.namespace}=${owner.namespace}`,
          `--filter=label=${CONTAINER_LABELS.queue}=${owner.queue}`,
        ],
        { signal },
      );
      if (listed.code !== 0) {
        logger.warn(
          "Could not list this worker's containers to sweep orphans",
          {
            cli: this.cli,
            stderr: listed.stderr,
          },
        );
        return [];
      }
      const ids = listed.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (ids.length === 0) {
        return [];
      }

      const inspected = await this.exec(
        [
          "inspect",
          `--format={{.Name}}\t{{index .Config.Labels "${CONTAINER_LABELS.workerId}"}}\t{{.Created}}`,
          ...ids,
        ],
        { signal },
      );
      const now = Date.now();
      const orphans: string[] = [];
      for (const line of inspected.stdout.split("\n")) {
        const [rawName, workerId, created] = line.trim().split("\t");
        // A container without a worker id — the label missing, which the
        // template prints as nothing or `<no value>` — says nothing about
        // whose it is, so it is never taken for an orphan.
        if (
          !rawName ||
          workerId === undefined ||
          workerId === "" ||
          workerId === "<no value>"
        ) {
          continue;
        }
        const name = rawName.replace(/^\//, "");
        if (workerId === owner.workerId || live.has(workerId)) {
          continue;
        }
        const at = parseCreated(created);
        if (at === undefined || now - at < minAge) {
          continue;
        }
        orphans.push(name);
      }
      if (orphans.length === 0) {
        return [];
      }

      const removed = await this.exec(["rm", "--force", ...orphans], {
        signal,
      });
      if (removed.code !== 0) {
        logger.warn("Could not remove every orphaned container", {
          cli: this.cli,
          containers: orphans,
          stderr: removed.stderr,
        });
      } else {
        logger.info(
          `Removed ${orphans.length} orphaned ${orphans.length === 1 ? "container" : "containers"} of workers no longer live`,
          { containers: orphans },
        );
      }
      return orphans;
    } catch (error) {
      if (signal?.aborted) {
        return [];
      }
      logger.warn("The orphaned-container sweep failed", { error });
      return [];
    }
  }
}

/**
 * The hint an error adds for a failure it recognises: snap Docker's refusal
 * of `no-new-privileges` under its default AppArmor profile.
 */
function probeHint(stderr: string): string {
  return /operation not permitted/i.test(stderr) &&
    /entrypoint|exec /i.test(stderr)
    ? ' (on snap Docker, no-new-privileges needs security: { apparmor: "snap.docker.dockerd" })'
    : "";
}

/**
 * An engine's `Created` timestamp in epoch ms. RFC 3339 with up to nine
 * fractional digits, which `Date.parse` does not take beyond three.
 */
export function parseCreated(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value
    .trim()
    // Podman's form: `2026-10-01 09:20:01.123456789 +0000 UTC`.
    .replace(/^(\S+) (\S+) ([+-]\d{2})(\d{2}) \w+$/, "$1T$2$3:$4")
    .replace(/(\.\d{3})\d+/, "$1");
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : at;
}
