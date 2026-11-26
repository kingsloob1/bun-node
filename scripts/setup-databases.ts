#!/usr/bin/env bun
import { Buffer } from "node:buffer";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import process from "node:process";

/** The repository this script lives in: `scripts/` is its top level. */
const REPO_ROOT = resolve(import.meta.dir, "..");

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
 * Postgres, MariaDB and MySQL also get a database of bun-cache's own
 * ({@link CACHE_DATABASE}, `BUN_CACHE_TEST_*_URL`), on the same server, user
 * and password as bun-jobs', created only when connecting to it fails;
 * MongoDB's (`BUN_CACHE_TEST_MONGODB_URL`) is created by its first write.
 * `mongodb-rs` is a single-node MongoDB replica set (`BUN_CACHE_TEST_MONGODB_RS_URL`),
 * always a container on 27018 beside the standalone server, so bun-cache's change-stream
 * bus is tested routinely; it initiates the set once, on a fresh container.
 * bun-cache's Redis suite uses bun-jobs' test database (15) instead, its keys
 * under a per-run prefix: `--print-env` names it `BUN_CACHE_TEST_REDIS_URL`.
 *
 * bun-cache's benchmarks have databases of their own, never the suites':
 * Postgres, MariaDB and MySQL get {@link CACHE_BENCH_DATABASE}
 * (`BUN_CACHE_BENCH_*_URL`), created and granted to the same user by the same
 * rule as the test database (only when connecting to it fails); MongoDB's
 * (`BUN_CACHE_BENCH_MONGODB_URL`) is created by its first write, and Redis's
 * is database 12 (`BUN_CACHE_BENCH_REDIS_URL`), which needs nothing.
 *
 * S3 is SeaweedFS in a container ({@link S3_CONTAINER_IMAGE}), the one S3 test
 * server both packages share, with a bucket each (`bun-jobs-test`,
 * {@link S3_CACHE_BUCKET}), created by a signed `PUT` when absent.
 *
 * Azure Blob Storage is Azurite in a container ({@link AZURE_CONTAINER_IMAGE}),
 * blob service only, for bun-cache's `azureBlobDriver`
 * (`BUN_CACHE_TEST_AZURE_URL`), with its blob container
 * {@link AZURE_CACHE_CONTAINER} created by a Shared Key-signed `PUT` when absent.
 * `azure-oauth` is a second Azurite on 10100, HTTPS with `--oauth basic`
 * (`BUN_CACHE_TEST_AZURE_OAUTH_URL`), for the driver's Entra ID lane: it checks
 * a bearer token's claims, not its signature. Its certificate is self-signed,
 * made once by `openssl` into {@link azureOauthCertDir} (outside the repository
 * and outside dot-directories, which snap Docker cannot read; set
 * `BUN_NODE_TEST_CERTS` to move it) and copied into the container with
 * `tar | docker cp -` after `docker create`. The suite does not trust it: its
 * fetch exempts that one host from verification (`tls.rejectUnauthorized`), and
 * this script's own checks do the same. A container that exists is only
 * started, never recreated, so its certificate is never replaced under it.
 *
 * Docker fixes a container's server arguments (`--max-connections`, Postgres's
 * `-c max_connections`) and its `--ulimit nofile` when it is created, so a
 * container made before one of them was added keeps the old settings. Such a
 * container is reported, and recreated only with `--recreate`
 * ({@link recreateContainer}): stopped, renamed to `<name>-prev`, run again
 * under its name with `--volumes-from <name>-prev` (the same data), checked
 * (the credentials, the setting, every database it had), and only then is
 * `<name>-prev` removed, never its volume; any failure puts the old one back.
 * The recreated container never gets a lower `max_connections` than the server
 * has now. One with files copied in at creation (`azure-oauth`) or running
 * another image is not recreated.
 *
 * ```bash
 * bun scripts/setup-databases.ts              # install what is missing, configure what is not
 * bun scripts/setup-databases.ts --dry-run    # print the plan, change nothing
 * bun scripts/setup-databases.ts --docker     # containers instead of system packages
 * bun scripts/setup-databases.ts --only=mongodb
 * bun scripts/setup-databases.ts --max-connections=800
 * bun scripts/setup-databases.ts --only=mysql --recreate --dry-run
 * bun scripts/setup-databases.ts --print-env  # just the env vars for the suites
 * ```
 */

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

/** The servers this script knows how to provide. */
const SERVICES = [
  "redis",
  "postgres",
  "mariadb",
  "mysql",
  "mongodb",
  "mongodb-rs",
  "s3",
  "azure",
  "azure-oauth",
] as const;

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
 * The database bun-cache's suites use on the Postgres, MariaDB, MySQL and
 * MongoDB servers (`BUN_CACHE_TEST_*_URL`), beside bun-jobs' `bun_jobs_test`: same
 * server, user and password, its own database, so neither package's test
 * data can touch the other's.
 */
export const CACHE_DATABASE = "bun_cache_test";

/**
 * The database bun-cache's benchmarks (`packages/bun-cache/bench`) use on the
 * Postgres, MariaDB, MySQL and MongoDB servers (`BUN_CACHE_BENCH_*_URL`): same
 * server, user and password as the suites, but never their database, so a
 * benchmark's load cannot disturb a test run or the other way round.
 */
export const CACHE_BENCH_DATABASE = "bun_cache_bench";

/**
 * The S3 test server: SeaweedFS, pinned. MinIO was the first choice, but its
 * images could not be pulled and its repository is archived; SeaweedFS
 * honours every conditional header the drivers rely on
 * (`docs/plans/bun-cache/bun-jobs-s3-driver.md` §3.2, §7).
 */
export const S3_CONTAINER_IMAGE = "chrislusf/seaweedfs:4.48";

/**
 * The S3 server's access key and secret: test-only values for a server bound
 * to 127.0.0.1. Given to the container as `AWS_ACCESS_KEY_ID` and
 * `AWS_SECRET_ACCESS_KEY`, which makes SeaweedFS check every request's
 * signature (without them it accepts any), so the suites prove their signing.
 */
export const S3_ACCESS_KEY = "test";

/** The S3 server's secret key; see {@link S3_ACCESS_KEY}. */
export const S3_SECRET_KEY = "test";

/** bun-jobs' S3 bucket (`BUN_JOBS_TEST_S3_URL`). Bucket names allow no `_`, hence not `bun_jobs_test`. */
export const S3_BUCKET = "bun-jobs-test";

/** bun-cache's S3 bucket (`BUN_CACHE_TEST_S3_URL`). */
export const S3_CACHE_BUCKET = "bun-cache-test";

/** Why the last S3 request failed, for the summary. */
let lastS3Error = "";

/**
 * The Azure Blob Storage test server: Azurite, Microsoft's emulator, pinned,
 * blob service only. It checks every request's Shared Key signature, so the
 * suite proves the driver's signing (`docs/plans/bun-cache/evidence/azure-spike.md`).
 */
export const AZURE_CONTAINER_IMAGE =
  "mcr.microsoft.com/azure-storage/azurite:3.37.0";

/**
 * Azurite's built-in development account and key. Microsoft publishes both
 * (the "well-known" emulator credentials, in Azurite's README and Azure's
 * docs): they are not a secret, and work only against an emulator, here
 * bound to 127.0.0.1.
 */
export const AZURE_ACCOUNT = "devstoreaccount1";

/** Azurite's published development key; see {@link AZURE_ACCOUNT}. */
export const AZURE_ACCOUNT_KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

/** bun-cache's blob container (`BUN_CACHE_TEST_AZURE_URL`). Container names allow no `_`. */
export const AZURE_CACHE_CONTAINER = "bun-cache-test";

/** The Blob service REST version the script's requests ask for. */
const AZURE_API_VERSION = "2025-01-05";

/** The host port of the HTTPS, `--oauth basic` Azurite (`azure-oauth`). */
export const AZURE_OAUTH_PORT = 10_100;

/** The name of the `azure-oauth` container. */
export const AZURE_OAUTH_CONTAINER = "bun-cache-azurite-oauth";

/**
 * Where the `azure-oauth` certificate and key live:
 * `<checkout>/../_scratch/bun-node/test-certs/azure-oauth`, beside the checkout,
 * or `$BUN_NODE_TEST_CERTS/azure-oauth`. Never inside the repository (a key
 * is never committed) and never under a dot-directory such as `~/.cache`,
 * which snap Docker cannot read.
 */
export function azureOauthCertDir(
  env: Record<string, string | undefined> = process.env,
  /** The checkout the default sits beside. Defaults to this repository. */
  root: string = REPO_ROOT,
): string {
  const base =
    env.BUN_NODE_TEST_CERTS ||
    resolve(root, "..", "_scratch", "bun-node", "test-certs");
  return `${base}/azure-oauth`;
}

