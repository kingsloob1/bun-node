#!/usr/bin/env bun
import { availableParallelism } from "node:os";
import process from "node:process";

/**
 * Provisions the database servers the integration suites need.
 *
 * The suites for Redis, Postgres, MariaDB, MySQL and MongoDB skip unless their URL
 * is set, which is the right default but leaves "how do I actually run them?"
 * unanswered. This script answers it, and is safe to run repeatedly:
 *
 *   - a server that is already installed is never reinstalled;
 *   - configuration runs only when connecting with the expected credentials
 *     fails, so an existing database, user or password is left alone;
 *   - nothing is ever dropped, reset or overwritten.
 *
 * ```bash
 * bun scripts/setup-databases.ts              # install what is missing, configure what is not
 * bun scripts/setup-databases.ts --dry-run    # print the plan, change nothing
 * bun scripts/setup-databases.ts --docker     # containers instead of system packages
 * bun scripts/setup-databases.ts --only=mongodb
 * bun scripts/setup-databases.ts --max-connections=800
 * bun scripts/setup-databases.ts --print-env  # just the env vars for the suites
 * ```
 */

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

/** The servers this script knows how to provide. */
const SERVICES = ["redis", "postgres", "mariadb", "mysql", "mongodb"] as const;

/** One of the servers this script knows how to provide. */
type Service = (typeof SERVICES)[number];

/** How a server is provided. */
type Mode = "native" | "docker";

/**
 * The `max_connections` MariaDB and MySQL are given unless `--max-connections`
 * says otherwise; change it here. Their default of 151 is too few: measured
 * during one 16-worker `bun test --parallel` run of bun-jobs against every
 * database, the peak was about 180 connections per server (Postgres 182,
 * MySQL 171, and MariaDB pinned at its 151 ceiling with a `Too many
 * connections`, errno 1040). Two runs at once need about 350 to 400. The
 * servers are shared with other sessions and the examples, so this leaves
 * room for several concurrent runs plus everyone else. That is on
 * {@link BASELINE_CORES} cores: the suites run one worker per core, so a bigger
 * host gets more, in proportion ({@link connectionsForCores}).
 *
 * A server already at or above the target is left alone: this never lowers a
 * limit somebody raised further on purpose.
 */
export const MAX_CONNECTIONS = 1000;

/**
 * The highest `max_connections` MariaDB and MySQL accept. Both clamp anything
 * larger to this, so a larger target could never be met and every run would
 * try to raise it again.
 */
export const MAX_CONNECTIONS_CEILING = 100_000;

/**
 * The `max_connections` Postgres is given unless `--postgres-max-connections`
 * says otherwise; change it here. One 16-worker `bun test --parallel` run of
 * bun-jobs peaked at 182 Postgres connections against the default of 100, so
 * this leaves room for several concurrent runs plus the server's other users.
 * Lower than {@link MAX_CONNECTIONS} because every Postgres connection is a
 * process with its own memory, where MariaDB's and MySQL's are threads. Like
 * it, this is the figure for {@link BASELINE_CORES} cores, scaled up on a
 * bigger host ({@link connectionsForCores}).
 *
 * Unlike MariaDB and MySQL, Postgres applies a new value only on a restart,
 * which this script never does unless `--restart-postgres` asks for it.
 */
export const POSTGRES_MAX_CONNECTIONS = 700;

/**
 * The highest `--postgres-max-connections` this script accepts. Postgres
 * itself accepts up to 262,143, but it reserves shared memory and semaphores
 * for every slot when it starts, and a value the machine cannot back makes it
 * refuse to start. Set through `ALTER SYSTEM`, that value sits in
 * `postgresql.auto.conf`, so the server stays down until someone edits the
 * file by hand. 10,000 is far above what a test machine needs and below where
 * that becomes likely; past it, a connection pooler is the answer.
 */
export const POSTGRES_MAX_CONNECTIONS_CEILING = 10_000;

/** The image this script's Postgres container runs. */
export const POSTGRES_CONTAINER_IMAGE = "postgres:16-alpine";

/**
 * Where the official Postgres images keep their data: `PGDATA` is
 * `/var/lib/postgresql/data` on 16, and a versioned directory below this on
 * newer ones, so a search for `postgresql.auto.conf` starts here.
 */
export const POSTGRES_DATA_ROOT = "/var/lib/postgresql";

/**
 * The core count {@link MAX_CONNECTIONS} and {@link POSTGRES_MAX_CONNECTIONS}
 * were measured on. Every test suite runs `bun test --parallel`, one worker
 * per core, and each bun-jobs worker holds its own connections, so the
 * connections a run needs grow with the host's cores. Measured 2026-10-10
 * during a full 16-worker run of bun-jobs with all five database URLs
 * (sampled each second): peaks of 191 on Postgres, 201 on MySQL, 181 on
 * MariaDB and 17 on Redis — about 12 a worker per SQL server, so 1000 and
 * 700 per 16 cores leave a margin of about 3.5 to 5 times one run.
 */
export const BASELINE_CORES = 16;

/**
 * The default `max_connections` for a host with `cores` CPU cores: `base`,
 * which was measured on {@link BASELINE_CORES}, scaled up in proportion on a
 * bigger host and never below `base` on a smaller one (other sessions and the
 * examples share the servers whatever the core count), nor above `ceiling`.
 * On this repo's 16-core machine it is `base` itself.
 */
export function connectionsForCores(
  base: number,
  ceiling: number,
  cores: number = availableParallelism(),
): number {
  return Math.min(
    ceiling,
    Math.max(base, Math.ceil((base * cores) / BASELINE_CORES)),
  );
}

/** {@link MAX_CONNECTIONS} for this host's cores: `--max-connections`' default. */
export function defaultMaxConnections(cores?: number): number {
  return connectionsForCores(MAX_CONNECTIONS, MAX_CONNECTIONS_CEILING, cores);
}

/**
 * {@link POSTGRES_MAX_CONNECTIONS} for this host's cores:
 * `--postgres-max-connections`' default.
 */
export function defaultPostgresMaxConnections(cores?: number): number {
  return connectionsForCores(
    POSTGRES_MAX_CONNECTIONS,
    POSTGRES_MAX_CONNECTIONS_CEILING,
    cores,
  );
}

/** A command line this script cannot act on; `main` prints it and exits 1. */
export class UsageError extends Error {
  override name = "UsageError";
}

/** Everything the run was asked to do. */
interface Options {
  /** Which servers to work on. */
  services: Service[];
  /** Whether to use system packages or containers. */
  mode: Mode;
  /** Print the plan without changing anything. */
  dryRun: boolean;
  /** Print the environment variables and exit. */
  printEnv: boolean;
  /** Do not ask before installing. */
  assumeYes: boolean;
  /** Password for the users this script creates. */
  password: string;
  /** Database this script creates. */
  database: string;
  /** User this script creates. */
  user: string;
  /**
   * The `max_connections` MariaDB and MySQL should have at least. Defaults to
   * {@link MAX_CONNECTIONS} scaled to this host's cores
   * ({@link defaultMaxConnections}); a server already above it is left alone.
   */
  maxConnections: number;
  /**
   * The `max_connections` Postgres should have at least. Defaults to
   * {@link POSTGRES_MAX_CONNECTIONS} scaled to this host's cores
   * ({@link defaultPostgresMaxConnections}); a server already above it is
   * left alone.
   * A raise applies only after a restart.
   */
  postgresMaxConnections: number;
  /**
   * Restart Postgres when its `max_connections` was raised (or a raise is
   * pending), then wait for it and confirm the value. Off by default, because
   * a restart drops every open connection on a shared server.
   */
  restartPostgres: boolean;
}

/**
 * Reads a connection limit's value: a whole number from 1 to `ceiling`,
 * written in plain digits. Throws a {@link UsageError} naming `flag` for
 * anything else, so `1e3`, `500.5` and `-1` are refused rather than
 * reinterpreted. The defaults are `--max-connections`'.
 */
export function parseMaxConnections(
  raw: string,
  flag = "--max-connections",
  ceiling = MAX_CONNECTIONS_CEILING,
  why = "the most MariaDB and MySQL accept",
): number {
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new UsageError(
      `${flag} must be a positive whole number, not "${raw}"`,
    );
  }
  if (value > ceiling) {
    throw new UsageError(
      `${flag} must be at most ${ceiling}, ${why}, not ${value}`,
    );
  }
  return value;
}

/**
 * Reads the command line into {@link Options}. Throws a {@link UsageError} for
 * an argument it cannot act on; `--help` prints usage and exits.
 */
export function parseArgs(argv: string[]): Options {
  const options: Options = {
    services: [...SERVICES],
    mode: "native",
    dryRun: false,
    printEnv: false,
    assumeYes: false,
    password: "bunjobs",
    database: "bun_jobs_test",
    user: "bunjobs",
    maxConnections: defaultMaxConnections(),
    postgresMaxConnections: defaultPostgresMaxConnections(),
    restartPostgres: false,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--print-env") {
      options.printEnv = true;
    } else if (arg === "--yes" || arg === "-y") {
      options.assumeYes = true;
    } else if (arg === "--docker") {
      options.mode = "docker";
    } else if (arg === "--native") {
      options.mode = "native";
    } else if (arg.startsWith("--mode=")) {
      const mode = arg.slice("--mode=".length);
      if (mode !== "native" && mode !== "docker") {
        throw new UsageError(
          `--mode must be "native" or "docker", not "${mode}"`,
        );
      }
      options.mode = mode;
    } else if (arg.startsWith("--only=")) {
      const names = arg.slice("--only=".length).split(",").filter(Boolean);
      for (const name of names) {
        if (!SERVICES.includes(name as Service)) {
          throw new UsageError(
            `Unknown service "${name}". Known: ${SERVICES.join(", ")}`,
          );
        }
      }
      options.services = names as Service[];
    } else if (arg.startsWith("--password=")) {
      options.password = arg.slice("--password=".length);
    } else if (arg.startsWith("--database=")) {
      options.database = arg.slice("--database=".length);
    } else if (arg.startsWith("--user=")) {
      options.user = arg.slice("--user=".length);
    } else if (arg.startsWith("--max-connections=")) {
      options.maxConnections = parseMaxConnections(
        arg.slice("--max-connections=".length),
      );
    } else if (arg.startsWith("--postgres-max-connections=")) {
      options.postgresMaxConnections = parseMaxConnections(
        arg.slice("--postgres-max-connections=".length),
        "--postgres-max-connections",
        POSTGRES_MAX_CONNECTIONS_CEILING,
        "past which a server that cannot reserve the memory refuses to start",
      );
    } else if (arg === "--restart-postgres") {
      options.restartPostgres = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new UsageError(`Unrecognised argument "${arg}". Try --help.`);
    }
  }

  return options;
}

