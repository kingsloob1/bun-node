import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";
import process from "node:process";
import { DEFAULT_CLOSE_TIMEOUT } from "../../shared/constants";
import { ConfigError } from "../../shared/errors";

/**
 * The `container` worker target: its options, their checks, and the exact
 * `docker run` argument list they become.
 *
 * The argument list is built here and nowhere else, from typed options only:
 * there is no raw-argument option to smuggle a flag through, every value goes
 * out in the `--flag=value` spelling so none can be read as a flag of its own,
 * and the hardening flags are fixed rather than optional. The start-up probe
 * runs this very list, so what it proves is what every attempt gets.
 */

/**
 * A worker target that runs each attempt in a fresh container, through the
 * Docker CLI (or Podman's compatible one).
 *
 * The worker keeps the claim, the lease and the settle; the container runs
 * only the processor call, and asks the worker over its stdin and stdout for
 * the same closed list of job operations a `child-process` attempt may. Each
 * container gets **no network**, **none of the worker's environment**, a
 * read-only root, no capabilities, `no-new-privileges`, an init as PID 1, a
 * non-root user and resource limits — fixed, not options. The image is yours: `FROM oven/bun`,
 * with your app and its dependencies (`@kingsleyweb/bun-jobs` among them)
 * installed.
 *
 * At `worker.run()` the engine, the runtime, the image and a probe container
 * with the exact flags are checked, and a failure throws
 * `IsolationUnavailableError` before any job is claimed. There is never a
 * fallback to running the job some other way.
 *
 * **What it does not promise.** Containers share the host kernel: a kernel
 * exploit escapes runc, so choose gVisor (`runtime: "runsc"`), Kata or a
 * microVM platform for hostile multi-tenant code. And the `docker` group is
 * root-equivalent: a worker that drives rootful Docker is as privileged as
 * root on its host.
 */