/** Why the last Azure request failed, for the summary. */
let lastAzureError = "";

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
  /** bun-cache's database on the SQL and MongoDB servers ({@link CACHE_DATABASE}). */
  cacheDatabase: string;
  /**
   * bun-cache's benchmark database on the SQL and MongoDB servers
   * ({@link CACHE_BENCH_DATABASE}).
   */
  cacheBenchDatabase: string;
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
  /**
   * Recreate a container of this script's whose creation-time settings
   * (`--max-connections`, Postgres's `-c max_connections`, the open-file
   * limit) fall short of what it is created with now, keeping its data with
   * `--volumes-from` (see {@link recreateContainer}). Off by default: without
   * it such a container is only reported.
   */
  recreate: boolean;
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
    cacheDatabase: CACHE_DATABASE,
    cacheBenchDatabase: CACHE_BENCH_DATABASE,
    user: "bunjobs",
    maxConnections: defaultMaxConnections(),
    postgresMaxConnections: defaultPostgresMaxConnections(),
    restartPostgres: false,
    recreate: false,
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
    } else if (arg.startsWith("--cache-database=")) {
      options.cacheDatabase = arg.slice("--cache-database=".length);
    } else if (arg.startsWith("--cache-bench-database=")) {
      options.cacheBenchDatabase = arg.slice("--cache-bench-database=".length);
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
    } else if (arg === "--recreate") {
      options.recreate = true;
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
Provision the database servers the bun-jobs and bun-cache integration
suites need.

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
  --cache-database=NAME
                    bun-cache's database on Postgres, MariaDB, MySQL and
                    MongoDB (default: ${CACHE_DATABASE})
  --cache-bench-database=NAME
                    bun-cache's benchmark database on Postgres, MariaDB,
                    MySQL and MongoDB (default: ${CACHE_BENCH_DATABASE})
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
  --recreate        Recreate a container of this script's that was created
                    without a setting it is created with now (MariaDB's and
                    MySQL's --max-connections, Postgres's -c max_connections
                    pinned below the target, the open-file limit), keeping
                    its data: stop it, rename it to <name>-prev, run the new
                    one with --volumes-from <name>-prev, wait for the
                    credentials, check the setting and every database, and
                    only then remove <name>-prev (never its volume). Any
                    failure puts the old container back. Without it such a
                    container is only reported. It restarts the server, so
                    run it when nothing is using it; --dry-run prints the
                    commands.

Running it twice is safe: an installed server is not reinstalled, and
configuration runs only when a connection with the expected credentials
fails. Nothing is dropped or overwritten, and no limit is ever lowered.
A container is recreated only with --recreate, and keeps its data.
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
  /**
   * Files to put in the container's filesystem when it is created: the
   * directory `from` is copied (`tar | docker cp -`, since snap Docker cannot
   * read every host path) to `to` inside it, between `docker create` and
   * `docker start`. Used by the `azure-oauth` certificate.
   */
  copyIn?: {
    /** Host directory whose contents are copied. */
    from: string;
    /** Directory in the container they are copied into. */
    to: string;
  };
}

/** The `docker create` command for a spec with {@link ContainerSpec.copyIn}: `docker run --detach`'s, without the start. */
export function dockerCreateArgv(spec: ContainerSpec): string[] {
  const [docker, , , ...rest] = dockerRunArgv(spec);
  return [docker, "create", ...rest];
}

/**
 * The `docker run` command that creates a container to `spec`. With
 * `volumesFrom`, the new container mounts that container's volumes, which is
 * how {@link recreateContainer} keeps a server's data.
 */