/** Prints usage. */
function printHelp(): void {
  console.log(`
Provision the database servers the bun-jobs integration suites need.

Usage
  bun scripts/setup-databases.ts [options]

Options
  --only=a,b        Only these servers (${SERVICES.join(", ")})
  --mode=native     Use system packages (the default)
  --mode=docker     Use containers instead
  --docker          Shorthand for --mode=docker
  --dry-run         Print what would happen, change nothing
  --print-env       Print the env vars for the suites and exit
  --yes, -y         Do not ask before installing
  --user=NAME       User to create (default: bunjobs)
  --password=PASS   Password for that user (default: bunjobs)
  --database=NAME   Database to create (default: bun_jobs_test)
  --max-connections=N
                    The max_connections MariaDB and MySQL should have at
                    least. A server already at or above it is left alone;
                    one below is raised. Scales with the host's cores:
                    ${MAX_CONNECTIONS} per ${BASELINE_CORES}, never less.
                    (default here, ${availableParallelism()} cores: ${defaultMaxConnections()})
  --postgres-max-connections=N
                    The same for Postgres. A raise is written with ALTER
                    SYSTEM and applies only after a restart. At most
                    ${POSTGRES_MAX_CONNECTIONS_CEILING}. Scales the same way:
                    ${POSTGRES_MAX_CONNECTIONS} per ${BASELINE_CORES} cores, never less.
                    (default here: ${defaultPostgresMaxConnections()}) Every
                    connection reserves shared memory at start: a value the
                    machine cannot back keeps Postgres from starting after
                    the restart, and the script says how to back it out.
  --restart-postgres
                    Restart Postgres to apply a raised max_connections,
                    then confirm it. Off by default: a restart drops every
                    open connection.

Running it twice is safe: an installed server is not reinstalled, and
configuration runs only when a connection with the expected credentials
fails. Nothing is dropped or overwritten, and no limit is ever lowered.
`);
}

/* ------------------------------------------------------------------ *
 * Small shell helpers
 * ------------------------------------------------------------------ */

/** The escape character introducing an ANSI colour sequence. */
const ESC = "[";

/** ANSI colours, when the terminal wants them. */
const colour = {
  /** Whether to emit escape codes at all. */
  enabled: Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined,
  /** Wraps text in a colour, if enabled. */
  wrap(code: string, text: string): string {
    return colour.enabled ? `${ESC}${code}m${text}${ESC}0m` : text;
  },
  /** Emphasised text. */
  bold: (text: string) => colour.wrap("1", text),
  /** De-emphasised text. */
  dim: (text: string) => colour.wrap("2", text),
  /** Something that succeeded. */
  green: (text: string) => colour.wrap("32", text),
  /** Something that needs attention. */
  yellow: (text: string) => colour.wrap("33", text),
  /** Something that failed. */
  red: (text: string) => colour.wrap("31", text),
  /** A value worth copying. */
  cyan: (text: string) => colour.wrap("36", text),
};

/** Prints an error and stops. */
function fail(message: string): never {
  console.error(`${colour.red("error")} ${message}`);
  process.exit(1);
}

/** The result of running a command. */
interface RunResult {
  /** Exit code, or `null` when a signal ended it. */
  code: number | null;
  /** Everything it wrote to stdout. */
  stdout: string;
  /** Everything it wrote to stderr. */
  stderr: string;
  /** Whether it exited zero. */
  ok: boolean;
}

/** Runs a command and captures its output, never throwing. */
async function run(
  argv: string[],
  options?: {
    /** Written to the command's stdin. */
    input?: string;
    /** Extra environment for the command. */
    env?: Record<string, string>;
  },
): Promise<RunResult> {
  // The stdin type depends on whether input was given, which is more detail
  // than any caller needs.
  const proc = Bun.spawn(argv, {
    stdin: options?.input ? new TextEncoder().encode(options.input) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options?.env },
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { code, stdout, stderr, ok: code === 0 };
}

/** Whether a binary is on the PATH. */
function has(binary: string): boolean {
  return Bun.which(binary) !== null;
}

/** The last few lines of a failure, which is the part worth showing. */
function tail(text: string, lines = 3): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

/** Asks a yes/no question, unless `--yes` or `--dry-run` was given. */
async function confirm(question: string, options: Options): Promise<boolean> {
  if (options.assumeYes || options.dryRun) {
    return true;
  }

  process.stdout.write(`${question} [y/N] `);
  // One line is the whole answer: take it off the iterator, then close the
  // iterator, which is exactly what leaving a `for await` early did.
  const lines = console[Symbol.asyncIterator]();
  const answer = await lines.next();
  if (answer.done) {
    return false;
  }

  await lines.return?.();
  return /^y(?:es)?$/i.test(answer.value.trim());
}

/** Reports what the script is doing. */
const log = {
  /** A section heading. */
  section: (text: string) => console.log(`\n${colour.bold(text)}`),
  /** Something that was already in place. */
  skip: (text: string) =>
    console.log(`  ${colour.dim("-")} ${colour.dim(text)}`),
  /** Something that was done. */
  did: (text: string) => console.log(`  ${colour.green("+")} ${text}`),
  /** Something that needs attention. */
  warn: (text: string) => console.log(`  ${colour.yellow("!")} ${text}`),
  /** Something that failed. */
  bad: (text: string) => console.log(`  ${colour.red("x")} ${text}`),
  /** A command about to run. */
  cmd: (argv: string[]) =>
    console.log(`  ${colour.dim(`$ ${argv.join(" ")}`)}`),
};

/* ------------------------------------------------------------------ *
 * Platform
 * ------------------------------------------------------------------ */

/** A package manager this script can drive. */
type Manager = "apt" | "dnf" | "pacman" | "zypper" | "brew";

/** How this machine installs and runs software. */
interface Platform {
  /** The package manager, or `null` when none was found. */
  manager: Manager | null;
  /** Whether commands need `sudo`. */
  needsSudo: boolean;
  /** Whether services are managed by systemd. */
  systemd: boolean;
  /** Whether Docker is usable. */
  docker: boolean;
}

/** Works out how this machine installs and runs things. */
async function detectPlatform(): Promise<Platform> {
  const manager: Manager | null = has("apt-get")
    ? "apt"
    : has("dnf")
      ? "dnf"
      : has("pacman")
        ? "pacman"
        : has("zypper")
          ? "zypper"
          : has("brew")
            ? "brew"
            : null;

  const docker = has("docker") ? (await run(["docker", "info"])).ok : false;

  return {
    manager,
    // Homebrew installs into a user-owned prefix; everything else needs root.
    needsSudo: manager !== "brew" && process.getuid?.() !== 0,
    systemd: has("systemctl"),
    docker,
  };
}

/** Prefixes a command with `sudo` when this machine needs it. */
function elevate(
  platform: Pick<Platform, "needsSudo">,
  argv: string[],
): string[] {
  return platform.needsSudo ? ["sudo", ...argv] : argv;
}

/** Installs packages with whatever this machine uses. */
async function installPackages(
  platform: Platform,
  packages: string[],
  options: Options,
): Promise<boolean> {
  if (!platform.manager) {
    log.bad("no supported package manager found; try --docker");
    return false;
  }

  const commands: Record<Manager, string[][]> = {
    apt: [
      ["apt-get", "update"],
      ["apt-get", "install", "-y", ...packages],
    ],
    dnf: [["dnf", "install", "-y", ...packages]],
    pacman: [["pacman", "-Sy", "--noconfirm", ...packages]],
    zypper: [["zypper", "--non-interactive", "install", ...packages]],
    brew: [["brew", "install", ...packages]],
  };

  for (const argv of commands[platform.manager]) {
    const full = elevate(platform, argv);
    log.cmd(full);

    if (options.dryRun) {
      continue;
    }

    const result = await run(full);
    if (!result.ok) {
      log.bad(tail(result.stderr) || "the install failed");
      return false;
    }
  }

  return true;
}

/** Starts a service and enables it at boot, however this machine does that. */
async function startService(
  platform: Platform,
  unit: string,
  options: Options,
): Promise<boolean> {
  if (platform.manager === "brew") {
    const argv = ["brew", "services", "start", unit];
    log.cmd(argv);
    return options.dryRun ? true : (await run(argv)).ok;
  }

  if (!platform.systemd) {
    log.warn(`no systemd here, so start ${unit} yourself`);
    return false;
  }

  for (const verb of ["enable", "start"]) {
    const argv = elevate(platform, ["systemctl", verb, unit]);
    log.cmd(argv);

    if (options.dryRun) {
      continue;
    }

    const result = await run(argv);
    if (!result.ok) {
      log.bad(tail(result.stderr) || `systemctl ${verb} ${unit} failed`);
      return false;
    }
  }

  return true;
}

/* ------------------------------------------------------------------ *
 * Reachability
 * ------------------------------------------------------------------ */

/** Whether something is listening on a port. */
async function portOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      hostname: host,
      port,
      socket: { data() {}, error() {} },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/** Waits for a port to accept connections. */
async function waitForPort(port: number, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await portOpen(port)) {
      return true;
    }
    await Bun.sleep(250);
  }

  return false;
}