export interface ContainerTarget {
  /** Marks the variant: a fresh container per attempt. */
  kind: "container";
  /**
   * The image to run. Required. A digest (`name@sha256:…`) is recommended: a
   * tag can move under you. It must contain Bun and the processor, with
   * `@kingsleyweb/bun-jobs` resolvable from the processor's directory.
   */
  image: string;
  /**
   * The processor file's absolute path **inside the image**. Defaults to the
   * worker's processor path, which suits an image that keeps the app at the
   * same path as the host.
   */
  processor?: string;
  /**
   * When the start-up probe pulls the image: `"never"`, `"missing"` (the
   * default) or `"always"`. An attempt itself never pulls (`--pull=never`).
   */
  pull?: "never" | "missing" | "always";
  /**
   * The engine: its CLI and the endpoint it talks to. Defaults to
   * `{ cli: "docker" }` with the CLI's own `DOCKER_HOST` (or `CONTAINER_HOST`
   * for Podman), when the worker's environment sets one.
   */
  engine?: {
    /** Which CLI to run, found on `PATH`: `"docker"` (the default) or `"podman"`. */
    cli?: "docker" | "podman";
    /**
     * The engine's endpoint, e.g. `"unix:///run/user/1000/docker.sock"`:
     * given to the CLI as `DOCKER_HOST` (`CONTAINER_HOST` for Podman).
     * Defaults to the CLI's own.
     */
    host?: string;
  };
  /**
   * The OCI runtime, e.g. `"runsc"` for gVisor: checked against the engine's
   * runtimes at start. Defaults to the engine's default runtime.
   */
  runtime?: string;
  /**
   * Resource limits per container. Defaults: memory `"256m"` with swap equal
   * to it (so no swap), 1 CPU, 128 pids, and a `"64m"` tmpfs at `/tmp` —
   * which counts against the memory limit.
   */
  limits?: {
    /** Memory, as the engine spells it (`"256m"`, `"1g"`). Swap is set equal, so there is none. At least `"6m"`, the engine's floor; `"0"` (no limit) is refused. Defaults to `"256m"`. */
    memory?: string;
    /** CPUs, fractional allowed (`0.5`). Defaults to `1`. */
    cpus?: number;
    /** The most processes and threads, Bun's own included. At least 16. Defaults to `128`. */
    pids?: number;
    /** The size of the tmpfs at `/tmp`, the only writable path besides a writable mount. Above 0 (`"0"` is no limit, and refused). Defaults to `"64m"`. */
    tmpfs?: string;
  };
  /**
   * The container's network. `"none"`, the default and the only value this
   * version takes: no route anywhere, the host and other containers
   * included. The host's network is refused.
   */
  network?: "none";
  /**
   * The job's environment, as literal values. Nothing is ever copied from
   * the worker's environment, and a variable without a value is refused,
   * since the engine would copy the host's.
   */
  env?: Record<string, string>;
  /**
   * Bind mounts, read-only unless `readOnly: false`. Refused: a socket, a
   * directory with a socket directly in it, `/`, `/proc`, `/sys`, `/dev`,
   * `/etc`, `/run`, `/var/run`, where an engine keeps its sockets or data
   * (the target's `engine.host`, `DOCKER_HOST`, `~/.docker`, `~/.colima`,
   * `/var/lib/docker`, `/var/snap/docker` and the like), and any directory
   * holding one of them, compared after resolving symlinks. A read-only bind
   * does not stop a `connect()`. Paths are absolute, without commas.
   */
  mounts?: {
    /** The host path. Absolute. */
    source: string;
    /** The path inside the container. Absolute, and not `/`. */
    target: string;
    /** Whether the mount is read-only. Defaults to `true`. */
    readOnly?: boolean;
  }[];
  /**
   * The numeric `uid:gid` to run as. Defaults to `"65534:65534"` (nobody).
   * uid `0` and gid `0` are refused unless `allowRoot` is set; a user name is
   * refused, since it could name root, and so is a uid alone, whose group
   * the engine takes from the image (which can be `0`).
   */
  user?: string;
  /** Allows `user` to be root (uid 0) or in the root group (gid 0) inside the container. Defaults to `false`. */
  allowRoot?: boolean;
  /**
   * Security profiles. Defaults: the engine's default seccomp and AppArmor
   * profiles. `"unconfined"` is refused for both. `no-new-privileges` is
   * always set and is not an option. **Snap Docker** cannot start any
   * container with `no-new-privileges` under its default AppArmor profile;
   * there, `apparmor: "snap.docker.dockerd"` works, and the start-up probe
   * says so when it fails.
   */
  security?: {
    /** A seccomp profile's path, as the CLI reads it. `"unconfined"` is refused. */
    seccomp?: string;
    /** An AppArmor profile's name. `"unconfined"` is refused. */
    apparmor?: string;
  };
  /**
   * After an attempt is asked to stop (a timeout, a lost lock, a close), how
   * long it has to unwind before its container is killed (`docker kill`,
   * then `docker rm -f`), in milliseconds. Defaults to 5000. The runner
   * inside exits itself 500 ms before it runs out.
   */
  closeTimeout?: number;
  /**
   * The most bytes of an attempt's stdout and stderr kept as job log lines
   * (its own output: the channel's lines are not counted). Past it the rest
   * is dropped and one line says so. Defaults to 1 MiB.
   */
  maxLogBytes?: number;
}

/** The label keys every container this target starts carries. */
export const CONTAINER_LABELS = {
  /** The worker's stable key: what the orphan sweep selects on. */
  workerKey: "bun-jobs.worker-key",
  /** The worker's incarnation id: a container whose worker is not live is an orphan. */
  workerId: "bun-jobs.worker-id",
  /** The namespace, so a sweep stays inside the queue whose workers it listed. */
  namespace: "bun-jobs.namespace",
  /** The queue, for the same reason. */
  queue: "bun-jobs.queue",
} as const;

