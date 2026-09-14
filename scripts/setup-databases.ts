#!/usr/bin/env bun
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
}

/** Reads the command line into {@link Options}. */
function parseArgs(argv: string[]): Options {
  const options: Options = {
    services: [...SERVICES],
    mode: "native",
    dryRun: false,
    printEnv: false,
    assumeYes: false,
    password: "bunjobs",
    database: "bun_jobs_test",
    user: "bunjobs",
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
        fail(`--mode must be "native" or "docker", not "${mode}"`);
      }
      options.mode = mode;
    } else if (arg.startsWith("--only=")) {
      const names = arg.slice("--only=".length).split(",").filter(Boolean);
      for (const name of names) {
        if (!SERVICES.includes(name as Service)) {
          fail(`Unknown service "${name}". Known: ${SERVICES.join(", ")}`);
        }
      }
      options.services = names as Service[];
    } else if (arg.startsWith("--password=")) {
      options.password = arg.slice("--password=".length);
    } else if (arg.startsWith("--database=")) {
      options.database = arg.slice("--database=".length);
    } else if (arg.startsWith("--user=")) {
      options.user = arg.slice("--user=".length);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      fail(`Unrecognised argument "${arg}". Try --help.`);
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

Running it twice is safe: an installed server is not reinstalled, and
configuration runs only when a connection with the expected credentials
fails. Nothing is dropped or overwritten.
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
  for await (const line of console) {
    return /^y(?:es)?$/i.test(line.trim());
  }

  return false;
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
  cmd: (argv: string[]) => console.log(`  ${colour.dim(`$ ${argv.join(" ")}`)}`),
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
function elevate(platform: Platform, argv: string[]): string[] {
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

/** What a container needs to exist. */
interface ContainerSpec {
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
}

/** Starts a container, reusing one that already exists. */
async function ensureContainer(
  spec: ContainerSpec,
  options: Options,
): Promise<boolean> {
  const existing = await run([
    "docker",
    "ps",
    "--all",
    "--filter",
    `name=^/${spec.name}$`,
    "--format",
    "{{.State}}",
  ]);

  const state = existing.stdout.trim();

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

  const argv = [
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
    ...Object.entries(spec.env).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ]),
    spec.image,
  ];

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

/** Whether a SQL URL can be connected to and queried. */
async function sqlReachable(url: string): Promise<boolean> {
  try {
    const { SQL } = await import("bun");
    const sql = new SQL({ url });
    await sql.unsafe("SELECT 1");
    await sql.close();
    return true;
  } catch {
    return false;
  }
}

/** Every server, in the order they are set up. */
const PLANS: Record<Service, ServicePlan> = {
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
    unit: (platform) => (platform.manager === "brew" ? "redis" : "redis-server"),
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
    configureNote: () => "nothing to configure: Redis needs no user or database",
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
      image: "postgres:16-alpine",
      port: 5432,
      env: {
        POSTGRES_USER: options.user,
        POSTGRES_PASSWORD: options.password,
        POSTGRES_DB: options.database,
      },
    }),
    // The only check that means anything: connect as the user, to the database.
    configured: async (options) =>
      (await portOpen(5432)) && (await sqlReachable(PLANS.postgres.url(options))),
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
        const argv =
          platform.manager === "brew"
            ? ["psql", "-v", "ON_ERROR_STOP=1", "-d", "postgres", "-c", statement]
            : elevate(platform, [
                "-u",
                "postgres",
                "psql",
                "-v",
                "ON_ERROR_STOP=1",
                "-c",
                statement,
              ]);

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
    }),
    configured: async (options) =>
      (await portOpen(3306)) && (await sqlReachable(PLANS.mariadb.url(options))),
    configure: async (platform, options) => {
      const client = has("mariadb") ? "mariadb" : has("mysql") ? "mysql" : null;

      if (!client) {
        // In a dry run the server has not actually been installed yet, so its
        // client is legitimately missing; reporting a failure would be wrong.
        if (options.dryRun) {
          log.cmd(["mariadb", "-u", "root", "<", "(create user and database)"]);
          return true;
        }

        log.bad("no mariadb or mysql client found, so the user cannot be created");
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
    }),
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
    return { service: plan.service, ready: true, note: "already set up" };
  }

  if (options.mode === "docker" || plan.dockerOnly) {
    if (!platform.docker) {
      log.bad(
        plan.dockerOnly
          ? `Docker is not usable here, and ${plan.dockerOnly}`
          : "Docker is not usable here",
      );
      return { service: plan.service, ready: false, note: "docker unavailable" };
    }

    if (plan.dockerOnly && options.mode !== "docker") {
      log.warn(plan.dockerOnly);
    }

    const started = await ensureContainer(plan.container(options), options);

    // A database image publishes its port before it has finished creating the
    // user it was told to create, so being reachable is not the same as being
    // usable; wait for a real connection rather than for the socket.
    const ready = options.dryRun
      ? true
      : started &&
        (await waitForConfigured(plan, options, plan.readyTimeout));

    return {
      service: plan.service,
      ready,
      note: ready ? "container running" : "the container did not become ready",
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
      return { service: plan.service, ready: false, note: "the install failed" };
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
  return {
    service: plan.service,
    ready,
    note: ready ? "ready" : "still not reachable",
  };
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
        "\n  A suite whose variable is unset skips, visibly.",
    ),
  );
}

/** Runs the script. */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

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
    const mark = outcome.ready ? colour.green("ready") : colour.red("not ready");
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

await main();