/* ------------------------------------------------------------------ *
 * Docker mode
 * ------------------------------------------------------------------ */

/**
 * The open-file limit, soft and hard, every container is created with. Above
 * MongoDB's documented minimum of 64,000.
 */
const OPEN_FILE_LIMIT = 65_536;

/** What a container needs to exist. */
export interface ContainerSpec {
  /** Container name, also how an existing one is recognised. */
  name: string;
  /** Image to run. */
  image: string;
  /** Port published on the loopback interface. */
  port: number;
  /**
   * The port the server listens on inside the container, when it differs from
   * the published one — MySQL listens on 3306 but is published on 3307, so it
   * can run beside MariaDB. Defaults to `port`.
   */
  containerPort?: number;
  /** Environment the image reads when it first initialises itself. */
  env: Record<string, string>;
  /**
   * Arguments for the server, placed after the image name. The MariaDB and
   * MySQL images pass arguments starting with `-` to the server, so
   * `--max-connections=500` lands on `mariadbd`/`mysqld`. Like `--ulimit`,
   * they are fixed when the container is created.
   */
  args?: string[];
}

/** The `docker run` command that creates a container to `spec`. */
export function dockerRunArgv(spec: ContainerSpec): string[] {
  return [
    "docker",
    "run",
    "--detach",
    "--name",
    spec.name,
    "--restart",
    "unless-stopped",
    // Loopback only: a test database has no business being reachable.
    "--publish",
    `127.0.0.1:${spec.port}:${spec.containerPort ?? spec.port}`,
    // The Docker daemon's default soft open-file limit can be as low as 1,024.
    // MongoDB's WiredTiger opens files per collection and index, and at 1,024
    // a few test runs in a row exhausted it: errno 24, a panic, a crashed
    // server. MongoDB's documented minimum is 64,000. Every container gets
    // it, so a database added later does too. Docker cannot change this on
    // an existing container; it applies when one is created.
    "--ulimit",
    `nofile=${OPEN_FILE_LIMIT}:${OPEN_FILE_LIMIT}`,
    ...Object.entries(spec.env).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ]),
    spec.image,
    ...(spec.args ?? []),
  ];
}

/**
 * The `max_connections` a container's command line sets, or `null` when it
 * sets none. Accepts both spellings the servers do, `--max-connections=` and
 * `--max_connections=`; the last one wins, as it does for the server.
 */
export function maxConnectionsArg(
  cmd: readonly string[] | null,
): number | null {
  let found: number | null = null;
  for (const arg of cmd ?? []) {
    const match = /^--max[-_]connections=(\d+)$/.exec(arg);
    if (match) {
      found = Number(match[1]);
    }
  }
  return found;
}

/** A container's state (`running`, `exited`, ...), or `""` when there is none. */
async function containerState(name: string): Promise<string> {
  const existing = await run([
    "docker",
    "ps",
    "--all",
    "--filter",
    `name=^/${name}$`,
    "--format",
    "{{.State}}",
  ]);
  return existing.ok ? existing.stdout.trim() : "";
}

/** A container's command line (`Config.Cmd`), or `null` when it cannot be read. */
async function containerCmd(name: string): Promise<string[] | null> {
  const inspected = await run([
    "docker",
    "container",
    "inspect",
    "--format",
    "{{json .Config.Cmd}}",
    name,
  ]);
  if (!inspected.ok) {
    return null;
  }
  try {
    const cmd = JSON.parse(inspected.stdout.trim()) as unknown;
    return Array.isArray(cmd) ? cmd.map(String) : null;
  } catch {
    return null;
  }
}

/**
 * Warns when an existing container was created without the open-file limit.
 * Docker fixes ulimits at creation, so an older container keeps the daemon's
 * default until it is recreated; this only reports, and changes nothing.
 */
async function checkContainerLimit(name: string): Promise<void> {
  const inspected = await run([
    "docker",
    "container",
    "inspect",
    "--format",
    "{{json .HostConfig.Ulimits}}",
    name,
  ]);

  // No such container, or no Docker: nothing to check.
  if (!inspected.ok) {
    return;
  }

  /** One entry of `docker inspect`'s `HostConfig.Ulimits`; the list is `null` when none are set. */
  type Ulimits = Array<{ Name: string; Soft: number }> | null;
  let limits: Ulimits;
  try {
    // Cast to the named type: `typeof limits` here would read the narrowed
    // type of a variable not yet assigned, not its declaration.
    limits = JSON.parse(inspected.stdout.trim()) as Ulimits;
  } catch {
    return;
  }

  const soft = limits?.find((limit) => limit.Name === "nofile")?.Soft;
  if (soft !== undefined && soft >= OPEN_FILE_LIMIT) {
    return;
  }

  log.warn(
    `container ${name} has ${soft === undefined ? "the Docker daemon's default open-file limit" : `an open-file limit of ${soft}`}; recreate it to get --ulimit nofile=${OPEN_FILE_LIMIT}:${OPEN_FILE_LIMIT} (keep its data with --volumes-from)`,
  );
}

/** Starts a container, reusing one that already exists. */
async function ensureContainer(
  spec: ContainerSpec,
  options: Options,
): Promise<boolean> {
  const state = await containerState(spec.name);

  if (state === "running") {
    log.skip(`container ${spec.name} is already running`);
    await checkContainerLimit(spec.name);
    return true;
  }

  if (state) {
    await checkContainerLimit(spec.name);
  }

  if (state) {
    const argv = ["docker", "start", spec.name];
    log.cmd(argv);

    if (options.dryRun) {
      return true;
    }

    if (!(await run(argv)).ok) {
      log.bad(`could not start the existing container ${spec.name}`);
      return false;
    }

    log.did(`started the existing container ${spec.name}`);
    return await waitForPort(spec.port);
  }

  const argv = dockerRunArgv(spec);

  log.cmd(argv);

  if (options.dryRun) {
    return true;
  }

  const created = await run(argv);
  if (!created.ok) {
    log.bad(tail(created.stderr, 2));
    return false;
  }

  log.did(`created container ${spec.name} from ${spec.image}`);
  return await waitForPort(spec.port);
}

/* ------------------------------------------------------------------ *
 * Services
 * ------------------------------------------------------------------ */

/** What one server needs, and how to tell whether it needs it. */
interface ServicePlan {
  /** Which server this is. */
  service: Service;
  /** Port it listens on. */
  port: number;
  /** Environment variable the suites read. */
  envVar: string;
  /** The URL the suites should use once it is ready. */
  url: (options: Options) => string;
  /** Whether its binaries are present. */
  installed: () => boolean;
  /** Packages to install, per manager. */
  packages: Partial<Record<Manager, string[]>>;
  /** Service unit to enable and start. */
  unit: (platform: Platform) => string;
  /** The container to run in docker mode. */
  container: (options: Options) => ContainerSpec;
  /** Whether connecting with the expected credentials works. */
  configured: (options: Options) => Promise<boolean>;
  /** Creates the user and database. Called only when `configured` is false. */
  configure: (platform: Platform, options: Options) => Promise<boolean>;
  /** What configuring this server did, for the log. */
  configureNote: (options: Options) => string;
  /** Extra advice when this server needs more than a package install. */
  manualHint?: string;
  /**
   * Whether this script keeps the server's `max_connections` at or above
   * `--max-connections` live (MariaDB and MySQL). Postgres is handled apart,
   * by `ensurePostgresLimit`, because its value applies only on a restart.
   */
  managesConnectionLimit?: boolean;
  /**
   * The root (for Postgres, superuser) account of the container this script
   * creates, which can raise `max_connections` on a container that already
   * exists below the target.
   */
  containerRootUrl?: (options: Options) => string;
  /**
   * Why this server is only ever provided as a container, when it is. Such a
   * plan takes the container path even in native mode, and says this when
   * Docker is not usable rather than reporting an unexplained failure.
   */
  dockerOnly?: string;
  /**
   * How long a freshly created container may take to accept the expected
   * credentials, in milliseconds. Defaults to 90 seconds. MySQL initialises
   * its data directory on first start and routinely needs longer, and giving
   * up early reports a server as broken that is merely still starting.
   */
  readyTimeout?: number;
}

/**
 * Why the last `sqlReachable` call failed, so a server that never becomes
 * ready can say what was actually wrong instead of "it did not become ready".
 */
let lastSqlError = "";

/**
 * Whether a SQL URL can be connected to and queried — the same way the suites
 * connect, which is the only check worth making.
 *
 * `allowPublicKeyRetrieval` is taken out of the query and passed as an option,
 * because **Bun's client honours it as an option and ignores it in a URL.** It
 * is a JDBC-style parameter, so a URL carrying it connects exactly as though it
 * were absent, and against MySQL 8.4's `caching_sha2_password` that means it
 * does not connect at all. The driver already does this (`takeBooleanParam` in
 * `packages/bun-jobs/lib/shared/connection.ts`); this check did not, so it
 * called a perfectly good MySQL server unreachable and then waited four minutes
 * to say so. Duplicated rather than imported: nothing else in `scripts/` loads
 * a workspace package, and the root declares no dependency on one.
 */