/** The defaults the plan fixes (§5.8), in one place. */
export const CONTAINER_DEFAULTS = {
  memory: "256m",
  cpus: 1,
  pids: 128,
  tmpfs: "64m",
  user: "65534:65534",
  pull: "missing",
  cli: "docker",
  closeTimeout: DEFAULT_CLOSE_TIMEOUT,
  maxLogBytes: 1024 * 1024,
} as const;

/**
 * The longest line the channel reads from a container, and the largest
 * message it writes to one: 16 MiB. A message past it fails the attempt for
 * good rather than being cut, since a cut message is a different message.
 */
export const CONTAINER_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** A container target after its checks, with every default applied. Internal. */
export interface ResolvedContainerTarget {
  /** Marks the variant. */
  kind: "container";
  /** The image. */
  image: string;
  /** The processor's path inside the image, when given; else the worker's file. */
  processor: string | undefined;
  /** When the probe pulls. */
  pull: "never" | "missing" | "always";
  /** The CLI's name. */
  cli: "docker" | "podman";
  /** The endpoint, when given. */
  host: string | undefined;
  /** The runtime, when given. */
  runtime: string | undefined;
  /** The limits, every one set. */
  limits: { memory: string; cpus: number; pids: number; tmpfs: string };
  /** The job's literal environment. */
  env: Readonly<Record<string, string>>;
  /** The mounts, each with `readOnly` decided. */
  mounts: readonly { source: string; target: string; readOnly: boolean }[];
  /** `uid:gid` or `uid`. */
  user: string;
  /** The security profiles, when given. */
  security: { seccomp?: string; apparmor?: string };
  /** The grace after a cancel, in ms. */
  closeTimeout: number;
  /** The log budget per attempt, in bytes. */
  maxLogBytes: number;
}

/** Every key the target takes, for the "does not take" message. */
const KEYS = [
  "image",
  "processor",
  "pull",
  "engine",
  "runtime",
  "limits",
  "network",
  "env",
  "mounts",
  "user",
  "allowRoot",
  "security",
  "closeTimeout",
  "maxLogBytes",
] as const;

/**
 * Keys that ask for what this target refuses, with why. Recognised so the
 * message says *refused* rather than merely *unknown*: there is no escape
 * hatch, and a request for one is read as a missing typed option.
 */
const REFUSED_KEYS: Readonly<Record<string, string>> = {
  privileged: "privileged mode is refused",
  capAdd: "added capabilities are refused: every capability is dropped",
  capabilities: "added capabilities are refused: every capability is dropped",
  cap_add: "added capabilities are refused: every capability is dropped",
  devices: "devices are refused",
  device: "devices are refused",
  pid: "the host's PID namespace is refused",
  ipc: "the host's IPC namespace is refused (IPC is fixed to none)",
  uts: "the host's UTS namespace is refused",
  userns: "the host's user namespace is refused",
  args: "raw engine arguments are refused: every flag comes from a typed option",
  extraArgs:
    "raw engine arguments are refused: every flag comes from a typed option",
  flags:
    "raw engine arguments are refused: every flag comes from a typed option",
  volumes: "use mounts, which are checked; volumes is not an option",
  entrypoint: "the entrypoint is fixed: bun runs the bun-jobs container entry",
  envFile: "an env file is refused: it copies host values in",
  noNewPrivileges: "no-new-privileges is always set and is not an option",
};

/** Host paths a mount may neither be nor contain, nor sit inside. */
const REFUSED_MOUNT_PATHS = [
  "/proc",
  "/sys",
  "/dev",
  "/etc",
  "/run",
  "/var/run",
] as const;

/** An engine's socket file name. */
const ENGINE_SOCKET = /(?:^|\/)(?:docker|podman|containerd)\.sock$/;

/** A size as the engine spells it: digits, an optional fraction and unit. */
const SIZE = /^\d+(?:\.\d+)?[bkmg]?$/i;

/** The engine's smallest memory limit, 6 MiB: Docker refuses less. */
const MEMORY_FLOOR = 6 * 1024 * 1024;