export function dockerRunArgv(
  spec: ContainerSpec,
  extra: {
    /** A container whose volumes the new one mounts (`--volumes-from`). */
    volumesFrom?: string;
  } = {},
): string[] {
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
    ...(extra.volumesFrom ? ["--volumes-from", extra.volumesFrom] : []),
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

/** What `docker container inspect` reports about how a container was created. */
export interface InspectedContainer {
  /** Its id, so a rollback can tell the old container from the new one. */
  id: string;
  /** The image it was created from (`Config.Image`). */
  image: string;
  /** Its command line (`Config.Cmd`): the server's arguments; `null` when it has none. */
  cmd: string[] | null;
  /** Its ulimits (`HostConfig.Ulimits`); `null` when none were set at creation. */
  ulimits: Array<{
    /** The limit's name, `nofile` for the open-file limit. */
    Name: string;
    /** The soft limit. */
    Soft: number;
    /** The hard limit. */
    Hard: number;
  }> | null;
}

/**
 * The `docker container inspect` format {@link parseInspected} reads: one JSON
 * array of the id, the image, the command line and the ulimits.
 */
export const INSPECT_FORMAT =
  "[{{json .Id}},{{json .Config.Image}},{{json .Config.Cmd}},{{json .HostConfig.Ulimits}}]";

/**
 * Reads how a container was created, or `null` when there is no such
 * container (or no Docker). The format is JSON, read through {@link run}'s
 * pipe: snap Docker's output is lost only when it is redirected to a file
 * under `/tmp`, which this never does.
 */
async function inspectContainer(
  name: string,
  runner: Runner = run,
): Promise<InspectedContainer | null> {
  const inspected = await runner([
    "docker",
    "container",
    "inspect",
    "--format",
    INSPECT_FORMAT,
    name,
  ]);
  return inspected.ok ? parseInspected(inspected.stdout) : null;
}

/**
 * Parses {@link inspectContainer}'s output ({@link INSPECT_FORMAT}), or
 * `null` when it is not that.
 */
export function parseInspected(stdout: string): InspectedContainer | null {
  try {
    const [id, image, cmd, ulimits] = JSON.parse(stdout.trim()) as [
      unknown,
      unknown,
      unknown,
      unknown,
    ];
    if (typeof id !== "string" || typeof image !== "string") {
      return null;
    }
    return {
      id,
      image,
      cmd: Array.isArray(cmd) ? cmd.map(String) : null,
      ulimits: Array.isArray(ulimits)
        ? (ulimits as InspectedContainer["ulimits"])
        : null,
    };
  } catch {
    return null;
  }
}

/** One setting a container was created without, or with too little of. */
export interface Drift {
  /** Which setting. */
  setting: "max-connections" | "nofile";
  /** What the container has against what it is created with now, in words. */
  message: string;
}

/**
 * The settings `inspected` was created without, against what `spec` creates
 * a container with now. Only settings fixed at creation count, and only
 * shortfalls:
 *
 *   - the open-file limit, `--ulimit nofile`, missing or below
 *     {@link OPEN_FILE_LIMIT};
 *   - MariaDB's and MySQL's `--max-connections`, missing or below the spec's
 *     (both spellings, as {@link maxConnectionsArg} reads them);
 *   - Postgres's `-c max_connections`, only when pinned **below** the spec's.
 *     A container with no pin is not behind: `ALTER SYSTEM` keeps its value
 *     across restarts, and a pin would outrank a higher value set that way.
 *
 * A container above the spec is somebody's deliberate choice, and not drift.
 */
export function containerDrift(
  spec: ContainerSpec,
  inspected: Pick<InspectedContainer, "cmd" | "ulimits">,
): Drift[] {
  const drift: Drift[] = [];

  const soft = inspected.ulimits?.find(
    (limit) => limit.Name === "nofile",
  )?.Soft;
  if (soft === undefined || soft < OPEN_FILE_LIMIT) {
    drift.push({
      setting: "nofile",
      message:
        soft === undefined
          ? `created without --ulimit nofile=${OPEN_FILE_LIMIT}:${OPEN_FILE_LIMIT}, so it has the Docker daemon's default open-file limit`
          : `created with an open-file limit of ${soft}, below ${OPEN_FILE_LIMIT}`,
    });
  }

  const args = spec.args ?? [];
  const wanted = maxConnectionsArg(args);
  if (wanted !== null) {
    const pinned = maxConnectionsArg(inspected.cmd);
    if (pinned === null || pinned < wanted) {
      drift.push({
        setting: "max-connections",
        message: `created ${pinned === null ? "without --max-connections" : `with --max-connections=${pinned}`}, where it is now created with --max-connections=${wanted}`,
      });
    }
    return drift;
  }

  const pgWanted = postgresMaxConnectionsArg(args);
  if (pgWanted !== null) {
    const pinned = postgresMaxConnectionsArg(inspected.cmd);
    if (pinned !== null && pinned < pgWanted) {
      drift.push({
        setting: "max-connections",
        message: `created with -c max_connections=${pinned}, which outranks ALTER SYSTEM, where it is now created with -c max_connections=${pgWanted}`,
      });
    }
  }
  return drift;
}

/**
 * Why a drifted container cannot be recreated by {@link recreateContainer},
 * or `null` when it can. `--volumes-from` carries the container's volumes and
 * nothing else, so a container with files copied into its filesystem at
 * creation ({@link ContainerSpec.copyIn}) would lose them; and one running
 * another image would have its data opened by a different server version.
 */
export function recreateBlocker(
  spec: ContainerSpec,
  inspected: Pick<InspectedContainer, "image">,
): string | null {
  if (spec.copyIn) {
    return `its files were copied into it at creation, which --volumes-from does not carry; remove it (docker rm ${spec.name}) and rerun to create it afresh`;
  }
  if (inspected.image !== spec.image) {
    return `it runs ${inspected.image}, not ${spec.image}, and recreating it would open its data with another server version; recreate it by hand`;
  }
  return null;
}

/** The suffix of the name a container is renamed to while it is recreated. */
export const RECREATE_SUFFIX = "-prev";

/**
 * How long `docker stop` lets a server shut down cleanly before killing it,
 * in seconds. Docker's default of 10 can cut an InnoDB shutdown short, which
 * a restart then has to recover from.
 */
export const RECREATE_STOP_SECONDS = 60;

/** The commands of a recreate, in the order they run. */
export interface RecreateArgv {
  /** Stops the old container. */
  stop: string[];
  /** Renames it out of the way, to `<name>-prev`. */
  rename: string[];
  /** Runs the new container, under the old name, with the old one's volumes. */
  run: string[];
  /** Removes the old container, never its volumes (no `-v`), once the new one checks out. */
  remove: string[];
}

/** The commands {@link recreateContainer} runs for `spec`. */
export function recreateArgv(spec: ContainerSpec): RecreateArgv {
  const prev = `${spec.name}${RECREATE_SUFFIX}`;
  return {
    stop: [
      "docker",
      "stop",
      "--time",
      String(RECREATE_STOP_SECONDS),
      spec.name,
    ],
    rename: ["docker", "rename", spec.name, prev],
    run: dockerRunArgv(spec, { volumesFrom: prev }),
    remove: ["docker", "rm", prev],
  };
}

/** What {@link recreateContainer} does its work through; tests pass fakes. */
export interface RecreateIo {
  /** Runs a docker command. */
  runner: Runner;
  /** Waits until the server accepts the expected credentials. */
  waitReady: () => Promise<boolean>;
  /**
   * Checks the new container: the settings it was recreated for, and that
   * every database that connected before still connects. Resolves the
   * problem found, or `null`.
   */
  verify: () => Promise<string | null>;
}

/** How a recreate ended. */
export interface RecreateResult {
  /**
   * `recreated`: the new container is in place; `planned`: a dry run;
   * `refused`: nothing was changed; `rolled-back`: it failed and the old
   * container is serving again; `rollback-failed`: it failed and the old
   * container could not be brought back (its data is intact, under the name
   * the log gives).
   */
  outcome:
    "recreated" | "planned" | "refused" | "rolled-back" | "rollback-failed";
  /** A note for the summary. */
  note: string;
}

/**
 * Recreates `spec`'s container with the settings it is created with now,
 * keeping its data:
 *
 *   1. `docker stop` it (with {@link RECREATE_STOP_SECONDS} to shut down);
 *   2. `docker rename` it to `<name>-prev`;
 *   3. `docker run` the new one under the old name, with the old one's
 *      volumes (`--volumes-from <name>-prev`), so the same data directory;
 *   4. wait for the expected credentials;
 *   5. verify the setting and that every database still connects;
 *   6. only then `docker rm <name>-prev`, never with `-v`.
 *
 * On any failure from step 1 on, it rolls back: removes the new container
 * (only one whose id is not the old one's), renames `<name>-prev` back,
 * starts it and waits for the credentials. It refuses to start when a
 * `<name>-prev` already exists, which is an earlier recreate's leftover. A
 * dry run prints the commands and runs none.
 */
export async function recreateContainer(
  spec: ContainerSpec,
  dryRun: boolean,
  io: RecreateIo,
): Promise<RecreateResult> {
  const name = spec.name;
  const prev = `${name}${RECREATE_SUFFIX}`;
  const argv = recreateArgv(spec);

  log.cmd(argv.stop);
  log.cmd(argv.rename);
  log.cmd(argv.run);
  log.skip(
    "then wait for the expected credentials, check the setting and that every database still connects, and only then:",
  );
  log.cmd(argv.remove);
  log.skip(
    `on any failure: docker rm --force <the new ${name}>; docker rename ${prev} ${name}; docker start ${name}`,
  );
  if (dryRun) {
    return { outcome: "planned", note: "would be recreated, keeping its data" };
  }

  const existing = await io.runner([
    "docker",
    "ps",
    "--all",
    "--filter",
    `name=^/${prev}$`,
    "--format",
    "{{.State}}",
  ]);
  if (!existing.ok) {
    log.bad(tail(existing.stderr, 2) || "could not list the containers");
    return { outcome: "refused", note: "not recreated: docker ps failed" };
  }
  if (existing.stdout.trim()) {
    log.bad(
      `a container named ${prev} already exists, left by an earlier recreate; check it holds nothing you need, remove it (docker rm ${prev}, never -v: its volume may be the data) and rerun`,
    );
    return { outcome: "refused", note: `not recreated: ${prev} exists` };
  }

  const old = await inspectContainer(name, io.runner);
  if (!old) {
    log.bad(`could not inspect container ${name}`);
    return { outcome: "refused", note: "not recreated: inspect failed" };
  }

  /** Puts the old container back, after `why`. */
  const rollBack = async (
    renamed: boolean,
    why: string,
  ): Promise<RecreateResult> => {
    log.bad(why);
    log.warn(`rolling back to the old container ${name}`);
    if (renamed) {
      // Only a container that is not the old one: never the data's owner.
      const made = await inspectContainer(name, io.runner);
      if (made && made.id !== old.id) {
        const remove = ["docker", "rm", "--force", made.id];
        log.cmd(remove);
        const removed = await io.runner(remove);
        if (!removed.ok) {
          log.bad(
            `could not remove the new container: ${tail(removed.stderr, 2)}; the old one, with the data, is ${prev}: docker rm --force ${made.id} && docker rename ${prev} ${name} && docker start ${name}`,
          );
          return {
            outcome: "rollback-failed",
            note: `recreate failed (${why}); rollback failed, the old container is ${prev}`,
          };
        }
      }
      const back = ["docker", "rename", prev, name];
      log.cmd(back);
      const renamedBack = await io.runner(back);
      if (!renamedBack.ok) {
        log.bad(
          `could not rename ${prev} back: ${tail(renamedBack.stderr, 2)}; the old container and its data are intact under that name: docker rename ${prev} ${name} && docker start ${name}`,
        );
        return {
          outcome: "rollback-failed",
          note: `recreate failed (${why}); rollback failed, the old container is ${prev}`,
        };
      }
    }
    const start = ["docker", "start", name];
    log.cmd(start);
    const started = await io.runner(start);
    if (!started.ok || !(await io.waitReady())) {
      log.bad(
        `the old container ${name} did not come back${started.ok ? " with the expected credentials" : `: ${tail(started.stderr, 2)}`}; check docker logs ${name} | cat`,
      );
      return {
        outcome: "rollback-failed",
        note: `recreate failed (${why}); the old container did not come back`,
      };
    }
    log.did(`rolled back: the old container ${name} is serving again`);
    return {
      outcome: "rolled-back",
      note: `recreate failed (${why}); rolled back to the old container`,
    };
  };

  const stopped = await io.runner(argv.stop);
  if (!stopped.ok) {
    return await rollBack(
      false,
      `could not stop ${name}: ${tail(stopped.stderr, 2)}`,
    );
  }
  const renamed = await io.runner(argv.rename);
  if (!renamed.ok) {
    return await rollBack(
      false,
      `could not rename ${name}: ${tail(renamed.stderr, 2)}`,
    );
  }
  const created = await io.runner(argv.run);
  if (!created.ok) {
    return await rollBack(
      true,
      `could not run the new ${name}: ${tail(created.stderr, 2)}`,
    );
  }
  if (!(await io.waitReady())) {
    return await rollBack(
      true,
      `the new ${name} did not accept the expected credentials`,
    );
  }
  const problem = await io.verify();
  if (problem) {
    return await rollBack(true, `the new ${name} failed its check: ${problem}`);
  }

  const removed = await io.runner(argv.remove);
  if (!removed.ok) {
    log.warn(
      `could not remove ${prev}: ${tail(removed.stderr, 2)}; the new container is in use, so remove the old one yourself: docker rm ${prev} (never -v)`,
    );
    log.did(`recreated ${name}, keeping its data`);
    return {
      outcome: "recreated",
      note: `recreated, keeping its data (${prev} left to remove)`,
    };
  }
  log.did(`recreated ${name}, keeping its data`);
  return { outcome: "recreated", note: "recreated, keeping its data" };
}

/** Creates a container, copies `files` into it, then starts it. */
async function createWithFiles(
  spec: ContainerSpec,
  files: NonNullable<ContainerSpec["copyIn"]>,
  options: Options,
): Promise<boolean> {
  const create = dockerCreateArgv(spec);
  const copy = ["docker", "cp", "-", `${spec.name}:${files.to}`];
  const start = ["docker", "start", spec.name];
  log.cmd(create);
  log.cmd(["tar", "-C", files.from, "-c", ".", "|", ...copy]);
  log.cmd(start);

  if (options.dryRun) {
    return true;
  }

  const created = await run(create);
  if (!created.ok) {
    log.bad(tail(created.stderr, 2));
    return false;
  }

  const tar = Bun.spawn(["tar", "-C", files.from, "-c", "."], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const cp = Bun.spawn(copy, {
    stdin: tar.stdout,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [cpErr, cpCode, tarCode] = await Promise.all([
    new Response(cp.stderr).text(),
    cp.exited,
    tar.exited,
  ]);
  if (cpCode !== 0 || tarCode !== 0) {
    log.bad(tail(cpErr, 2) || "could not copy the files into the container");
    // Never leave a half-made container for the next run to start.
    await run(["docker", "rm", "--force", spec.name]);
    return false;
  }

  if (!(await run(start)).ok) {
    log.bad(`could not start container ${spec.name}`);
    return false;
  }

  log.did(`created container ${spec.name} from ${spec.image}`);
  return await waitForPort(spec.port);
}

/** Starts a container, reusing one that already exists. */
async function ensureContainer(
  spec: ContainerSpec,
  options: Options,
): Promise<boolean> {
  const state = await containerState(spec.name);

  // An existing container's creation-time settings are checked once it is
  // usable, by `reconcileContainer`.
  if (state === "running") {
    log.skip(`container ${spec.name} is already running`);
    return true;
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

  if (spec.copyIn) {
    return await createWithFiles(spec, spec.copyIn, options);
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
  /**
   * Environment variable bun-jobs' suites read. Absent on a server only
   * bun-cache uses (the MongoDB replica set).
   */
  envVar?: string;
  /** The URL the suites should use once it is ready. */
  url: (options: Options) => string;
  /**
   * The variable bun-cache's suites read for this server. Printed by
   * `--print-env` with {@link cacheUrl}, or with {@link url} on a server where
   * bun-cache has no database of its own (Redis).
   */
  cacheEnvVar?: string;
  /**
   * The URL of bun-cache's database ({@link CACHE_DATABASE}): bun-jobs' URL
   * with the other database. Only on the servers where the script creates
   * that database (the SQL ones), and on MongoDB, which creates it itself on
   * the first write.
   */
  cacheUrl?: (options: Options) => string;
  /** The variable bun-cache's benchmarks read for this server. */
  cacheBenchEnvVar?: string;
  /**
   * The URL of bun-cache's benchmark database ({@link CACHE_BENCH_DATABASE}),
   * printed by `--print-env`. The script creates that database on the SQL
   * servers; MongoDB makes it on the first write; Redis's is database 12.
   */
  cacheBenchUrl?: (options: Options) => string;
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
  /**
   * One-time setup of a freshly started container that the image does not do
   * itself (the MongoDB replica set's `rs.initiate`), run in docker mode after
   * the container is up and before waiting for {@link configured}. It must be
   * safe to run again on a container that already did it. Resolves whether it
   * succeeded.
   */
  initContainer?: (options: Options) => Promise<boolean>;
  /**
   * Made ready before a container is created (the `azure-oauth` certificate),
   * only when none exists yet. Resolves whether it succeeded.
   */
  prepareContainer?: (options: Options) => Promise<boolean>;
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
 * account the container was created with. A container whose command line
 * lacks the target is reported (or, with `--recreate`, recreated) before
 * this runs, by `reconcileContainer`.
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
      `container ${ctx.containerName} was created with -c max_connections=${ctx.containerPin}, which outranks ALTER SYSTEM; rerun with --recreate to recreate it with -c max_connections=${target}, keeping its data`,
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

/** The port the MongoDB replica-set container listens on and is published at. */
const MONGO_RS_PORT = 27_018;

/** The MongoDB replica-set container's name. */
const MONGO_RS_CONTAINER = "bun-cache-mongodb-rs";

/**
 * The `docker exec` that initiates the replica set `rs0` of one member,
 * `127.0.0.1:27018`, unless it already is one (`rs.status()` throws on a
 * server that is not yet initiated), so running it again is harmless.
 */
export function mongoRsInitArgv(): string[] {
  return [
    "docker",
    "exec",
    MONGO_RS_CONTAINER,
    "mongosh",
    "--port",
    String(MONGO_RS_PORT),
    "--quiet",
    "--eval",
    `try { rs.status() } catch (e) { rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "127.0.0.1:${MONGO_RS_PORT}" }] }) }`,
  ];
}

/** Every server, in the order they are set up. */
export const PLANS: Record<Service, ServicePlan> = {
  redis: {
    service: "redis",
    port: 6379,
    envVar: "BUN_JOBS_TEST_REDIS_URL",
    // Database 15, so a test run cannot disturb anything on database 0.
    url: () => "redis://127.0.0.1:6379/15",
    // bun-cache's suite shares database 15 (the repository's test database),
    // its keys under a per-run prefix; there is no database to create.
    cacheEnvVar: "BUN_CACHE_TEST_REDIS_URL",
    // The benchmarks' own database, 12: nothing to create.
    cacheBenchEnvVar: "BUN_CACHE_BENCH_REDIS_URL",
    cacheBenchUrl: () => "redis://127.0.0.1:6379/12",
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
    cacheEnvVar: "BUN_CACHE_TEST_POSTGRES_URL",
    cacheUrl: (options) =>
      `postgres://${options.user}:${options.password}@127.0.0.1:5432/${options.cacheDatabase}`,
    cacheBenchEnvVar: "BUN_CACHE_BENCH_POSTGRES_URL",
    cacheBenchUrl: (options) =>
      `postgres://${options.user}:${options.password}@127.0.0.1:5432/${options.cacheBenchDatabase}`,
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
    cacheEnvVar: "BUN_CACHE_TEST_MARIADB_URL",
    cacheUrl: (options) =>
      `mariadb://${options.user}:${options.password}@127.0.0.1:3306/${options.cacheDatabase}`,
    cacheBenchEnvVar: "BUN_CACHE_BENCH_MARIADB_URL",
    cacheBenchUrl: (options) =>
      `mariadb://${options.user}:${options.password}@127.0.0.1:3306/${options.cacheBenchDatabase}`,
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
    cacheEnvVar: "BUN_CACHE_TEST_MYSQL_URL",
    // The same parameter, for the same reason: bun-cache's driver takes it out
    // of the URL as bun-jobs' does.
    cacheUrl: (options) =>
      `mysql://${options.user}:${options.password}@127.0.0.1:3307/${options.cacheDatabase}?allowPublicKeyRetrieval=true`,
    cacheBenchEnvVar: "BUN_CACHE_BENCH_MYSQL_URL",
    cacheBenchUrl: (options) =>
      `mysql://${options.user}:${options.password}@127.0.0.1:3307/${options.cacheBenchDatabase}?allowPublicKeyRetrieval=true`,
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
    cacheEnvVar: "BUN_CACHE_TEST_MONGODB_URL",
    cacheUrl: (options) => `mongodb://127.0.0.1:27017/${options.cacheDatabase}`,
    cacheBenchEnvVar: "BUN_CACHE_BENCH_MONGODB_URL",
    cacheBenchUrl: (options) =>
      `mongodb://127.0.0.1:27017/${options.cacheBenchDatabase}`,
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

  "mongodb-rs": {
    service: "mongodb-rs",
    port: MONGO_RS_PORT,
    // bun-cache only: bun-jobs has no use for a replica set.
    cacheEnvVar: "BUN_CACHE_TEST_MONGODB_RS_URL",
    url: (options) => PLANS["mongodb-rs"].cacheUrl!(options),
    // The member is named 127.0.0.1:27018 in the replica-set config, so the
    // host reaches it by the name the server hands back: all four spellings
    // (none, `replicaSet=rs0`, `directConnection=true`, both) connected and
    // wrote (measured). `replicaSet=rs0` is kept because it makes the driver
    // check it reached that set, and it has no `&` to trip a pasted `export`.
    cacheUrl: (options) =>
      `mongodb://127.0.0.1:${MONGO_RS_PORT}/${options.cacheDatabase}?replicaSet=rs0`,
    // A container, so there are no binaries on the host to look for.
    installed: () => false,
    packages: {},
    unit: () => "mongod",
    dockerOnly:
      "a replica set needs a mongod of its own beside the standalone one on 27017, so it runs as a container on 27018",
    container: () => ({
      name: MONGO_RS_CONTAINER,
      // The standalone server's image: the same major version.
      image: "mongo:7",
      // Published and listening on the same port, because the member's name
      // in the replica-set config has to be reachable from the host too.
      port: MONGO_RS_PORT,
      env: {},
      args: [
        "--replSet",
        "rs0",
        "--bind_ip_all",
        "--port",
        String(MONGO_RS_PORT),
        // bun-cache's history-lost case injects a failure with
        // `configureFailPoint`, which only a server started with this
        // accepts; without it that case skips. Fixed at creation.
        "--setParameter",
        "enableTestCommands=1",
      ],
    }),
    initContainer: async (options) => {
      const argv = mongoRsInitArgv();
      log.cmd(argv);
      if (options.dryRun) {
        return true;
      }
      // mongod accepts connections a moment after its port opens.
      for (let attempt = 0; attempt < 60; attempt++) {
        if ((await run(argv)).ok) {
          log.did("the replica set rs0 is initiated");
          return true;
        }
        await Bun.sleep(1_000);
      }
      log.bad("could not initiate the replica set rs0");
      return false;
    },
    // A real answer from the server, not an open port: a primary of rs0.
    configured: async () => {
      if (!(await portOpen(MONGO_RS_PORT))) {
        return false;
      }
      const result = await run([
        "docker",
        "exec",
        MONGO_RS_CONTAINER,
        "mongosh",
        "--port",
        String(MONGO_RS_PORT),
        "--quiet",
        "--eval",
        "if (!db.hello().isWritablePrimary) quit(1)",
      ]);
      return result.ok;
    },
    configure: async () => true,
    configureNote: () => "the container's replica set rs0 is initiated",
  },

  s3: {
    service: "s3",
    port: 8333,
    envVar: "BUN_JOBS_TEST_S3_URL",
    // The S3 driver's URL form: credentials, endpoint and bucket; `scheme=http`
    // because the test server speaks plain HTTP on loopback.
    url: () => s3TestUrl(S3_BUCKET),
    cacheEnvVar: "BUN_CACHE_TEST_S3_URL",
    cacheUrl: () => s3TestUrl(S3_CACHE_BUCKET),
    // A container, so there are no binaries on the host to look for.
    installed: () => false,
    packages: {},
    unit: () => "seaweedfs",
    readyTimeout: 60_000,
    dockerOnly:
      "SeaweedFS has no distribution package, so the S3 test server runs as a container",
    container: () => ({
      name: "bun-jobs-s3",
      image: S3_CONTAINER_IMAGE,
      port: 8333,
      env: {
        AWS_ACCESS_KEY_ID: S3_ACCESS_KEY,
        AWS_SECRET_ACCESS_KEY: S3_SECRET_KEY,
      },
      // The data stays in the image's /data volume: never a bind mount, and
      // never the host's /tmp, which snap Docker cannot use.
      args: ["server", "-s3", "-dir=/data"],
    }),
    // Bun's S3Client cannot create a bucket, and the image makes none: a
    // signed `PUT` once the server answers. Safe to repeat: a bucket already
    // there (ours) is left alone.
    initContainer: async (options) => {
      log.cmd([`(signed PUT /${S3_BUCKET} over 127.0.0.1:8333)`]);
      if (options.dryRun) {
        return true;
      }
      // SeaweedFS answers S3 a few seconds after its port opens (3.8–6 s,
      // measured for the plan).
      for (let attempt = 0; attempt < 60; attempt++) {
        if (await ensureS3Bucket(s3TestUrl(S3_BUCKET), false)) {
          log.did(`the ${S3_BUCKET} bucket is there`);
          return true;
        }
        await Bun.sleep(1_000);
      }
      log.bad(`could not create the ${S3_BUCKET} bucket: ${lastS3Error}`);
      return false;
    },
    // Ready means a signed request over the suites' credentials finds the
    // bucket: a `HEAD`, which never creates anything.
    configured: async () =>
      (await portOpen(8333)) &&
      (await ensureS3Bucket(s3TestUrl(S3_BUCKET), true)),
    configure: () => Promise.resolve(true),
    configureNote: () => `created the ${S3_BUCKET} bucket`,
  },

  azure: {
    service: "azure",
    port: 10_000,
    // bun-cache only: bun-jobs has no Azure driver. The URL is
    // azureBlobDriver's form, printed as BUN_CACHE_TEST_AZURE_URL (no
    // `cacheUrl`: the blob container is bun-cache's alone).
    cacheEnvVar: "BUN_CACHE_TEST_AZURE_URL",
    url: () => azureTestUrl(AZURE_CACHE_CONTAINER),
    // A container, so there are no binaries on the host to look for.
    installed: () => false,
    packages: {},
    unit: () => "azurite",
    readyTimeout: 60_000,
    dockerOnly:
      "Azurite, the Azure Storage emulator, has no distribution package, so the Azure test server runs as a container",
    container: () => ({
      name: "bun-cache-azurite",
      image: AZURE_CONTAINER_IMAGE,
      port: 10_000,
      env: {},
      // The blob service alone, on all of the container's interfaces (the
      // port is published on the host's loopback only). Its data stays in
      // the image's /data volume: never a bind mount, and never the host's
      // /tmp, which snap Docker cannot use.
      args: [
        "azurite-blob",
        "--blobHost",
        "0.0.0.0",
        "--blobPort",
        "10000",
        "--location",
        "/data",
      ],
    }),
    // The image makes no blob container: a signed `PUT` once the server
    // answers. Safe to repeat: one already there is left alone.
    initContainer: async (options) => {
      log.cmd([
        `(Shared Key PUT /${AZURE_ACCOUNT}/${AZURE_CACHE_CONTAINER}?restype=container over 127.0.0.1:10000)`,
      ]);
      if (options.dryRun) {
        return true;
      }
      for (let attempt = 0; attempt < 60; attempt++) {
        if (
          await ensureAzureContainer(azureTestUrl(AZURE_CACHE_CONTAINER), false)
        ) {
          log.did(`the ${AZURE_CACHE_CONTAINER} blob container is there`);
          return true;
        }
        await Bun.sleep(1_000);
      }
      log.bad(
        `could not create the ${AZURE_CACHE_CONTAINER} blob container: ${lastAzureError}`,
      );
      return false;
    },
    // Ready means a signed request over the suite's credentials finds the
    // blob container: Get Container Properties, which creates nothing.
    configured: async () =>
      (await portOpen(10_000)) &&
      (await ensureAzureContainer(azureTestUrl(AZURE_CACHE_CONTAINER), true)),
    configure: () => Promise.resolve(true),
    configureNote: () => `created the ${AZURE_CACHE_CONTAINER} blob container`,
  },

  "azure-oauth": {
    service: "azure-oauth",
    port: AZURE_OAUTH_PORT,
    // bun-cache only: the Entra ID lane of azureBlobDriver
    // (azure-auth.test.ts). The URL has no `scheme`, so the driver speaks
    // HTTPS to it.
    cacheEnvVar: "BUN_CACHE_TEST_AZURE_OAUTH_URL",
    url: () => azureTestUrl(AZURE_CACHE_CONTAINER, true),
    // A container, so there are no binaries on the host to look for.
    installed: () => false,
    packages: {},
    unit: () => "azurite",
    readyTimeout: 60_000,
    dockerOnly:
      "Azurite, the Azure Storage emulator, has no distribution package, so the Entra ID test server runs as a container",
    container: () => ({
      name: AZURE_OAUTH_CONTAINER,
      image: AZURE_CONTAINER_IMAGE,
      port: AZURE_OAUTH_PORT,
      containerPort: 10_000,
      env: {},
      // The certificate directory, copied to /certs when the container is
      // created (never a bind mount: snap Docker cannot read every path).
      copyIn: { from: azureOauthCertDir(), to: "/" },
      args: [
        "azurite-blob",
        "--blobHost",
        "0.0.0.0",
        "--blobPort",
        "10000",
        "--location",
        "/data",
        // Checks a token's claims (audience, issuer, expiry), not its
        // signature; it needs HTTPS, hence the certificate.
        "--oauth",
        "basic",
        "--cert",
        "/certs/cert.pem",
        "--key",
        "/certs/key.pem",
      ],
    }),
    // The certificate, made once; only called when the container is absent.
    prepareContainer: (options) => ensureAzureOauthCert(options),
    // Shared Key still works under `--oauth basic`, which is how the blob
    // container is made.
    initContainer: async (options) => {
      log.cmd([
        `(Shared Key PUT /${AZURE_ACCOUNT}/${AZURE_CACHE_CONTAINER}?restype=container over https://127.0.0.1:${AZURE_OAUTH_PORT})`,
      ]);
      if (options.dryRun) {
        return true;
      }
      const url = azureTestUrl(AZURE_CACHE_CONTAINER, true);
      for (let attempt = 0; attempt < 60; attempt++) {
        if (await ensureAzureContainer(url, false)) {
          log.did(`the ${AZURE_CACHE_CONTAINER} blob container is there`);
          return true;
        }
        await Bun.sleep(1_000);
      }
      log.bad(
        `could not create the ${AZURE_CACHE_CONTAINER} blob container: ${lastAzureError}`,
      );
      return false;
    },
    configured: async () =>
      (await portOpen(AZURE_OAUTH_PORT)) &&
      (await ensureAzureContainer(
        azureTestUrl(AZURE_CACHE_CONTAINER, true),
        true,
      )),
    configure: () => Promise.resolve(true),
    configureNote: () => `created the ${AZURE_CACHE_CONTAINER} blob container`,
  },
};

/* ------------------------------------------------------------------ *
 * S3 (SeaweedFS)
 * ------------------------------------------------------------------ */

/** The S3 test URL for a bucket, in the S3 driver's form. */
export function s3TestUrl(bucket: string): string {
  return `s3://${S3_ACCESS_KEY}:${S3_SECRET_KEY}@127.0.0.1:8333/${bucket}?scheme=http`;
}

/** The endpoint, bucket and credentials in an S3 test URL (the driver's `s3://` form). */
export function parseS3TestUrl(url: string): {
  /** `scheme://host:port`. */
  endpoint: string;
  /** The bucket. */
  bucket: string;
  /** The access key. */
  accessKeyId: string;
  /** The secret key. */
  secretAccessKey: string;
} {
  const parsed = new URL(url);
  const scheme = parsed.searchParams.get("scheme") ?? "https";
  return {
    endpoint: `${scheme}://${parsed.host}`,
    bucket: decodeURIComponent(parsed.pathname.slice(1)),
    accessKeyId: decodeURIComponent(parsed.username),
    secretAccessKey: decodeURIComponent(parsed.password),
  };
}

/** HMAC-SHA256. */
function hmacSha256(key: string | Uint8Array, data: string): Uint8Array {
  const hasher = new Bun.CryptoHasher("sha256", key);
  hasher.update(data);
  return hasher.digest();
}

/**
 * Signs a request with AWS Signature Version 4 (`UNSIGNED-PAYLOAD`, every
 * header given signed). Copied from bun-cache's
 * `packages/bun-cache/lib/drivers/s3-sign.ts` (`signS3Request`), cut to what
 * the bucket requests need: nothing in `scripts/` loads a workspace package.
 * Bun's `S3Client` cannot create a bucket, hence a signed `fetch`.
 */
export function signS3(
  credentials: { accessKeyId: string; secretAccessKey: string },
  method: string,
  url: URL,
  date = new Date(),
  region = "us-east-1",
  payloadHash = "UNSIGNED-PAYLOAD",
): Record<string, string> {
  const stamp = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = stamp.slice(0, 8);
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": stamp,
  };
  const names = Object.keys(headers).sort();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(
    [
      method,
      url.pathname,
      url.search.slice(1),
      names.map((name) => `${name}:${headers[name]}\n`).join(""),
      names.join(";"),
      payloadHash,
    ].join("\n"),
  );
  const scope = `${day}/${region}/s3/aws4_request`;
  const key = hmacSha256(
    hmacSha256(
      hmacSha256(hmacSha256(`AWS4${credentials.secretAccessKey}`, day), region),
      "s3",
    ),
    "aws4_request",
  );
  const signer = new Bun.CryptoHasher("sha256", key);
  signer.update(
    ["AWS4-HMAC-SHA256", stamp, scope, hasher.digest("hex")].join("\n"),
  );
  const { host: _host, ...send } = headers;
  return {
    ...send,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signer.digest("hex")}`,
  };
}

/** Whether a bucket-create answer means the bucket is there and ours: 200, or 409 `BucketAlreadyOwnedByYou`. */
export function bucketCreated(status: number, body: string): boolean {
  return (
    status === 200 ||
    (status === 409 && body.includes("<Code>BucketAlreadyOwnedByYou</Code>"))
  );
}

/**
 * Whether the bucket in an S3 test URL is usable over its credentials: a
 * signed `HEAD`, then — when it is absent and `lookOnly` is false — a signed
 * `PUT` to create it. Never deletes or empties a bucket.
 */
async function ensureS3Bucket(
  url: string,
  lookOnly: boolean,
): Promise<boolean> {
  const target = parseS3TestUrl(url);
  const bucketUrl = new URL(`${target.endpoint}/${target.bucket}`);
  try {
    const head = await fetch(bucketUrl, {
      method: "HEAD",
      headers: signS3(target, "HEAD", bucketUrl),
    });
    if (head.ok) {
      lastS3Error = "";
      return true;
    }
    if (head.status !== 404 || lookOnly) {
      lastS3Error = `HEAD /${target.bucket} answered ${head.status}`;
      return false;
    }
    const created = await fetch(bucketUrl, {
      method: "PUT",
      headers: signS3(target, "PUT", bucketUrl),
    });
    const body = await created.text();
    if (bucketCreated(created.status, body)) {
      lastS3Error = "";
      return true;
    }
    lastS3Error = `PUT /${target.bucket} answered ${created.status} ${/<Code>([^<]+)/.exec(body)?.[1] ?? ""}`;
    return false;
  } catch (error) {
    lastS3Error = error instanceof Error ? error.message : String(error);
    return false;
  }
}

/** bun-cache's bucket ({@link S3_CACHE_BUCKET}), on an S3 server that is ready for bun-jobs: created when absent. */
async function ensureCacheBucket(
  plan: ServicePlan,
  options: Options,
): Promise<{ note: string; failed: boolean }> {
  const url = plan.cacheUrl!(options);
  if (await ensureS3Bucket(url, true)) {
    log.skip(`the ${S3_CACHE_BUCKET} bucket (bun-cache) is already usable`);
    return { note: `${S3_CACHE_BUCKET} ready`, failed: false };
  }
  log.cmd([`(signed PUT /${S3_CACHE_BUCKET} over 127.0.0.1:${plan.port})`]);
  if (options.dryRun) {
    return { note: `${S3_CACHE_BUCKET} once created`, failed: false };
  }
  if (!(await ensureS3Bucket(url, false))) {
    log.bad(`could not create the ${S3_CACHE_BUCKET} bucket: ${lastS3Error}`);
    return { note: `${S3_CACHE_BUCKET} not created`, failed: true };
  }
  log.did(`created the ${S3_CACHE_BUCKET} bucket (bun-cache)`);
  return { note: `created ${S3_CACHE_BUCKET}`, failed: false };
}

/* ------------------------------------------------------------------ *
 * Azure Blob Storage (Azurite)
 * ------------------------------------------------------------------ */

/**
 * The Azure test URL for a blob container, in `azureBlobDriver`'s form:
 * `azure://<account>:<key>@<host>:<port>/<account>/<container>?scheme=http`
 * — Azurite's blob endpoint is path-style, `http://127.0.0.1:10000/<account>`,
 * and the key is percent-encoded (it holds `/` and `=`).
 */
export function azureTestUrl(container: string, oauth = false): string {
  const base = `azure://${AZURE_ACCOUNT}:${encodeURIComponent(AZURE_ACCOUNT_KEY)}@127.0.0.1`;
  // The `--oauth basic` Azurite is HTTPS, the driver's default scheme: no
  // `scheme` parameter.
  return oauth
    ? `${base}:${AZURE_OAUTH_PORT}/${AZURE_ACCOUNT}/${container}`
    : `${base}:10000/${AZURE_ACCOUNT}/${container}?scheme=http`;
}

/** The `openssl` command that makes the `azure-oauth` self-signed certificate and key in `dir`. */
export function azureOauthCertArgv(dir: string): string[] {
  return [
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    `${dir}/certs/key.pem`,
    "-out",
    `${dir}/certs/cert.pem`,
    "-days",
    "3650",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ];
}

/**
 * Makes the `azure-oauth` certificate and key (in `<dir>/certs`, so that
 * copying `<dir>` to `/` puts them at `/certs`) unless both are there. Never
 * replaces one. The private key is 0644 inside a 0700 directory: the Azurite
 * process in the container is not the host user.
 */
async function ensureAzureOauthCert(options: Options): Promise<boolean> {
  const dir = azureOauthCertDir();
  const { chmodSync, existsSync, mkdirSync } = await import("node:fs");
  if (
    existsSync(`${dir}/certs/cert.pem`) &&
    existsSync(`${dir}/certs/key.pem`)
  ) {
    log.skip(`the certificate in ${dir}/certs is already there`);
    return true;
  }
  const argv = azureOauthCertArgv(dir);
  log.cmd(["mkdir", "-p", `${dir}/certs`]);
  log.cmd(argv);
  if (options.dryRun) {
    return true;
  }
  if (!has("openssl")) {
    log.bad("openssl is needed to make the azure-oauth certificate");
    return false;
  }
  mkdirSync(`${dir}/certs`, { recursive: true, mode: 0o700 });
  const made = await run(argv);
  if (!made.ok) {
    log.bad(tail(made.stderr, 2));
    return false;
  }
  chmodSync(`${dir}/certs/key.pem`, 0o644);
  log.did(`made a self-signed certificate in ${dir}/certs`);
  return true;
}

/** The blob endpoint, container and credentials in an Azure test URL (the driver's `azure://` form). */
export function parseAzureTestUrl(url: string): {
  /** `scheme://host:port[/path]`, the blob endpoint. */
  endpoint: string;
  /** The blob container. */
  container: string;
  /** The account name. */
  account: string;
  /** The account key, base64. */
  key: string;
} {
  const parsed = new URL(url);
  const scheme = parsed.searchParams.get("scheme") ?? "https";
  const path = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  const container = decodeURIComponent(path.pop() ?? "");
  return {
    endpoint: `${scheme}://${parsed.host}${path.length > 0 && path[0] !== "" ? `/${path.join("/")}` : ""}`,
    container,
    account: decodeURIComponent(parsed.username),
    key: decodeURIComponent(parsed.password),
  };
}

/**
 * Signs a Blob service request with Shared Key (the 2009-09-19 and later
 * string to sign; every header empty but the `x-ms-*` ones). Copied from
 * bun-cache's `packages/bun-cache/lib/drivers/azure-sign.ts`
 * (`signAzureRequest`), cut to the bodiless requests a blob container needs:
 * nothing in `scripts/` loads a workspace package.
 */
export function signAzure(
  credentials: { account: string; key: string },
  method: string,
  url: URL,
  date = new Date(),
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-ms-date": date.toUTCString(),
    "x-ms-version": AZURE_API_VERSION,
  };
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}\n`)
    .join("");
  const query = [...url.searchParams]
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `\n${name}:${value}`)
    .join("");
  const stringToSign = `${method}\n${"\n".repeat(11)}${canonicalHeaders}/${credentials.account}${url.pathname}${query}`;
  const signer = new Bun.CryptoHasher(
    "sha256",
    Buffer.from(credentials.key, "base64"),
  );
  signer.update(stringToSign);
  return {
    ...headers,
    authorization: `SharedKey ${credentials.account}:${signer.digest("base64")}`,
  };
}

/** Whether a container-create answer means the container is there: 201, or 409 `ContainerAlreadyExists`. */
export function azureContainerCreated(status: number, body: string): boolean {
  return (
    status === 201 ||
    (status === 409 && body.includes("<Code>ContainerAlreadyExists</Code>"))
  );
}

/** Bun's `fetch` `tls` option, which exempts a self-signed loopback certificate. */
const azureLoopbackTls = { tls: { rejectUnauthorized: false } };

/**
 * Whether the blob container in an Azure test URL is usable over its
 * credentials: Get Container Properties, then — when it is absent and
 * `lookOnly` is false — Create Container. Never deletes or empties one.
 */
async function ensureAzureContainer(
  url: string,
  lookOnly: boolean,
): Promise<boolean> {
  const target = parseAzureTestUrl(url);
  const containerUrl = new URL(
    `${target.endpoint}/${target.container}?restype=container`,
  );
  // Bun's per-request TLS option: the `--oauth basic` Azurite's certificate is
  // self-signed. Exempt for this one loopback host, as the suite does.
  const tls = containerUrl.protocol === "https:" ? azureLoopbackTls : {};
  try {
    const head = await fetch(containerUrl, {
      method: "HEAD",
      headers: signAzure(target, "HEAD", containerUrl),
      ...tls,
    });
    if (head.ok) {
      lastAzureError = "";
      return true;
    }
    if (head.status !== 404 || lookOnly) {
      lastAzureError = `HEAD /${target.container} answered ${head.status} ${head.headers.get("x-ms-error-code") ?? ""}`;
      return false;
    }
    const created = await fetch(containerUrl, {
      method: "PUT",
      headers: signAzure(target, "PUT", containerUrl),
      ...tls,
    });
    const body = await created.text();
    if (azureContainerCreated(created.status, body)) {
      lastAzureError = "";
      return true;
    }
    lastAzureError = `PUT /${target.container} answered ${created.status} ${/<Code>([^<]+)/.exec(body)?.[1] ?? ""}`;
    return false;
  } catch (error) {
    lastAzureError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

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
  /** Whether bun-cache's database could not be made usable, on a server that has one. */
  cacheFailed?: boolean;
  /** Whether `--recreate` was asked for and did not recreate this server's container. */
  recreateFailed?: boolean;
}

/**
 * The statements that create bun-cache's database ({@link CACHE_DATABASE}) on
 * a SQL server and give the suites' user all of it. Each is conditional
 * (`IF NOT EXISTS`, or Postgres's `\gexec` over a `NOT EXISTS` check when
 * run through `psql`), so an existing database keeps its tables. `host` says
 * how they are run: through the server's own client as its administrator on
 * a native install, or over SQL as the root account of this script's
 * container — where Postgres cannot use `\gexec` and the caller checks
 * `pg_database` first. Empty for a server with no bun-cache database.
 */
export function cacheDatabaseStatements(
  service: Service,
  options: Pick<Options, "cacheDatabase" | "user">,
  host: LimitHost,
): string[] {
  const db = options.cacheDatabase;
  const user = options.user;
  if (service === "postgres") {
    return host === "native"
      ? [
          `SELECT 'CREATE DATABASE ${db} OWNER ${user}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${db}') \\gexec`,
        ]
      : [`CREATE DATABASE ${db} OWNER ${user}`];
  }
  if (service === "mariadb" || service === "mysql") {
    // The image creates its user for '%'; a native MariaDB has the
    // 'localhost' twin `configure` made too.
    const hosts = host === "native" ? ["%", "localhost"] : ["%"];
    return [
      `CREATE DATABASE IF NOT EXISTS \`${db}\``,
      ...hosts.map(
        (from) => `GRANT ALL PRIVILEGES ON \`${db}\`.* TO '${user}'@'${from}'`,
      ),
    ];
  }
  return [];
}

/**
 * Makes bun-cache's database usable on a server that is ready for bun-jobs:
 * nothing when connecting to it already works; otherwise the
 * {@link cacheDatabaseStatements}, run as the server's administrator, then a
 * real connection over the suites' URL. Returns a note for the summary, and
 * whether it failed.
 */
async function ensureCacheDatabase(
  plan: ServicePlan,
  host: LimitHost,
  platform: Platform,
  options: Options,
  kind: "test" | "bench" = "test",
): Promise<{ note: string; failed: boolean }> {
  const bench = kind === "bench";
  const urlOf = bench ? plan.cacheBenchUrl : plan.cacheUrl;
  if (!urlOf || (bench && plan.service === "redis")) {
    // Redis's benchmark database is number 12: nothing to make.
    return { note: "", failed: false };
  }
  if (plan.service === "s3") {
    return await ensureCacheBucket(plan, options);
  }
  // The benchmark database takes the test database's place in everything below.
  const named: Options = bench
    ? { ...options, cacheDatabase: options.cacheBenchDatabase }
    : options;
  const db = named.cacheDatabase;
  if (plan.service === "mongodb" || plan.service === "mongodb-rs") {
    // MongoDB creates a database on its first write: nothing to make.
    return { note: `${db} on first write`, failed: false };
  }
  const url = urlOf(options);
  if (await sqlReachable(url)) {
    log.skip(`the ${db} database (bun-cache) is already usable`);
    return { note: `${db} ready`, failed: false };
  }
  const statements = cacheDatabaseStatements(plan.service, named, host);

  if (host === "container") {
    const rootUrl = plan.containerRootUrl?.(options);
    if (!rootUrl) {
      log.bad(`no root account known; run as root: ${statements.join(" ")}`);
      return { note: `${db} not created`, failed: true };
    }
    for (const statement of statements) {
      log.cmd([`(as root, over 127.0.0.1:${plan.port})`, statement]);
    }
    if (!options.dryRun) {
      let error: string | null = null;
      if (plan.service === "postgres") {
        // No \gexec over SQL, and CREATE DATABASE cannot run inside a DO
        // block: check, then create.
        try {
          const sql = await openSql(rootUrl);
          try {
            const rows = await sql.unsafe<unknown[]>(
              "SELECT 1 FROM pg_database WHERE datname = $1",
              [db],
            );
            if (rows.length === 0) {
              await sql.unsafe(statements[0]).simple();
            }
          } finally {
            await sql.close();
          }
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        }
      } else {
        for (const statement of statements) {
          error ??= await raiseOverSql(rootUrl, statement);
        }
      }
      if (error) {
        log.bad(`could not create ${db} as root: ${error}`);
        return { note: `${db} not created`, failed: true };
      }
    }
  } else if (plan.service === "postgres") {
    for (const statement of statements) {
      const argv = postgresAdminArgv(platform, statement);
      log.cmd(["psql", "-c", `${statement.slice(0, 58)}...`]);
      if (options.dryRun) {
        continue;
      }
      const result = await run(argv);
      if (!result.ok) {
        log.bad(tail(result.stderr, 2));
        return { note: `${db} not created`, failed: true };
      }
    }
  } else {
    const client = has("mariadb") ? "mariadb" : has("mysql") ? "mysql" : null;
    const argv = elevate(platform, [client ?? "mariadb", "-u", "root"]);
    log.cmd([...argv, "<", `(create the ${db} database)`]);
    if (!options.dryRun) {
      if (!client) {
        log.bad(`no mariadb or mysql client found, so ${db} cannot be created`);
        return { note: `${db} not created`, failed: true };
      }
      const result = await run(argv, {
        input: `${statements.join(";\n")};`,
      });
      if (!result.ok) {
        log.bad(tail(result.stderr, 2));
        return { note: `${db} not created`, failed: true };
      }
    }
  }

  if (options.dryRun) {
    return { note: `${db} once created`, failed: false };
  }
  if (!(await sqlReachable(url))) {
    log.bad(`${db} is still not usable over its URL: ${lastSqlError}`);
    return { note: `${db} not usable`, failed: true };
  }
  log.did(`created the ${db} database (bun-cache)`);
  return { note: `created ${db}`, failed: false };
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

/** What {@link reconcileContainer} found and did. */
interface Reconciled {
  /** A note for the summary, or `""` when the container is as it should be. */
  note: string;
  /** Whether `--recreate` was asked for and did not happen, which fails the run. */
  failed: boolean;
  /** Whether the server is down after it: a rollback that did not bring the old container back. */
  down: boolean;
}

/** Nothing to report. */
const RECONCILED: Reconciled = { note: "", failed: false, down: false };

/**
 * A SQL server's databases this script provides, by name and the suites' URL
 * to each: bun-jobs', bun-cache's and bun-cache's benchmark one. Empty for a
 * server that is not SQL.
 */
function sqlDatabases(
  plan: ServicePlan,
  options: Options,
): Array<{ name: string; url: string }> {
  if (!plan.managesConnectionLimit && plan.service !== "postgres") {
    return [];
  }
  return [
    { name: options.database, url: plan.url(options) },
    ...(plan.cacheUrl
      ? [{ name: options.cacheDatabase, url: plan.cacheUrl(options) }]
      : []),
    ...(plan.cacheBenchUrl
      ? [{ name: options.cacheBenchDatabase, url: plan.cacheBenchUrl(options) }]
      : []),
  ];
}

/**
 * The `max_connections` a SQL server has now, or `null` when it cannot be
 * read or the server has none. For Postgres a value waiting for a restart
 * counts too, so a recreate never pins less than what is pending.
 */
async function liveLimit(
  plan: ServicePlan,
  options: Options,
): Promise<number | null> {
  if (plan.managesConnectionLimit) {
    return await readMaxConnections(plan.url(options));
  }
  if (plan.service === "postgres") {
    const state = await readPostgresLimit(plan.url(options));
    return state === null
      ? null
      : Math.max(state.current, state.pendingValue ?? 0);
  }
  return null;
}

/**
 * Checks an existing container of this script's against what it is created
 * with now ({@link containerDrift}). A container that is behind is reported,
 * with the flag that fixes it; with `--recreate`, and while it is running, it
 * is recreated by {@link recreateContainer}, keeping its data.
 *
 * The recreated container never gets less than the server has now: its
 * `max_connections` argument is the larger of the target and the live value
 * (on Postgres, a value pending a restart too), so a value raised by hand
 * survives. A live value that cannot be read stops a real recreate, since it
 * could not know it would not lower it. Before stopping the container it notes
 * which of the server's databases connect as the suites' user; the new
 * container must connect to the same ones.
 */
async function reconcileContainer(
  plan: ServicePlan,
  options: Options,
  running: boolean,
): Promise<Reconciled> {
  const spec = plan.container(options);
  const inspected = await inspectContainer(spec.name);
  if (!inspected) {
    return RECONCILED;
  }
  const drift = containerDrift(spec, inspected);
  if (drift.length === 0) {
    return RECONCILED;
  }

  for (const item of drift) {
    log.warn(`container ${spec.name} was ${item.message}`);
  }
  if (
    plan.managesConnectionLimit &&
    drift.some((item) => item.setting === "max-connections")
  ) {
    log.warn(
      plan.service === "mysql"
        ? "its max_connections lasts across a restart only while it was raised with SET PERSIST (as this script raises it), not with SET GLOBAL"
        : "a restart loses a max_connections raised live with SET GLOBAL",
    );
  }
  if (!options.recreate) {
    log.warn(
      `rerun with --recreate to recreate ${spec.name} with them, keeping its data (it restarts the server)`,
    );
    return {
      ...RECONCILED,
      note: "container behind its spec (see --recreate)",
    };
  }
  if (!running) {
    log.bad(`container ${spec.name} is not running, so it is not recreated`);
    return { ...RECONCILED, note: "not recreated: not running", failed: true };
  }
  const blocker = recreateBlocker(spec, inspected);
  if (blocker) {
    log.bad(`not recreating ${spec.name}: ${blocker}`);
    return { ...RECONCILED, note: "not recreated", failed: true };
  }

  // Never pin less than the server has now.
  let recreated = spec;
  let wanted: number | null = null;
  if (plan.managesConnectionLimit || plan.service === "postgres") {
    const target =
      plan.service === "postgres"
        ? options.postgresMaxConnections
        : options.maxConnections;
    const live = await liveLimit(plan, options);
    if (live === null && !options.dryRun) {
      log.bad(
        `could not read ${spec.name}'s max_connections, so it is not recreated: that could lower it`,
      );
      return {
        ...RECONCILED,
        note: "not recreated: max_connections unreadable",
        failed: true,
      };
    }
    wanted = Math.max(target, live ?? 0);
    recreated = plan.container(
      plan.service === "postgres"
        ? { ...options, postgresMaxConnections: wanted }
        : { ...options, maxConnections: wanted },
    );
  }

  const databases: Array<{ name: string; url: string }> = [];
  if (!options.dryRun) {
    for (const database of sqlDatabases(plan, options)) {
      if (await sqlReachable(database.url)) {
        databases.push(database);
      }
    }
  }

  log.warn(`recreating ${spec.name}, keeping its data`);
  const result = await recreateContainer(recreated, options.dryRun, {
    runner: run,
    waitReady: () => waitForConfigured(plan, options, plan.readyTimeout),
    verify: async () => {
      const after = await inspectContainer(spec.name);
      if (!after) {
        return "it could not be inspected";
      }
      const left = containerDrift(recreated, after);
      if (left.length > 0) {
        return `it was ${left.map((item) => item.message).join("; ")}`;
      }
      if (wanted !== null) {
        const now = await liveLimit(plan, options);
        if (now === null || now < wanted) {
          return `max_connections is ${now ?? "unreadable"}, not ${wanted}`;
        }
        log.did(`max_connections is ${now}`);
      }
      for (const database of databases) {
        if (!(await sqlReachable(database.url))) {
          return `${database.name} no longer connects as ${options.user}: ${lastSqlError}`;
        }
      }
      if (databases.length > 0) {
        log.did(
          `${databases.map((database) => database.name).join(", ")} still connect as ${options.user}`,
        );
      }
      return null;
    },
  });
  return {
    note: result.note,
    failed: result.outcome !== "recreated" && result.outcome !== "planned",
    down: result.outcome === "rollback-failed",
  };
}

/**
 * {@link setupServer}, then bun-cache's database on a server that has one and
 * came up ready.
 */
async function setupService(
  plan: ServicePlan,
  platform: Platform,
  options: Options,
): Promise<Outcome> {
  const outcome = await setupServer(plan, platform, options);
  if (!outcome.ready || !(plan.cacheUrl ?? plan.cacheBenchUrl)) {
    return outcome;
  }
  // The same reading of where it runs as the limit check's: this script's
  // container when one is running (or the server is container-only), a
  // native install otherwise.
  const name = plan.container(options).name;
  const state = platform.docker ? await containerState(name) : "";
  const host: LimitHost =
    plan.dockerOnly || state === "running" || options.mode === "docker"
      ? "container"
      : "native";
  const cache = await ensureCacheDatabase(plan, host, platform, options);
  const bench = await ensureCacheDatabase(
    plan,
    host,
    platform,
    options,
    "bench",
  );
  return {
    ...outcome,
    note: withLimit(
      outcome.note,
      [cache.note, bench.note].filter(Boolean).join(", "),
    ),
    cacheFailed: cache.failed || bench.failed,
  };
}

/** Installs and configures one server, skipping whatever is already done. */
async function setupServer(
  plan: ServicePlan,
  platform: Platform,
  options: Options,
): Promise<Outcome> {
  log.section(`${plan.service} (port ${plan.port})`);

  // Usable already? Then there is nothing to install and nothing to configure.
  if (await plan.configured(options)) {
    log.skip("already installed, running and reachable");
    const name = plan.container(options).name;
    const state = platform.docker ? await containerState(name) : "";
    // It may be one of this script's containers, created before a setting it
    // is created with now.
    const reconciled = platform.docker
      ? await reconcileContainer(plan, options, state === "running")
      : RECONCILED;
    if (reconciled.down) {
      return {
        service: plan.service,
        ready: false,
        note: reconciled.note,
        recreateFailed: true,
      };
    }
    // Whichever is serving: a server this script ran as a container is raised
    // as one, whatever the mode says, and anything else is a native install.
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
      note: withLimit(withLimit("already set up", reconciled.note), limit),
      recreateFailed: reconciled.failed,
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
    let started =
      existed ||
      !plan.prepareContainer ||
      (await plan.prepareContainer(options));
    started = started && (await ensureContainer(spec, options));

    if (started && plan.initContainer) {
      started = await plan.initContainer(options);
    }

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
        note: `the container did not become usable${lastSqlError || lastS3Error || lastAzureError ? `: ${lastSqlError || lastS3Error || lastAzureError}` : ""}`,
      };
    }

    // A container this run created has every setting; an older one may not.
    const reconciled = existed
      ? await reconcileContainer(plan, options, true)
      : RECONCILED;
    if (reconciled.down) {
      return {
        service: plan.service,
        ready: false,
        note: reconciled.note,
        recreateFailed: true,
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
      note: withLimit(
        withLimit("connected with the expected credentials", reconciled.note),
        limit,
      ),
      recreateFailed: reconciled.failed,
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
    if (plan.envVar) {
      console.log(`export ${plan.envVar}=${colour.cyan(plan.url(options))}`);
    }
    if (plan.cacheEnvVar) {
      const url = plan.cacheUrl ?? plan.url;
      console.log(`export ${plan.cacheEnvVar}=${colour.cyan(url(options))}`);
    }
    if (plan.cacheBenchEnvVar && plan.cacheBenchUrl) {
      console.log(
        `export ${plan.cacheBenchEnvVar}=${colour.cyan(plan.cacheBenchUrl(options))}`,
      );
    }
  }

  console.log(
    colour.dim(
      "\n  Then: cd packages/bun-jobs && bun test (or packages/bun-cache)" +
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
        options.recreate ? "recreates containers behind their spec" : "",
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

  if (outcomes.some((outcome) => outcome.cacheFailed)) {
    console.log(
      colour.dim(
        `\n  bun-cache's ${options.cacheDatabase} or ${options.cacheBenchDatabase} database could not be made usable on every server; see above.`,
      ),
    );
    process.exitCode = 1;
  }

  if (outcomes.some((outcome) => outcome.recreateFailed)) {
    console.log(
      colour.dim(
        "\n  A container could not be recreated; see above. Nothing was removed.",
      ),
    );
    process.exitCode = 1;
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