async function sqlReachable(url: string): Promise<boolean> {
  try {
    const sql = await openSql(url);
    await sql.unsafe("SELECT 1");
    await sql.close();
    lastSqlError = "";
    return true;
  } catch (error) {
    lastSqlError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

/**
 * A client for a SQL URL, connecting the way the suites do: with
 * `allowPublicKeyRetrieval` moved out of the URL into an option (see
 * {@link sqlReachable} for why).
 */
async function openSql(
  url: string,
): Promise<InstanceType<typeof import("bun").SQL>> {
  const { SQL } = await import("bun");

  // Edited as text, so the rest of the URL — an escaped password, a host
  // list — is never reparsed or re-encoded.
  const at = url.indexOf("?");
  let bare = url;
  let allow: boolean | undefined;

  if (at >= 0) {
    const kept: string[] = [];
    for (const pair of url.slice(at + 1).split("&")) {
      const eq = pair.indexOf("=");
      const key = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq));
      if (key.toLowerCase() !== "allowpublickeyretrieval") {
        if (pair !== "") {
          kept.push(pair);
        }
        continue;
      }

      const raw = decodeURIComponent(eq < 0 ? "" : pair.slice(eq + 1))
        .trim()
        .toLowerCase();
      allow = ["true", "1", "yes"].includes(raw);
    }

    bare = url.slice(0, at) + (kept.length > 0 ? `?${kept.join("&")}` : "");
  }

  return new SQL({
    url: bare,
    ...(allow === undefined ? {} : { allowPublicKeyRetrieval: allow }),
  });
}

/**
 * A MariaDB or MySQL server's current `max_connections`, read over `url` — the
 * suites' own connection, which needs no privilege for this — or `null` when
 * the server cannot be reached or the answer is not a number. Postgres has
 * its own reader, `readPostgresLimit`.
 */