/** A {@link SIZE} string in bytes, as the engine reads it (no unit is bytes). */
function sizeBytes(size: string): number {
  const unit = size.at(-1)!.toLowerCase();
  const scale =
    unit === "k"
      ? 1024
      : unit === "m"
        ? 1024 ** 2
        : unit === "g"
          ? 1024 ** 3
          : 1;
  return Math.floor(Number.parseFloat(size) * scale);
}

/** A variable name the engine passes as `--env=NAME=value`. */
const ENV_NAME = /^[A-Z_]\w*$/i;

/** A runtime or AppArmor profile name. */
const PROFILE_NAME = /^[\w./-]+$/;

/** What the messages call this target. */
const WHERE = 'target { kind: "container" }';

/** A `ConfigError` about this target. */
function refuse(
  message: string,
  context: Record<string, unknown>,
): ConfigError {
  return new ConfigError(`${WHERE} ${message}`, context);
}

/** Whether `value` is a plain object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks a string option: present, non-empty, NUL-free. */
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw refuse(`${name} must be a non-empty string`, {
      [name]: typeof value === "string" ? value : typeof value,
    });
  }
  return value;
}

/** Checks a number of milliseconds or bytes. */
function amount(value: unknown, name: string, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw refuse(
      `${name} must be a number of at least ${min}, not ${String(value)}`,
      {
        [name]: value,
      },
    );
  }
  return value;
}

/** Checks a mount's host path against the refusals, as given and resolved. */
function checkMountSource(source: string, host: string | undefined): void {
  const candidates = new Set([posix.normalize(source)]);
  try {
    candidates.add(realpathSync(source));
  } catch {
    // A path that does not exist here may exist on a remote engine's host;
    // its spelling is still checked.
  }
  const engine = enginePaths(host);

  for (const path of candidates) {
    const normal = trimSlash(path);
    if (normal === "/") {
      throw refuse("mounts may not mount /", { source });
    }
    if (ENGINE_SOCKET.test(normal)) {
      throw refuse(`mounts may not mount the engine's socket (${source})`, {
        source,
      });
    }
    for (const refused of [...REFUSED_MOUNT_PATHS, ...engine]) {
      const inside = normal === refused || normal.startsWith(`${refused}/`);
      const holds = refused.startsWith(`${normal}/`);
      if (inside || holds) {
        throw refuse(
          `mounts may not mount ${refused}${holds ? `, nor a directory holding it (${source})` : ` or anything in it (${source})`}${engine.includes(refused) && !REFUSED_MOUNT_PATHS.includes(refused as never) ? ": the engine's socket or data is there" : ""}`,
          { source },
        );
      }
    }
  }

  try {
    if (lstatSync(source).isSocket()) {
      throw refuse(`mounts may not mount a socket (${source})`, { source });
    }
    // A read-only bind does not stop connect(): a socket directly inside the
    // directory is as reachable as the socket itself.
    if (lstatSync(source).isDirectory()) {
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        if (entry.isSocket() || ENGINE_SOCKET.test(`/${entry.name}`)) {
          throw refuse(
            `mounts may not mount a directory holding a socket (${posix.join(source, entry.name)})`,
            { source },
          );
        }
      }
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
  }
}

/** A path without trailing slashes, `/` staying `/`. */
function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}

/**
 * Where an engine keeps its sockets and its data on this host, beyond
 * `/run` and `/var/run`: the target's own endpoint and the CLI's
 * (`DOCKER_HOST`, `CONTAINER_HOST`) when they are Unix sockets, the per-user
 * locations of rootless Docker, Docker Desktop, Colima, Lima, Rancher
 * Desktop, OrbStack and Podman, and the engines' data directories. Each is
 * given as spelled and resolved, so a symlink cannot hide one.
 */
function enginePaths(host: string | undefined): string[] {
  const home = homedir();
  const runtime = process.env.XDG_RUNTIME_DIR;
  const paths = [
    ...[host, process.env.DOCKER_HOST, process.env.CONTAINER_HOST]
      .filter((value): value is string => typeof value === "string")
      .filter((value) => value.startsWith("unix://"))
      .map((value) => value.slice("unix://".length)),
    `${home}/.docker`,
    `${home}/.colima`,
    `${home}/.lima`,
    `${home}/.rd`,
    `${home}/.orbstack`,
    `${home}/.local/share/containers`,
    `${home}/Library/Containers/com.docker.docker`,
    ...(runtime ? [`${runtime}/docker.sock`, `${runtime}/podman`] : []),
    "/var/lib/docker",
    "/var/lib/containerd",
    "/var/lib/containers",
    "/var/snap/docker",
  ];
  const out = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith("/")) {
      continue;
    }
    out.add(trimSlash(posix.normalize(path)));
    try {
      out.add(trimSlash(realpathSync(path)));
    } catch {
      // Not on this host: its spelling is still refused.
    }
  }
  return [...out];
}

/** A path option: absolute, NUL-free, and free of the `--mount` separator. */
function mountPath(value: unknown, name: string): string {
  const path = text(value, name);
  if (!path.startsWith("/")) {
    throw refuse(`${name} must be an absolute path, not "${path}"`, {
      [name]: path,
    });
  }
  if (/[,"\n]/.test(path)) {
    throw refuse(`${name} may not contain a comma, a quote or a newline`, {
      [name]: path,
    });
  }
  return path;
}

/**
 * Checks a `container` target as plain JavaScript may have written it, and
 * applies its defaults. Throws a `ConfigError` naming the bad value, or the
 * refusal; builds nothing and runs nothing.
 */
export function resolveContainerTarget(
  target: unknown,
): ResolvedContainerTarget {
  if (!isObject(target) || target.kind !== "container") {
    throw new ConfigError(
      'a container target is { kind: "container", image }',
      {
        target: typeof target,
      },
    );
  }

  for (const [key, value] of Object.entries(target)) {
    if (key === "kind" || value === undefined) {
      continue;
    }
    if (Object.hasOwn(REFUSED_KEYS, key)) {
      throw refuse(`does not take ${key}: ${REFUSED_KEYS[key]}`, { key });
    }
    if (!(KEYS as readonly string[]).includes(key)) {
      throw refuse(`does not take ${key}: it takes ${KEYS.join(", ")}`, {
        key,
      });
    }
  }

  const image = text(target.image, "image");
  if (image.startsWith("-") || /\s/.test(image)) {
    throw refuse(`image "${image}" is not an image reference`, { image });
  }

  let processor: string | undefined;
  if (target.processor !== undefined) {
    processor = text(target.processor, "processor");
    if (!processor.startsWith("/")) {
      throw refuse(
        `processor must be the absolute path of the processor file inside the image, not "${processor}"`,
        { processor },
      );
    }
  }

  const pull = target.pull ?? CONTAINER_DEFAULTS.pull;
  if (pull !== "never" && pull !== "missing" && pull !== "always") {
    throw refuse(
      `pull must be "never", "missing" or "always", not ${String(pull)}`,
      {
        pull,
      },
    );
  }

  let cli: "docker" | "podman" = CONTAINER_DEFAULTS.cli;
  let host: string | undefined;
  if (target.engine !== undefined) {
    if (!isObject(target.engine)) {
      throw refuse("engine must be { cli?, host? }", {
        engine: typeof target.engine,
      });
    }
    for (const key of Object.keys(target.engine)) {
      if (key !== "cli" && key !== "host") {
        throw refuse(`engine does not take ${key}: it takes cli, host`, {
          key,
        });
      }
    }
    const { cli: given, host: endpoint } = target.engine;
    if (given !== undefined) {
      if (given !== "docker" && given !== "podman") {
        throw refuse(
          `engine.cli must be "docker" or "podman", not ${String(given)}`,
          {
            cli: given,
          },
        );
      }
      cli = given;
    }
    if (endpoint !== undefined) {
      host = text(endpoint, "engine.host");
    }
  }

  let runtime: string | undefined;
  if (target.runtime !== undefined) {
    runtime = text(target.runtime, "runtime");
    if (!PROFILE_NAME.test(runtime) || runtime.startsWith("-")) {
      throw refuse(`runtime "${runtime}" is not a runtime name`, { runtime });
    }
  }

  const limits: ResolvedContainerTarget["limits"] = {
    memory: CONTAINER_DEFAULTS.memory,
    cpus: CONTAINER_DEFAULTS.cpus,
    pids: CONTAINER_DEFAULTS.pids,
    tmpfs: CONTAINER_DEFAULTS.tmpfs,
  };
  if (target.limits !== undefined) {
    if (!isObject(target.limits)) {
      throw refuse("limits must be { memory?, cpus?, pids?, tmpfs? }", {
        limits: typeof target.limits,
      });
    }
    for (const [key, value] of Object.entries(target.limits)) {
      if (value === undefined) {
        continue;
      }
      if (key === "memory" || key === "tmpfs") {
        if (typeof value !== "string" || !SIZE.test(value)) {
          throw refuse(
            `limits.${key} must be a size such as "256m", not ${JSON.stringify(value)}`,
            { [key]: value },
          );
        }
        // `0` is no limit at all to the engine, and memory below its floor
        // is refused by the daemon only at the first container.
        const bytes = sizeBytes(value);
        if (key === "memory" && bytes < MEMORY_FLOOR) {
          throw refuse(
            `limits.memory must be at least "6m" (the engine's floor; "0" would mean no limit), not ${JSON.stringify(value)}`,
            { memory: value },
          );
        }
        if (key === "tmpfs" && bytes < 1) {
          throw refuse(
            `limits.tmpfs must be above 0 ("0" would mean no limit), not ${JSON.stringify(value)}`,
            { tmpfs: value },
          );
        }
        limits[key] = value;
      } else if (key === "cpus") {
        if (
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          value <= 0
        ) {
          throw refuse(
            `limits.cpus must be a number above 0, not ${String(value)}`,
            {
              cpus: value,
            },
          );
        }
        limits.cpus = value;
      } else if (key === "pids") {
        // Unlimited (0 or -1 to the engine) is refused: a fork bomb would
        // reach the host's pids.
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < 16
        ) {
          throw refuse(
            `limits.pids must be a whole number of at least 16, not ${String(value)}`,
            {
              pids: value,
            },
          );
        }
        limits.pids = value;
      } else {
        throw refuse(
          `limits does not take ${key}: it takes memory, cpus, pids, tmpfs`,
          {
            key,
          },
        );
      }
    }
  }

  if (target.network !== undefined && target.network !== "none") {
    const name = isObject(target.network)
      ? target.network.name
      : target.network;
    throw refuse(
      name === "host"
        ? "network: the host's network is refused"
        : `network must be "none", not ${JSON.stringify(target.network)}`,
      { network: name },
    );
  }

  const env: Record<string, string> = {};
  if (target.env !== undefined) {
    if (!isObject(target.env)) {
      throw refuse("env must be an object of string values", {
        env: typeof target.env,
      });
    }
    for (const [name, value] of Object.entries(target.env)) {
      if (!ENV_NAME.test(name)) {
        throw refuse(`env key "${name}" is not a variable name`, { name });
      }
      // `-e NAME` with no value copies the host's NAME into the container,
      // which is the one thing this option must never do.
      if (typeof value !== "string" || value.includes("\0")) {
        throw refuse(
          `env.${name} must be a string value: a variable without one would copy the host's`,
          { name, type: typeof value },
        );
      }
      env[name] = value;
    }
  }

  const mounts: { source: string; target: string; readOnly: boolean }[] = [];
  if (target.mounts !== undefined) {
    if (!Array.isArray(target.mounts)) {
      throw refuse("mounts must be an array of { source, target, readOnly? }", {
        mounts: typeof target.mounts,
      });
    }
    for (const mount of target.mounts as unknown[]) {
      if (!isObject(mount)) {
        throw refuse(
          "mounts entries must be { source, target, readOnly? }",
          {},
        );
      }
      for (const key of Object.keys(mount)) {
        if (key !== "source" && key !== "target" && key !== "readOnly") {
          throw refuse(
            `mounts entries do not take ${key}: they take source, target, readOnly`,
            {
              key,
            },
          );
        }
      }
      const source = mountPath(mount.source, "mounts source");
      const into = mountPath(mount.target, "mounts target");
      if (posix.normalize(into) === "/") {
        throw refuse("mounts target may not be /", { target: into });
      }
      checkMountSource(source, host);
      if (mount.readOnly !== undefined && typeof mount.readOnly !== "boolean") {
        throw refuse("mounts readOnly must be a boolean", {
          readOnly: mount.readOnly,
        });
      }
      mounts.push({ source, target: into, readOnly: mount.readOnly !== false });
    }
  }

  if (target.allowRoot !== undefined && typeof target.allowRoot !== "boolean") {
    throw refuse("allowRoot must be a boolean", {
      allowRoot: target.allowRoot,
    });
  }
  const user =
    target.user === undefined
      ? CONTAINER_DEFAULTS.user
      : text(target.user, "user");
  const ids = /^(\d+):(\d+)$/.exec(user);
  if (!ids) {
    throw refuse(
      `user must be a numeric "uid:gid", not "${user}": a name could be root, and a uid alone takes its group from the image, which can be 0`,
      { user },
    );
  }
  if (Number(ids[1]) === 0 && target.allowRoot !== true) {
    throw refuse("user may not be root (uid 0) unless allowRoot is set", {
      user,
    });
  }
  if (Number(ids[2]) === 0 && target.allowRoot !== true) {
    throw refuse(
      "user may not be in the root group (gid 0) unless allowRoot is set: the group owns root's group-readable files",
      { user },
    );
  }

  const security: ResolvedContainerTarget["security"] = {};
  if (target.security !== undefined) {
    if (!isObject(target.security)) {
      throw refuse("security must be { seccomp?, apparmor? }", {
        security: typeof target.security,
      });
    }
    for (const [key, value] of Object.entries(target.security)) {
      if (value === undefined) {
        continue;
      }
      if (key !== "seccomp" && key !== "apparmor") {
        throw refuse(
          `security does not take ${key}: ${REFUSED_KEYS[key] ?? "it takes seccomp, apparmor"}`,
          { key },
        );
      }
      const profile = text(value, `security.${key}`);
      if (profile.toLowerCase() === "unconfined") {
        throw refuse(`security.${key}: "unconfined" is refused`, {
          [key]: profile,
        });
      }
      if (key === "apparmor" && !PROFILE_NAME.test(profile)) {
        throw refuse(`security.apparmor "${profile}" is not a profile name`, {
          apparmor: profile,
        });
      }
      security[key] = profile;
    }
  }

  return {
    kind: "container",
    image,
    processor,
    pull,
    cli,
    host,
    runtime,
    limits,
    env,
    mounts,
    user,
    security,
    closeTimeout:
      target.closeTimeout === undefined
        ? CONTAINER_DEFAULTS.closeTimeout
        : amount(target.closeTimeout, "closeTimeout", 0),
    maxLogBytes:
      target.maxLogBytes === undefined
        ? CONTAINER_DEFAULTS.maxLogBytes
        : amount(target.maxLogBytes, "maxLogBytes", 0),
  };
}