async function readMaxConnections(url: string): Promise<number | null> {
  try {
    const sql = await openSql(url);
    try {
      const rows: Array<Record<string, unknown>> = await sql.unsafe(
        "SELECT @@GLOBAL.max_connections AS n",
      );
      const value = Number(rows[0]?.n);
      return Number.isFinite(value) ? value : null;
    } finally {
      await sql.close();
    }
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Connection limit (MariaDB and MySQL)
 * ------------------------------------------------------------------ */

/** What to do about a server's `max_connections`. */
export type LimitPlan =
  /** At or above the target: left alone, never lowered. */
  | { action: "keep"; current: number; target: number }
  /** Below the target: raised to it. */
  | { action: "raise"; current: number; target: number }
  /** Not readable, usually because the server does not exist yet. */
  | { action: "unknown"; current: null; target: number };

/**
 * Decides what to do about a server whose `max_connections` is `current`
 * (`null` when it could not be read). Only ever raises: a server above the
 * target is somebody's deliberate choice.
 */
export function planConnectionLimit(
  current: number | null,
  target: number,
): LimitPlan {
  if (current === null) {
    return { action: "unknown", current, target };
  }
  return current >= target
    ? { action: "keep", current, target }
    : { action: "raise", current, target };
}

/** One line describing a {@link LimitPlan}, for the log and the summary. */
export function describeLimit(plan: LimitPlan): string {
  switch (plan.action) {
    case "keep":
      return `max_connections is ${plan.current}, at least ${plan.target}: left alone`;
    case "raise":
      return `max_connections is ${plan.current}, below ${plan.target}: raising it to ${plan.target}`;
    case "unknown":
      return `max_connections not readable yet: setting it to ${plan.target}`;
  }
}

/** Where a server's `max_connections` lives, which decides how it is raised. */
export type LimitHost = "native" | "container";

/**
 * The statement that raises `max_connections` live. MySQL 8 can `SET PERSIST`,
 * which also writes the value to `mysqld-auto.cnf` in its data directory so a
 * restart keeps it; MariaDB has no such statement, so natively the drop-in file
 * from {@link mariadbLimitCnf} is what makes it last.
 */
export function limitStatement(service: Service, target: number): string {
  return service === "mysql"
    ? `SET PERSIST max_connections = ${target};`
    : `SET GLOBAL max_connections = ${target};`;
}

/** The name of the drop-in file this script writes natively for MariaDB. */
export const MARIADB_LIMIT_FILE = "99-bun-jobs.cnf";

/**
 * The drop-in that keeps a native MariaDB's `max_connections` across restarts.
 * Named `99-` so it is read after the distribution's own files.
 */
export function mariadbLimitCnf(target: number): string {
  return [
    "# Written by bun-node's scripts/setup-databases.ts. The bun-jobs test",
    "# suites run in parallel, and each worker opens its own connection pools,",
    "# which MariaDB's default of 151 connections does not cover.",
    "# Delete this file to manage max_connections yourself.",
    "[mysqld]",
    `max_connections = ${target}`,
    "",
  ].join("\n");
}

/**
 * The directories a native MariaDB reads drop-in files from, most specific
 * first, for each package manager. Debian and Ubuntu read
 * `/etc/mysql/mariadb.conf.d`; the RPM distributions and Arch read
 * `/etc/my.cnf.d`; Homebrew's `my.cnf` includes `etc/my.cnf.d` under its
 * prefix.
 */
export function mariadbConfDirs(manager: Manager | null): string[] {
  switch (manager) {
    case "apt":
      return ["/etc/mysql/mariadb.conf.d", "/etc/mysql/conf.d"];
    case "dnf":
    case "zypper":
    case "pacman":
      return ["/etc/my.cnf.d"];
    case "brew":
      return [
        "/opt/homebrew/etc/my.cnf.d",
        "/usr/local/etc/my.cnf.d",
        "/home/linuxbrew/.linuxbrew/etc/my.cnf.d",
      ];
    default:
      return ["/etc/mysql/conf.d", "/etc/my.cnf.d"];
  }
}

/** One command of a native raise, with what it is fed on stdin. */
export interface LimitStep {
  /** The command, already elevated where this machine needs it. */
  argv: string[];
  /** Written to its stdin. */
  input: string;
  /** How the log shows stdin, which is the point of the step. */
  shown: string;
}

/**
 * The commands that raise a native MariaDB's `max_connections`: the drop-in
 * file through `tee` (written as root, like the rest of the server's
 * configuration), then the live value through the root client, the same
 * elevated path `configure` creates the user with. `confPath` is `null` when
 * no drop-in directory exists, and then only the live value is set.
 */
export function nativeLimitSteps(
  platform: Pick<Platform, "needsSudo">,
  client: string,
  confPath: string | null,
  target: number,
): LimitStep[] {
  const steps: LimitStep[] = [];
  if (confPath) {
    steps.push({
      argv: elevate(platform, ["tee", confPath]),
      input: mariadbLimitCnf(target),
      shown: `[mysqld] max_connections = ${target}`,
    });
  }
  const statement = limitStatement("mariadb", target);
  steps.push({
    argv: elevate(platform, [client, "-u", "root"]),
    input: statement,
    shown: statement,
  });
  return steps;
}

/** Runs a command, as {@link run} does; tests pass a fake. */
export type Runner = (
  argv: string[],
  options?: {
    /** Written to the command's stdin. */
    input?: string;
  },
) => Promise<RunResult>;

/**
 * Runs `steps` in order, logging each, and stops at the first that fails. A
 * dry run logs them and runs nothing.
 */
export async function runLimitSteps(
  steps: LimitStep[],
  dryRun: boolean,
  runner: Runner = run,
): Promise<boolean> {
  for (const step of steps) {
    log.cmd([...step.argv, "<", `(${step.shown})`]);
    if (dryRun) {
      continue;
    }
    const result = await runner(step.argv, { input: step.input });
    if (!result.ok) {
      log.bad(tail(result.stderr, 2) || `${step.argv.join(" ")} failed`);
      return false;
    }
  }
  return true;
}

/**
 * Runs one admin statement over `rootUrl`, resolving its error message or
 * `null`. `simple` sends it over the simple query protocol, which Postgres's
 * `ALTER SYSTEM` needs: it refuses to run inside a transaction block, and an
 * extended-protocol message can count as one.
 */
async function raiseOverSql(
  rootUrl: string,
  statement: string,
  simple = false,
): Promise<string | null> {
  try {
    const sql = await openSql(rootUrl);
    try {
      await (simple ? sql.unsafe(statement).simple() : sql.unsafe(statement));
    } finally {
      await sql.close();
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Brings a MariaDB or MySQL server's `max_connections` up to
 * `options.maxConnections`, never down, and returns a note for the summary.
 *
 * The current value is read over the suites' own URL. A native MariaDB is
 * raised with a drop-in file plus `SET GLOBAL` as root, through `sudo` like
 * the user creation. A container is created with `--max-connections`; one
 * that already exists below the target is raised live through the root
 * account the container was created with, and told to be recreated when its
 * command line would put the old value back on a restart.
 */
async function ensureConnectionLimit(
  plan: ServicePlan,
  host: LimitHost,
  platform: Platform,
  options: Options,
  containerExists: boolean,
): Promise<string> {
  const target = options.maxConnections;
  const current = await readMaxConnections(plan.url(options));
  const decision = planConnectionLimit(current, target);
  const name = plan.container(options).name;

  if (decision.action === "unknown") {
    // Only a dry run reaches a server that is not there yet; a real run has
    // just connected to it, so an unreadable value is a reason to change
    // nothing, since this cannot know it would not be lowering it.
    if (!options.dryRun) {
      log.warn("could not read max_connections, so it was left as it is");
      return "max_connections not readable, left alone";
    }
    log.skip(describeLimit(decision));
    if (host === "container") {
      log.skip(
        containerExists
          ? `max_connections is read once container ${name} is running, and raised to ${target} if it is below`
          : `the container is created with --max-connections=${target}`,
      );
      return containerExists
        ? "max_connections checked once started"
        : `max_connections ${target} once created`;
    }
  } else if (decision.action === "keep") {
    log.skip(describeLimit(decision));
    if (host === "container") {
      await warnUnpinnedLimit(plan.service, name, target, decision.current);
    }
    return `max_connections ${decision.current}`;
  } else {
    log.warn(describeLimit(decision));
  }

  const from = decision.current === null ? "" : `${decision.current} → `;

  if (host === "container") {
    const rootUrl = plan.containerRootUrl?.(options);
    const statement = limitStatement(plan.service, target);
    if (!rootUrl) {
      log.bad(`no root account known for ${name}; run as root: ${statement}`);
      return `max_connections ${decision.current} (not raised)`;
    }
    log.cmd([`(as root, over 127.0.0.1:${plan.port})`, statement]);
    if (!options.dryRun) {
      const error = await raiseOverSql(rootUrl, statement);
      if (error) {
        log.bad(`could not raise it as root: ${error}`);
        return `max_connections ${decision.current} (raise failed)`;
      }
      log.did(`raised max_connections to ${target}`);
    }
    await warnUnpinnedLimit(plan.service, name, target, target);
    return `max_connections ${from}${target}`;
  }

  const client = has("mariadb") ? "mariadb" : has("mysql") ? "mysql" : null;
  if (!client && !options.dryRun) {
    log.bad(
      "no mariadb or mysql client found, so max_connections cannot be raised",
    );
    return `max_connections ${decision.current} (not raised)`;
  }

  const dirs = mariadbConfDirs(platform.manager);
  const existing = [];
  for (const dir of dirs) {
    if (await isDirectory(dir)) {
      existing.push(dir);
    }
  }
  // A dry run before the install has no directory yet; show where it will be.
  const dir = existing[0] ?? (options.dryRun ? dirs[0] : undefined);
  if (!dir) {
    log.warn(
      `no MariaDB drop-in directory found (looked in ${dirs.join(", ")}), so the raise lasts until a restart; add "max_connections = ${target}" under [mysqld] in your my.cnf to keep it`,
    );
  }

  const steps = nativeLimitSteps(
    platform,
    client ?? "mariadb",
    dir ? `${dir}/${MARIADB_LIMIT_FILE}` : null,
    target,
  );
  if (!(await runLimitSteps(steps, options.dryRun))) {
    return `max_connections ${decision.current} (raise failed)`;
  }
  if (!options.dryRun) {
    log.did(`raised max_connections to ${target}`);
  }
  return `max_connections ${from}${target}`;
}

/** Whether `path` is an existing directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Warns when a container's command line does not carry the target, so the
 * value it has now is a runtime setting a restart may undo. MariaDB's
 * `SET GLOBAL` is lost on a restart; MySQL's `SET PERSIST`, which is how this
 * script raises it, is kept, but a value set by hand with `SET GLOBAL` is not.
 * Only reports, like {@link checkContainerLimit}, and never suggests less
 * than the server has now.
 */
async function warnUnpinnedLimit(
  service: Service,
  name: string,
  target: number,
  current: number | null,
): Promise<void> {
  const cmd = await containerCmd(name);
  if (cmd === null) {
    return;
  }
  const pinned = maxConnectionsArg(cmd);
  if (pinned !== null && pinned >= target) {
    return;
  }
  const created =
    pinned === null
      ? "without --max-connections"
      : `with --max-connections=${pinned}`;
  const undo =
    service === "mysql"
      ? "a restart keeps a value set with SET PERSIST but loses one set with SET GLOBAL"
      : "a restart loses the live value";
  const wanted = Math.max(target, current ?? 0);
  log.warn(
    `container ${name} was created ${created}, so ${undo}; recreate it to get --max-connections=${wanted} (keep its data with --volumes-from)`,
  );
}

/* ------------------------------------------------------------------ *
 * Connection limit (Postgres)
 * ------------------------------------------------------------------ */

/** What Postgres reports about its `max_connections`. */
export interface PostgresLimitState {
  /** The value in effect now (`SHOW max_connections`). */
  current: number;
  /** Whether a changed value is waiting for a restart (`pg_settings`). */
  pendingRestart: boolean;
  /**
   * The value waiting for the restart, from `pg_file_settings`, or `null` when
   * none is pending or the view is not readable (it needs a superuser or
   * `pg_read_all_settings`).
   */
  pendingValue: number | null;
}

/** What to do about Postgres's `max_connections`. */
export type PostgresLimitPlan =
  /** At or above the target: left alone, never lowered. */
  | { action: "keep"; current: number; target: number }
  /** A value at least the target is set and waits for a restart: not set again. */
  | {
      action: "pending";
      current: number;
      pending: number | null;
      target: number;
    }
  /** Below the target with nothing sufficient pending: `ALTER SYSTEM`. */
  | { action: "raise"; current: number; target: number }
  /** Not readable, usually because the server does not exist yet. */
  | { action: "unknown"; current: null; target: number };

/**
 * Decides what to do about Postgres's `max_connections`. Only ever raises;
 * a value already set but waiting for a restart is reported, not set again,
 * unless it is known to be below the target.
 */
export function planPostgresLimit(
  state: PostgresLimitState | null,
  target: number,
): PostgresLimitPlan {
  if (state === null) {
    return { action: "unknown", current: null, target };
  }
  const { current, pendingRestart, pendingValue } = state;
  if (current >= target) {
    return { action: "keep", current, target };
  }
  if (pendingRestart && (pendingValue === null || pendingValue >= target)) {
    return { action: "pending", current, pending: pendingValue, target };
  }
  return { action: "raise", current, target };
}

/** One line describing a {@link PostgresLimitPlan}, for the log. */
export function describePostgresLimit(plan: PostgresLimitPlan): string {
  switch (plan.action) {
    case "keep":
      return `max_connections is ${plan.current}, at least ${plan.target}: left alone`;
    case "pending":
      return `max_connections is ${plan.current}, and ${plan.pending ?? "a new value"} is already set and waiting for a restart: not set again`;
    case "raise":
      return `max_connections is ${plan.current}, below ${plan.target}: setting it to ${plan.target} with ALTER SYSTEM`;
    case "unknown":
      return `max_connections not readable yet: setting it to ${plan.target}`;
  }
}

/** The statement that sets Postgres's `max_connections` for the next start. */
export function postgresLimitStatement(target: number): string {
  return `ALTER SYSTEM SET max_connections = ${target};`;
}

/**
 * How this script runs a statement as Postgres's superuser on a native
 * install: a fresh install trusts local connections from the `postgres` OS
 * user, so `psql` runs as that user (`sudo -u postgres`, or `runuser` when
 * already root); Homebrew's cluster belongs to the current user already.
 */
export function postgresAdminArgv(
  platform: Pick<Platform, "needsSudo" | "manager">,
  statement: string,
): string[] {
  const psql = ["psql", "-v", "ON_ERROR_STOP=1", "-c", statement];
  if (platform.manager === "brew") {
    return ["psql", "-v", "ON_ERROR_STOP=1", "-d", "postgres", "-c", statement];
  }
  return platform.needsSudo
    ? ["sudo", "-u", "postgres", ...psql]
    : ["runuser", "-u", "postgres", "--", ...psql];
}

/**
 * The command that restarts Postgres, or `null` when this machine has no way
 * this script knows.
 */
export function postgresRestartArgv(
  host: LimitHost,
  platform: Pick<Platform, "needsSudo" | "manager" | "systemd">,
  unit: string,
  containerName: string,
): string[] | null {
  if (host === "container") {
    return ["docker", "restart", containerName];
  }
  if (platform.manager === "brew") {
    return ["brew", "services", "restart", unit];
  }
  return platform.systemd
    ? elevate(platform, ["systemctl", "restart", unit])
    : null;
}

/**
 * The `max_connections` a Postgres container's command line sets, or `null`.
 * A command-line setting outranks `postgresql.auto.conf`, so while one is
 * there `ALTER SYSTEM` cannot raise it. Reads `-c max_connections=N`,
 * `-cmax_connections=N` and `--max_connections=N` (or `--max-connections`);
 * the last one wins, as it does for Postgres.
 */
export function postgresMaxConnectionsArg(
  cmd: readonly string[] | null,
): number | null {
  let found: number | null = null;
  const list = cmd ?? [];
  for (let i = 0; i < list.length; i++) {
    let arg = list[i] ?? "";
    if (arg === "-c") {
      arg = list[++i] ?? "";
    } else if (arg.startsWith("-c")) {
      arg = arg.slice(2);
    } else if (arg.startsWith("--")) {
      arg = arg.slice(2);
    } else {
      continue;
    }
    const match = /^max[-_]connections=(\d+)$/.exec(arg);
    if (match) {
      found = Number(match[1]);
    }
  }
  return found;
}

/** Where Postgres is and what this run may do to it. */
export interface PostgresLimitContext {
  /** Whether it is a native install or this script's container. */
  host: LimitHost;
  /** How this machine runs commands. */
  platform: Pick<Platform, "needsSudo" | "manager" | "systemd">;
  /** Its service unit, for a native restart. */
  unit: string;
  /** Its container's name, for a container restart. */
  containerName: string;
  /** Whether that container exists already. */
  containerExists: boolean;
  /** What the container's command line pins `max_connections` to, if anything. */
  containerPin: number | null;
  /** Print the plan, change nothing. */
  dryRun: boolean;
  /** Whether `--restart-postgres` was given. */
  restart: boolean;
}

/** What {@link applyPostgresLimit} does its work through; tests pass fakes. */
export interface PostgresLimitIo {
  /** Runs a command: native `psql`, or a restart. */
  runner: Runner;
  /** Runs a statement as the container's superuser; resolves an error or `null`. */
  execSuperuser: (statement: string) => Promise<string | null>;
  /** Waits until the suites' credentials connect again. */
  waitReady: () => Promise<boolean>;
  /** Reads the server's limit again. */
  readState: () => Promise<PostgresLimitState | null>;
}

/**
 * Carries out a {@link PostgresLimitPlan} and returns a note for the summary.
 * Sets the value with `ALTER SYSTEM`, as the container's superuser or through
 * the native `psql` admin path, and then restarts **only** when
 * `--restart-postgres` asked: otherwise it says so and prints the command,
 * because a restart drops every open connection on a shared server. After a
 * restart it waits for the server and re-reads the value to confirm it.
 */
export async function applyPostgresLimit(
  plan: PostgresLimitPlan,
  ctx: PostgresLimitContext,
  io: PostgresLimitIo,
): Promise<string> {
  const { target } = plan;

  if (plan.action === "keep") {
    log.skip(describePostgresLimit(plan));
    return `max_connections ${plan.current}`;
  }

  if (plan.action === "unknown") {
    if (!ctx.dryRun) {
      log.warn("could not read max_connections, so it was left as it is");
      return "max_connections not readable, left alone";
    }
    log.skip(describePostgresLimit(plan));
    if (ctx.host === "container") {
      log.skip(
        ctx.containerExists
          ? `max_connections is read once container ${ctx.containerName} is running, and raised to ${target} if it is below`
          : `the container is created with -c max_connections=${target}`,
      );
      return ctx.containerExists
        ? "max_connections checked once started"
        : `max_connections ${target} once created`;
    }
  } else {
    log.warn(describePostgresLimit(plan));
  }

  // A container started with `-c max_connections=N` keeps N whatever
  // postgresql.auto.conf says, so ALTER SYSTEM and a restart would change
  // nothing. Only recreating the container moves it.
  if (
    ctx.host === "container" &&
    ctx.containerPin !== null &&
    ctx.containerPin < target
  ) {
    log.bad(
      `container ${ctx.containerName} was created with -c max_connections=${ctx.containerPin}, which outranks ALTER SYSTEM; recreate it with -c max_connections=${target} (keep its data with --volumes-from)`,
    );
    return `max_connections ${plan.current ?? "unknown"} (pinned by the container's command line)`;
  }

  if (plan.action !== "pending") {
    const statement = postgresLimitStatement(target);
    if (ctx.host === "container") {
      log.cmd([`(as superuser, over 127.0.0.1:5432)`, statement]);
      if (!ctx.dryRun) {
        const error = await io.execSuperuser(statement);
        if (error) {
          log.bad(`could not set it as the superuser: ${error}`);
          return `max_connections ${plan.current} (raise failed)`;
        }
      }
    } else {
      const argv = postgresAdminArgv(ctx.platform, statement);
      log.cmd(argv);
      if (!ctx.dryRun) {
        const result = await io.runner(argv);
        if (!result.ok) {
          log.bad(tail(result.stderr, 2) || "ALTER SYSTEM failed");
          return `max_connections ${plan.current} (raise failed)`;
        }
      }
    }
  }

  const applied = plan.action === "pending" ? (plan.pending ?? target) : target;
  const from = plan.current === null ? "" : `${plan.current} → `;
  const restartArgv = postgresRestartArgv(
    ctx.host,
    ctx.platform,
    ctx.unit,
    ctx.containerName,
  );

  if (!ctx.restart) {
    log.warn(
      `max_connections set to ${applied}; restart Postgres to apply it (it drops open connections)`,
    );
    log.warn(
      restartArgv
        ? `to apply it now: ${restartArgv.join(" ")}  (or rerun with --restart-postgres)`
        : "restart Postgres however this machine runs it",
    );
    return `max_connections ${plan.current ?? "unknown"}, ${applied} after a restart`;
  }

  if (!restartArgv) {
    log.bad("no known way to restart Postgres here; restart it yourself");
    return `max_connections ${plan.current ?? "unknown"}, ${applied} after a restart`;
  }

  log.cmd(restartArgv);
  if (ctx.dryRun) {
    log.skip("then wait for it to accept connections and re-read the value");
    return `max_connections ${from}${applied} after the restart`;
  }

  const restarted = await io.runner(restartArgv);
  if (!restarted.ok) {
    log.bad(tail(restarted.stderr, 2) || "the restart failed");
    return `max_connections ${plan.current ?? "unknown"} (restart failed)`;
  }
  if (!(await io.waitReady())) {
    log.bad("Postgres did not accept connections again after the restart");
    log.warn(postgresNotBackHint(applied, ctx));
    return "max_connections unknown (not back after the restart)";
  }
  const after = await io.readState();
  if (after === null || after.current < target) {
    log.bad(
      `max_connections is ${after?.current ?? "unreadable"} after the restart, not ${target}`,
    );
    return `max_connections ${after?.current ?? "unknown"} (restart did not apply it)`;
  }
  log.did(`restarted Postgres; max_connections is now ${after.current}`);
  return `max_connections ${from}${after.current}`;
}

/**
 * What to do when Postgres does not come back after a restart that applied a
 * raised `max_connections`. The likeliest cause is the raise itself: Postgres
 * reserves shared memory and lock-table slots for every connection when it
 * starts, and refuses to start when the machine cannot back them (see
 * {@link POSTGRES_MAX_CONNECTIONS_CEILING}). The value sits in
 * `postgresql.auto.conf`, and `ALTER SYSTEM` cannot take it back while the
 * server is down, so the way back is by hand.
 */
export function postgresNotBackHint(
  applied: number,
  ctx: Pick<PostgresLimitContext, "host" | "unit" | "containerName">,
): string {
  const cause = `max_connections ${applied} may need more shared memory than this machine gives Postgres, and then it refuses to start.`;
  const after =
    "then rerun with a lower --postgres-max-connections (or raise the kernel's shared-memory limits first).";
  if (ctx.host === "container") {
    // A stopped container takes no `docker exec`; a copy back through
    // `docker cp` lands owned by root, which Postgres cannot read; and a copy
    // through /tmp fails silently under snap Docker. So a throwaway container
    // of the container's own image edits the file in place on its volume.
    // `sed -i` writes a new file owned by whoever runs it, and the postgres
    // user's uid differs by image (70 on Alpine, 999 on Debian), so it runs as
    // root and gives the file back its owner. The image name is read through
    // `| cat`: snap Docker's captured output can come back empty, and an empty
    // name fails as "invalid reference format". Checked against
    // postgres:16-alpine, with the file owned by 70 and by 999.
    const name = ctx.containerName;
    return [
      cause,
      `Check its log (docker logs ${name} | cat). To back out:`,
      `docker run --rm --user root --volumes-from ${name} --entrypoint sh "$(docker inspect -f '{{.Config.Image}}' ${name} | cat)"`,
      `-c 'for f in $(find ${POSTGRES_DATA_ROOT} -name postgresql.auto.conf); do o=$(stat -c %u:%g "$f"); sed -i "/^max_connections/d" "$f" && chown "$o" "$f"; done'`,
      `&& docker start ${name};`,
      after,
    ].join(" ");
  }
  return [
    cause,
    `Check its log (journalctl -u ${ctx.unit}). To back out, delete the max_connections line from postgresql.auto.conf in its data directory, start it,`,
    after,
  ].join(" ");
}

/**
 * Reads Postgres's `max_connections` over the suites' URL: the value in effect,
 * whether a change waits for a restart, and (when readable) that change.
 */
async function readPostgresLimit(
  url: string,
): Promise<PostgresLimitState | null> {
  try {
    const sql = await openSql(url);
    try {
      // `SHOW` answers with a string. Neither query needs a privilege.
      const shown: Array<Record<string, unknown>> = await sql.unsafe(
        "SHOW max_connections",
      );
      const current = Number(shown[0]?.max_connections);
      if (!Number.isFinite(current)) {
        return null;
      }
      const rows: Array<Record<string, unknown>> = await sql.unsafe(
        "SELECT pending_restart FROM pg_settings WHERE name = 'max_connections'",
      );
      const pendingRestart = rows[0]?.pending_restart === true;
      let pendingValue: number | null = null;
      if (pendingRestart) {
        try {
          // The last valid entry across the files is the one a restart applies.
          const pending: Array<Record<string, unknown>> = await sql.unsafe(
            "SELECT setting FROM pg_file_settings WHERE name = 'max_connections' AND error IS NULL ORDER BY seqno DESC LIMIT 1",
          );
          const value = Number(pending[0]?.setting);
          pendingValue = Number.isFinite(value) ? value : null;
        } catch {
          // Not a superuser: report the pending change without its value.
        }
      }
      return { current, pendingRestart, pendingValue };
    } finally {
      await sql.close();
    }
  } catch {
    return null;
  }
}

/** Brings Postgres's `max_connections` up to the target; see {@link applyPostgresLimit}. */
async function ensurePostgresLimit(
  plan: ServicePlan,
  host: LimitHost,
  platform: Platform,
  options: Options,
  containerExists: boolean,
): Promise<string> {
  const target = options.postgresMaxConnections;
  const name = plan.container(options).name;
  const state = await readPostgresLimit(plan.url(options));
  const decision = planPostgresLimit(state, target);

  if (host === "native" && !has("psql") && !options.dryRun) {
    if (decision.action === "raise") {
      log.bad("psql is missing, so max_connections cannot be raised");
      return `max_connections ${decision.current} (not raised)`;
    }
  }

  const containerPin =
    host === "container" && containerExists && platform.docker
      ? postgresMaxConnectionsArg(await containerCmd(name))
      : null;
  const superuserUrl = plan.containerRootUrl?.(options) ?? plan.url(options);

  return await applyPostgresLimit(
    decision,
    {
      host,
      platform,
      unit: plan.unit(platform),
      containerName: name,
      containerExists,
      containerPin,
      dryRun: options.dryRun,
      restart: options.restartPostgres,
    },
    {
      runner: run,
      execSuperuser: (statement) => raiseOverSql(superuserUrl, statement, true),
      waitReady: () => waitForConfigured(plan, options),
      readState: () => readPostgresLimit(plan.url(options)),
    },
  );
}

/** Every server, in the order they are set up. */
export const PLANS: Record<Service, ServicePlan> = {
  redis: {
    service: "redis",
    port: 6379,
    envVar: "BUN_JOBS_TEST_REDIS_URL",
    // Database 15, so a test run cannot disturb anything on database 0.
    url: () => "redis://127.0.0.1:6379/15",
    installed: () => has("redis-server") || has("redis-cli"),
    packages: {
      apt: ["redis-server"],
      dnf: ["redis"],
      pacman: ["redis"],
      zypper: ["redis"],
      brew: ["redis"],
    },
    unit: (platform) =>
      platform.manager === "brew" ? "redis" : "redis-server",
    container: () => ({
      name: "bun-jobs-redis",
      image: "redis:7-alpine",
      port: 6379,
      env: {},
    }),
    configured: async () => {
      if (!(await portOpen(6379))) {
        return false;
      }

      // Redis needs no user or database created, so reachable is configured.
      if (!has("redis-cli")) {
        return true;
      }

      const pong = await run(["redis-cli", "-h", "127.0.0.1", "ping"]);
      return pong.stdout.trim().toUpperCase() === "PONG";
    },
    configure: async () => true,
    configureNote: () =>
      "nothing to configure: Redis needs no user or database",
  },

  postgres: {
    service: "postgres",
    port: 5432,
    envVar: "BUN_JOBS_TEST_POSTGRES_URL",
    url: (options) =>
      `postgres://${options.user}:${options.password}@127.0.0.1:5432/${options.database}`,
    installed: () => has("postgres") || has("pg_ctl") || has("initdb"),
    packages: {
      apt: ["postgresql"],
      dnf: ["postgresql-server"],
      pacman: ["postgresql"],
      zypper: ["postgresql-server"],
      brew: ["postgresql@16"],
    },
    unit: (platform) =>
      platform.manager === "brew" ? "postgresql@16" : "postgresql",
    container: (options) => ({
      name: "bun-jobs-postgres",
      image: POSTGRES_CONTAINER_IMAGE,
      port: 5432,
      env: {
        POSTGRES_USER: options.user,
        POSTGRES_PASSWORD: options.password,
        POSTGRES_DB: options.database,
      },
      // The image passes arguments starting with `-` to `postgres`.
      args: ["-c", `max_connections=${options.postgresMaxConnections}`],
    }),
    // The image makes POSTGRES_USER its superuser, so the suites' own account
    // is the one that can ALTER SYSTEM in this script's container.
    containerRootUrl: (options) => PLANS.postgres.url(options),
    // The only check that means anything: connect as the user, to the database.
    configured: async (options) =>
      (await portOpen(5432)) &&
      (await sqlReachable(PLANS.postgres.url(options))),
    configure: async (platform, options) => {
      if (!has("psql")) {
        // A dry run has not installed anything yet, so a missing client is
        // expected rather than a failure.
        if (options.dryRun) {
          log.cmd(["psql", "-c", "(create role and database)"]);
          return true;
        }

        log.bad("psql is missing, so the role cannot be created from here");
        return false;
      }

      // Every statement is conditional: an existing role keeps its password
      // and an existing database keeps its contents.
      const statements = [
        `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${options.user}') THEN CREATE ROLE ${options.user} LOGIN PASSWORD '${options.password}'; END IF; END $$;`,
        `SELECT 'CREATE DATABASE ${options.database} OWNER ${options.user}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${options.database}') \\gexec`,
      ];

      for (const statement of statements) {
        // A fresh install trusts local connections from the postgres user.
        const argv = postgresAdminArgv(platform, statement);

        log.cmd(["psql", "-c", `${statement.slice(0, 58)}...`]);

        if (options.dryRun) {
          continue;
        }

        const result = await run(argv);
        if (!result.ok) {
          log.bad(tail(result.stderr, 2));
          return false;
        }
      }

      return true;
    },
    configureNote: (options) =>
      `created the ${options.user} role and the ${options.database} database`,
  },

  mariadb: {
    service: "mariadb",
    port: 3306,
    envVar: "BUN_JOBS_TEST_MARIADB_URL",
    url: (options) =>
      `mariadb://${options.user}:${options.password}@127.0.0.1:3306/${options.database}`,
    installed: () => has("mariadbd") || has("mysqld") || has("mariadb"),
    packages: {
      apt: ["mariadb-server"],
      dnf: ["mariadb-server"],
      pacman: ["mariadb"],
      zypper: ["mariadb"],
      brew: ["mariadb"],
    },
    unit: () => "mariadb",
    container: (options) => ({
      name: "bun-jobs-mariadb",
      image: "mariadb:11",
      port: 3306,
      env: {
        MARIADB_ROOT_PASSWORD: options.password,
        MARIADB_DATABASE: options.database,
        MARIADB_USER: options.user,
        MARIADB_PASSWORD: options.password,
      },
      args: [`--max-connections=${options.maxConnections}`],
    }),
    managesConnectionLimit: true,
    // The database is named because Bun, given none, picks the adapter's name:
    // a `mariadb://` URL asks for a database called `mariadb`, which a stock
    // server does not have ("Unknown database 'mariadb'"). bun-types says the
    // default is the username: oven-sh/bun#44367. Keep the name either way.
    containerRootUrl: (options) =>
      `mariadb://root:${encodeURIComponent(options.password)}@127.0.0.1:3306/${options.database}`,
    configured: async (options) =>
      (await portOpen(3306)) &&
      (await sqlReachable(PLANS.mariadb.url(options))),
    configure: async (platform, options) => {
      const client = has("mariadb") ? "mariadb" : has("mysql") ? "mysql" : null;

      if (!client) {
        // In a dry run the server has not actually been installed yet, so its
        // client is legitimately missing; reporting a failure would be wrong.
        if (options.dryRun) {
          log.cmd(["mariadb", "-u", "root", "<", "(create user and database)"]);
          return true;
        }

        log.bad(
          "no mariadb or mysql client found, so the user cannot be created",
        );
        return false;
      }

      // `IF NOT EXISTS` throughout: an existing user keeps its password and an
      // existing database keeps its tables.
      const sql = [
        `CREATE DATABASE IF NOT EXISTS \`${options.database}\`;`,
        `CREATE USER IF NOT EXISTS '${options.user}'@'%' IDENTIFIED BY '${options.password}';`,
        `CREATE USER IF NOT EXISTS '${options.user}'@'localhost' IDENTIFIED BY '${options.password}';`,
        `GRANT ALL PRIVILEGES ON \`${options.database}\`.* TO '${options.user}'@'%';`,
        `GRANT ALL PRIVILEGES ON \`${options.database}\`.* TO '${options.user}'@'localhost';`,
        "FLUSH PRIVILEGES;",
      ].join("\n");

      const argv = elevate(platform, [client, "-u", "root"]);
      log.cmd([...argv, "<", "(create user and database)"]);

      if (options.dryRun) {
        return true;
      }

      const result = await run(argv, { input: sql });
      if (!result.ok) {
        log.bad(tail(result.stderr, 2));
        return false;
      }

      return true;
    },
    configureNote: (options) =>
      `created the ${options.user} user and the ${options.database} database`,
  },

  mysql: {
    service: "mysql",
    port: 3307,
    envVar: "BUN_JOBS_TEST_MYSQL_URL",
    url: (options) =>
      // MySQL 8.4 authenticates with caching_sha2_password, which only sends a
      // password over plain TCP when the client may fetch the server's key.
      // Fine for a loopback test server; use TLS anywhere that matters.
      //
      // Bun ignores this parameter in a URL and honours it only as a `SQL`
      // option, so a URL is usable here only by something that takes it back
      // out first. The driver does (`takeBooleanParam`), and so does
      // `sqlReachable` above; a bare `new SQL(url)` does not, and fails with
      // ERR_MYSQL_PUBLIC_KEY_RETRIEVAL_NOT_ALLOWED. That asymmetry is why this
      // URL looks broken when probed by hand and works in the suites.
      `mysql://${options.user}:${options.password}@127.0.0.1:3307/${options.database}?allowPublicKeyRetrieval=true`,
    // A container, so there are no binaries on the host to look for.
    installed: () => false,
    packages: {},
    unit: () => "mysql",
    readyTimeout: 240_000,
    dockerOnly:
      "MySQL and MariaDB server packages conflict with each other and both listen on 3306, so MySQL runs as a container on 3307 instead",
    container: (options) => ({
      name: "bun-jobs-mysql",
      // 8.4 is the long-term support line, and the first whose binary
      // collations the SQL dialect relies on are all present.
      image: "mysql:8.4",
      port: 3307,
      containerPort: 3306,
      env: {
        MYSQL_ROOT_PASSWORD: `${options.password}-root`,
        MYSQL_DATABASE: options.database,
        MYSQL_USER: options.user,
        MYSQL_PASSWORD: options.password,
      },
      args: [`--max-connections=${options.maxConnections}`],
    }),
    managesConnectionLimit: true,
    // The same password as the container's MYSQL_ROOT_PASSWORD above, and the
    // same allowPublicKeyRetrieval the suites' URL needs. The database is
    // named for the reason MariaDB's root URL gives.
    containerRootUrl: (options) =>
      `mysql://root:${encodeURIComponent(`${options.password}-root`)}@127.0.0.1:3307/${options.database}?allowPublicKeyRetrieval=true`,
    configured: async (options) =>
      (await portOpen(3307)) && (await sqlReachable(PLANS.mysql.url(options))),
    // The image creates the user and database itself from its environment.
    configure: async () => true,
    configureNote: (options) =>
      `the container created the ${options.user} user and the ${options.database} database`,
  },

  mongodb: {
    service: "mongodb",
    port: 27017,
    envVar: "BUN_JOBS_TEST_MONGODB_URL",
    url: (options) => `mongodb://127.0.0.1:27017/${options.database}`,
    installed: () => has("mongod"),
    packages: {
      // Ubuntu and Debian do not ship MongoDB; `configureMongoRepo` adds its
      // official repository before this runs.
      apt: ["mongodb-org"],
      dnf: ["mongodb-org"],
      pacman: ["mongodb-bin"],
      brew: ["mongodb-community"],
    },
    unit: (platform) =>
      platform.manager === "brew" ? "mongodb-community" : "mongod",
    container: () => ({
      name: "bun-jobs-mongodb",
      image: "mongo:7",
      port: 27017,
      env: {},
    }),
    // A standalone MongoDB creates the database and its collections on first
    // write, so there is nothing to configure beyond it being reachable.
    configured: async () => await portOpen(27017),
    configure: async () => true,
    configureNote: (options) =>
      `nothing to configure: MongoDB creates ${options.database} on first write`,
    manualHint:
      "MongoDB is not in the Ubuntu or Debian repositories; this adds its official one. --docker avoids that entirely.",
  },
};

/**
 * Adds MongoDB's own apt repository, which Ubuntu and Debian need because
 * they do not ship it. Skipped when the source list is already there.
 */
async function configureMongoRepo(
  platform: Platform,
  options: Options,
): Promise<boolean> {
  if (platform.manager !== "apt") {
    return true;
  }

  const list = "/etc/apt/sources.list.d/mongodb-org-8.0.list";
  if (await Bun.file(list).exists()) {
    log.skip("the MongoDB apt repository is already configured");
    return true;
  }

  const release = await run(["lsb_release", "-cs"]);
  const codename = release.stdout.trim() || "noble";

  const commands: string[][] = [
    ["apt-get", "install", "-y", "gnupg", "curl"],
    [
      "bash",
      "-c",
      "curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor --yes",
    ],
    [
      "bash",
      "-c",
      `echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu ${codename}/mongodb-org/8.0 multiverse" > ${list}`,
    ],
    ["apt-get", "update"],
  ];

  for (const argv of commands) {
    const full = elevate(platform, argv);
    log.cmd(full);

    if (options.dryRun) {
      continue;
    }

    const result = await run(full);
    if (!result.ok) {
      log.bad(tail(result.stderr, 2));
      log.warn(
        `MongoDB may not publish packages for "${codename}" yet; --docker works regardless`,
      );
      return false;
    }
  }

  return true;
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

/** Waits until a real connection with the expected credentials succeeds. */
async function waitForConfigured(
  plan: ServicePlan,
  options: Options,
  timeoutMs = 90_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let reported = false;

  while (Date.now() < deadline) {
    if (await plan.configured(options)) {
      return true;
    }

    if (!reported) {
      log.skip("waiting for it to finish initialising");
      reported = true;
    }

    await Bun.sleep(500);
  }

  return false;
}

/** What happened to one server. */
interface Outcome {
  /** Which server. */
  service: Service;
  /** Whether it is usable now. */
  ready: boolean;
  /** What the script did, for the summary. */
  note: string;
}

/**
 * The connection-limit part of a server's setup: MariaDB and MySQL are
 * brought up to `--max-connections` live, Postgres to
 * `--postgres-max-connections` on its next restart, and the rest have none.
 * Returns a note for the summary, or `""`.
 */
async function connectionLimit(
  plan: ServicePlan,
  host: LimitHost,
  platform: Platform,
  options: Options,
  containerExists: boolean,
): Promise<string> {
  if (plan.managesConnectionLimit) {
    return await ensureConnectionLimit(
      plan,
      host,
      platform,
      options,
      containerExists,
    );
  }

  if (plan.service === "postgres") {
    return await ensurePostgresLimit(
      plan,
      host,
      platform,
      options,
      containerExists,
    );
  }

  return "";
}

/** `note`, with the connection-limit note after it when there is one. */
function withLimit(note: string, limit: string): string {
  return limit ? `${note}; ${limit}` : note;
}

/** Installs and configures one server, skipping whatever is already done. */
async function setupService(
  plan: ServicePlan,
  platform: Platform,
  options: Options,
): Promise<Outcome> {
  log.section(`${plan.service} (port ${plan.port})`);

  // Usable already? Then there is nothing to install and nothing to configure.
  if (await plan.configured(options)) {
    log.skip("already installed, running and reachable");
    // It may be one of this script's containers, created before the limit.
    const name = plan.container(options).name;
    await checkContainerLimit(name);
    // Whichever is serving: a server this script ran as a container is raised
    // as one, whatever the mode says, and anything else is a native install.
    const state = platform.docker ? await containerState(name) : "";
    const host: LimitHost =
      plan.dockerOnly || state === "running" ? "container" : "native";
    const limit = await connectionLimit(
      plan,
      host,
      platform,
      options,
      state !== "",
    );
    return {
      service: plan.service,
      ready: true,
      note: withLimit("already set up", limit),
    };
  }

  if (options.mode === "docker" || plan.dockerOnly) {
    if (!platform.docker) {
      log.bad(
        plan.dockerOnly
          ? `Docker is not usable here, and ${plan.dockerOnly}`
          : "Docker is not usable here",
      );
      return {
        service: plan.service,
        ready: false,
        note: "docker unavailable",
      };
    }

    if (plan.dockerOnly && options.mode !== "docker") {
      log.warn(plan.dockerOnly);
    }

    const spec = plan.container(options);
    const existed = (await containerState(spec.name)) !== "";
    const started = await ensureContainer(spec, options);

    // A database image publishes its port before it has finished creating the
    // user it was told to create, so being reachable is not the same as being
    // usable; wait for a real connection rather than for the socket.
    const ready = options.dryRun
      ? true
      : started && (await waitForConfigured(plan, options, plan.readyTimeout));

    // "container running" is not evidence: the port opens well before the
    // credentials work, and a check that reports the container rather than the
    // connection is exactly the hole this run is meant to catch. `ready` here
    // means a real query succeeded over the URL the suites will use.
    if (!ready) {
      return {
        service: plan.service,
        ready,
        note: `the container did not become usable${lastSqlError ? `: ${lastSqlError}` : ""}`,
      };
    }

    const limit = await connectionLimit(
      plan,
      "container",
      platform,
      options,
      existed,
    );
    return {
      service: plan.service,
      ready,
      note: withLimit("connected with the expected credentials", limit),
    };
  }

  if (plan.installed()) {
    log.skip("the server is already installed");
  } else {
    if (plan.manualHint) {
      log.warn(plan.manualHint);
    }

    const packages = platform.manager
      ? plan.packages[platform.manager]
      : undefined;

    if (!packages) {
      log.bad(`no package known for ${platform.manager ?? "this platform"}`);
      return { service: plan.service, ready: false, note: "no package" };
    }

    const permitted = await confirm(
      `  Install ${packages.join(", ")} with ${platform.manager}?`,
      options,
    );

    if (!permitted) {
      return { service: plan.service, ready: false, note: "declined" };
    }

    if (
      plan.service === "mongodb" &&
      !(await configureMongoRepo(platform, options))
    ) {
      return {
        service: plan.service,
        ready: false,
        note: "the repository could not be added",
      };
    }

    if (!(await installPackages(platform, packages, options))) {
      return {
        service: plan.service,
        ready: false,
        note: "the install failed",
      };
    }

    log.did(`installed ${packages.join(", ")}`);
  }

  if (await portOpen(plan.port)) {
    log.skip("already listening");
  } else {
    if (!(await startService(platform, plan.unit(platform), options))) {
      return { service: plan.service, ready: false, note: "could not start" };
    }

    if (!options.dryRun && !(await waitForPort(plan.port))) {
      log.bad(`nothing is listening on ${plan.port}`);
      return { service: plan.service, ready: false, note: "not listening" };
    }

    log.did("service started");
  }

  // Configure only when a real connection attempt failed.
  if (await plan.configured(options)) {
    log.skip("already configured");
  } else {
    if (!(await plan.configure(platform, options))) {
      return {
        service: plan.service,
        ready: false,
        note: "the configuration failed",
      };
    }

    log.did(plan.configureNote(options));
  }

  const ready = options.dryRun ? true : await plan.configured(options);
  if (!ready) {
    return { service: plan.service, ready, note: "still not reachable" };
  }

  const limit = await connectionLimit(plan, "native", platform, options, false);
  return { service: plan.service, ready, note: withLimit("ready", limit) };
}

/** Prints the environment the suites read. */
function printEnv(options: Options): void {
  console.log(
    `\n${colour.bold("Environment for the integration suites")}\n${colour.dim(
      "  Export these, or prefix a single run with them.\n",
    )}`,
  );

  for (const service of options.services) {
    const plan = PLANS[service];
    console.log(`export ${plan.envVar}=${colour.cyan(plan.url(options))}`);
  }

  console.log(
    colour.dim(
      "\n  Then: cd packages/bun-jobs && bun test" +
        "\n  A suite whose variable is unset skips, visibly. One whose variable is set\n  but whose server cannot be reached fails, so missing coverage cannot pass.",
    ),
  );
}

/** Runs the script. */
async function main(): Promise<void> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      fail(error.message);
    }
    throw error;
  }

  if (options.printEnv) {
    printEnv(options);
    return;
  }

  const platform = await detectPlatform();

  if (options.mode === "native" && !platform.manager && platform.docker) {
    log.warn("no package manager found, so falling back to --docker");
    options.mode = "docker";
  }

  console.log(
    `${colour.bold("bun-jobs database setup")}  ${colour.dim(
      [
        options.mode,
        platform.manager ?? "no package manager",
        platform.docker ? "docker available" : "no docker",
        `max_connections >= ${options.maxConnections}`,
        `postgres >= ${options.postgresMaxConnections}${options.restartPostgres ? " (restarts it)" : ""}`,
        options.dryRun ? "dry run" : "",
      ]
        .filter(Boolean)
        .join(" - "),
    )}`,
  );

  const outcomes: Outcome[] = [];
  for (const service of options.services) {
    outcomes.push(await setupService(PLANS[service], platform, options));
  }

  log.section("Summary");
  for (const outcome of outcomes) {
    const mark = outcome.ready
      ? colour.green("ready")
      : colour.red("not ready");
    console.log(
      `  ${outcome.service.padEnd(9)} ${mark}  ${colour.dim(outcome.note)}`,
    );
  }

  const ready = outcomes.filter((outcome) => outcome.ready);
  if (ready.length > 0) {
    printEnv({ ...options, services: ready.map((outcome) => outcome.service) });
  }

  if (ready.length < outcomes.length) {
    console.log(
      colour.dim(
        "\n  Some servers are not ready. --docker needs no root and no extra repositories.",
      ),
    );
    process.exitCode = 1;
  }
}

// Only when run, so a test can import the pure parts without provisioning.
if (import.meta.main) await main();