/** Who a container belongs to: what its labels say. */
export interface ContainerOwner {
  /** The worker's stable key. */
  workerKey: string;
  /** The worker's incarnation id. */
  workerId: string;
  /** The namespace. */
  namespace: string;
  /** The queue. */
  queue: string;
}

/**
 * The script `bun -e` runs inside the container: finds the bun-jobs container
 * entry from the processor's directory — where the image's app and its
 * dependencies are — and imports it. The entry reads the prefix and the
 * processor from the same argv.
 */
export const CONTAINER_BOOTSTRAP =
  'const f=process.argv.at(-1);await import(Bun.resolveSync("@kingsleyweb/bun-jobs/container-entry",f.slice(0,f.lastIndexOf("/"))||"/"))';

/**
 * The script the start-up probe runs instead: the same resolution, and a
 * check that the processor file is there, without importing either. Exits
 * non-zero, saying which is missing, when one is.
 */
export const CONTAINER_PROBE =
  'const f=process.argv.at(-1);try{Bun.resolveSync("@kingsleyweb/bun-jobs/container-entry",f.slice(0,f.lastIndexOf("/"))||"/")}catch(e){console.error("@kingsleyweb/bun-jobs/container-entry does not resolve from "+f+": "+e.message);process.exit(3)}if(!(await Bun.file(f).exists())){console.error("the processor "+f+" is not in the image");process.exit(4)}';

/**
 * The full `run` argument list for one container, after the CLI's name:
 * the fixed hardening, the target's options, the labels, and the command.
 *
 * `script` is {@link CONTAINER_BOOTSTRAP} for an attempt and
 * {@link CONTAINER_PROBE} for the probe; everything else is identical, which
 * is what lets the probe prove the attempt's flags.
 */
export function containerRunArgs(
  /** The resolved target. */
  target: ResolvedContainerTarget,
  /** What the container is for. */
  run: {
    /** The container's name. */
    name: string;
    /** Whose it is, for the labels. */
    owner: ContainerOwner;
    /** The channel's line prefix. */
    prefix: string;
    /** The processor's path inside the image. */
    processor: string;
    /** The `bun -e` script. */
    script: string;
    /** Variables bun-jobs itself sets, after the target's own. */
    markers: Readonly<Record<string, string>>;
  },
): string[] {
  const { limits } = target;
  const args = [
    "run",
    "--interactive",
    "--rm",
    // A small init as PID 1 (Docker's tini, Podman's catatonit): it forwards
    // signals to Bun and reaps orphaned grandchildren, which Bun as PID 1
    // would neither do (a processor signalling itself hung; zombies counted
    // against the pids limit).
    "--init",
    `--name=${run.name}`,
    // An attempt never pulls: the probe did, or the image was there.
    "--pull=never",
    // Fixed hardening: none of these is an option.
    "--read-only",
    "--cap-drop=ALL",
    "--ipc=none",
    "--security-opt=no-new-privileges",
    "--network=none",
    `--user=${target.user}`,
    `--memory=${limits.memory}`,
    `--memory-swap=${limits.memory}`,
    `--cpus=${limits.cpus}`,
    `--pids-limit=${limits.pids}`,
    `--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=${limits.tmpfs}`,
  ];
  if (target.runtime !== undefined) {
    args.push(`--runtime=${target.runtime}`);
  }
  if (target.security.seccomp !== undefined) {
    args.push(`--security-opt=seccomp=${target.security.seccomp}`);
  }
  if (target.security.apparmor !== undefined) {
    args.push(`--security-opt=apparmor=${target.security.apparmor}`);
  }
  args.push(
    `--label=${CONTAINER_LABELS.workerKey}=${run.owner.workerKey}`,
    `--label=${CONTAINER_LABELS.workerId}=${run.owner.workerId}`,
    `--label=${CONTAINER_LABELS.namespace}=${run.owner.namespace}`,
    `--label=${CONTAINER_LABELS.queue}=${run.owner.queue}`,
  );
  // Always `NAME=value`: `--env=NAME` alone would copy the host's NAME. The
  // markers go last, so the target's own env cannot replace them.
  for (const [name, value] of Object.entries({
    ...target.env,
    ...run.markers,
  })) {
    args.push(`--env=${name}=${value}`);
  }
  for (const mount of target.mounts) {
    args.push(
      `--mount=type=bind,source=${mount.source},target=${mount.target}${mount.readOnly ? ",readonly" : ""}`,
    );
  }
  args.push(
    "--entrypoint=bun",
    target.image,
    // The image's `.env` is not the job's environment either.
    "--no-env-file",
    "-e",
    run.script,
    run.prefix,
    run.processor,
  );
  return args;
}
