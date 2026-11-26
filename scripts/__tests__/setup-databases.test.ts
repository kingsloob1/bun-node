import type {
  InspectedContainer,
  PostgresLimitContext,
  PostgresLimitIo,
  PostgresLimitState,
  RecreateIo,
  Runner,
} from "../setup-databases";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { availableParallelism } from "node:os";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  applyPostgresLimit,
  BASELINE_CORES,
  CACHE_DATABASE,
  CACHE_BENCH_DATABASE,
  cacheDatabaseStatements,
  connectionsForCores,
  defaultMaxConnections,
  defaultPostgresMaxConnections,
  describeLimit,
  describePostgresLimit,
  dockerRunArgv,
  limitStatement,
  MARIADB_LIMIT_FILE,
  mariadbConfDirs,
  mariadbLimitCnf,
  MAX_CONNECTIONS,
  MAX_CONNECTIONS_CEILING,
  mongoRsInitArgv,
  maxConnectionsArg,
  nativeLimitSteps,
  parseArgs,
  parseMaxConnections,
  planConnectionLimit,
  planPostgresLimit,
  PLANS,
  POSTGRES_MAX_CONNECTIONS,
  POSTGRES_MAX_CONNECTIONS_CEILING,
  postgresAdminArgv,
  postgresLimitStatement,
  postgresMaxConnectionsArg,
  postgresNotBackHint,
  postgresRestartArgv,
  runLimitSteps,
  UsageError,
  bucketCreated,
  parseS3TestUrl,
  S3_ACCESS_KEY,
  S3_BUCKET,
  S3_CACHE_BUCKET,
  S3_CONTAINER_IMAGE,
  S3_SECRET_KEY,
  s3TestUrl,
  signS3,
  AZURE_ACCOUNT,
  AZURE_ACCOUNT_KEY,
  AZURE_CACHE_CONTAINER,
  AZURE_CONTAINER_IMAGE,
  AZURE_OAUTH_CONTAINER,
  AZURE_OAUTH_PORT,
  azureContainerCreated,
  azureOauthCertArgv,
  azureOauthCertDir,
  dockerCreateArgv,
  azureTestUrl,
  parseAzureTestUrl,
  signAzure,
  containerDrift,
  INSPECT_FORMAT,
  parseInspected,
  RECREATE_STOP_SECONDS,
  RECREATE_SUFFIX,
  recreateArgv,
  recreateBlocker,
  recreateContainer,
} from "../setup-databases";

// Importing the script must not provision anything: it runs `main` only under
// `import.meta.main`. These tests reach no database, no sudo and no Docker.

describe("--max-connections", () => {
  it("defaults to the measured 1000 per 16 cores, scaled to this host, when absent", () => {
    // About 180 connections per server for one 16-worker parallel run, so
    // 1000 leaves room for several runs and the servers' other users.
    expect(MAX_CONNECTIONS).toBe(1000);
    expect(BASELINE_CORES).toBe(16);
    const here = defaultMaxConnections();
    expect(here).toBe(defaultMaxConnections(availableParallelism()));
    expect(here).toBeGreaterThanOrEqual(MAX_CONNECTIONS);
    expect(parseArgs([]).maxConnections).toBe(here);
    expect(parseArgs(["--dry-run", "--docker"]).maxConnections).toBe(here);
  });

  it("scales with the cores: more on a bigger host, never less on a smaller one", () => {
    // The suites run one worker per core, each with its own connections.
    expect(defaultMaxConnections(16)).toBe(1000);
    expect(defaultMaxConnections(4)).toBe(1000);
    expect(defaultMaxConnections(1)).toBe(1000);
    expect(defaultMaxConnections(17)).toBe(1063);
    expect(defaultMaxConnections(32)).toBe(2000);
    expect(defaultMaxConnections(64)).toBe(4000);
    expect(defaultPostgresMaxConnections(16)).toBe(700);
    expect(defaultPostgresMaxConnections(8)).toBe(700);
    expect(defaultPostgresMaxConnections(64)).toBe(2800);
    expect(defaultPostgresMaxConnections(128)).toBe(5600);
  });

  it("never scales past the ceiling a server accepts", () => {
    expect(defaultPostgresMaxConnections(512)).toBe(
      POSTGRES_MAX_CONNECTIONS_CEILING,
    );
    expect(defaultMaxConnections(10_000)).toBe(MAX_CONNECTIONS_CEILING);
    expect(connectionsForCores(100, 150, 64)).toBe(150);
  });

  it("takes a valid value", () => {
    expect(parseArgs(["--max-connections=800"]).maxConnections).toBe(800);
    expect(parseArgs(["--max-connections=1"]).maxConnections).toBe(1);
    expect(
      parseArgs([`--max-connections=${MAX_CONNECTIONS_CEILING}`])
        .maxConnections,
    ).toBe(MAX_CONNECTIONS_CEILING);
  });

  it("the last one given wins, like the other options", () => {
    expect(
      parseArgs(["--max-connections=600", "--max-connections=700"])
        .maxConnections,
    ).toBe(700);
  });

  it.each(["abc", "", "1e3", "500.5", "0x200", " 500", "500 ", "+500"])(
    "refuses a value that is not a plain whole number: %p",
    (raw) => {
      expect(() => parseArgs([`--max-connections=${raw}`])).toThrow(UsageError);
      expect(() => parseMaxConnections(raw)).toThrow(
        "--max-connections must be a positive whole number",
      );
    },
  );

  it.each(["0", "-1", "-500", "00"])(
    "refuses zero or a negative number: %p",
    (raw) => {
      expect(() => parseArgs([`--max-connections=${raw}`])).toThrow(UsageError);
    },
  );

  it("refuses more than the servers accept, which could never be met", () => {
    expect(() =>
      parseMaxConnections(String(MAX_CONNECTIONS_CEILING + 1)),
    ).toThrow(`at most ${MAX_CONNECTIONS_CEILING}`);
  });

  it("other bad arguments are usage errors too, not a process exit", () => {
    expect(() => parseArgs(["--mode=cloud"])).toThrow(UsageError);
    expect(() => parseArgs(["--only=oracle"])).toThrow(UsageError);
    expect(() => parseArgs(["--nonsense"])).toThrow(UsageError);
  });
});

describe("planConnectionLimit", () => {
  it("raises a server below the target", () => {
    expect(planConnectionLimit(151, 1000)).toEqual({
      action: "raise",
      current: 151,
      target: 1000,
    });
    expect(planConnectionLimit(999, 1000).action).toBe("raise");
  });

  it("leaves a server at the target alone", () => {
    expect(planConnectionLimit(1000, 1000)).toEqual({
      action: "keep",
      current: 1000,
      target: 1000,
    });
  });

  it("never lowers a server above the target", () => {
    expect(planConnectionLimit(5000, 1000)).toEqual({
      action: "keep",
      current: 5000,
      target: 1000,
    });
    // A user asking for less than the server has changes nothing either.
    expect(planConnectionLimit(500, 200).action).toBe("keep");
  });

  it("calls a value it could not read unknown, rather than guessing", () => {
    expect(planConnectionLimit(null, 1000)).toEqual({
      action: "unknown",
      current: null,
      target: 1000,
    });
  });

  it("describes each plan with the value it would apply", () => {
    expect(describeLimit(planConnectionLimit(151, 1000))).toBe(
      "max_connections is 151, below 1000: raising it to 1000",
    );
    expect(describeLimit(planConnectionLimit(5000, 1000))).toBe(
      "max_connections is 5000, at least 1000: left alone",
    );
    expect(describeLimit(planConnectionLimit(null, 1000))).toBe(
      "max_connections not readable yet: setting it to 1000",
    );
  });
});

describe("containers", () => {
  /** The options a run with `argv` would use. */
  const options = (...argv: string[]) => parseArgs(argv);

  it.each(["mariadb", "mysql"] as const)(
    "%s is created with --max-connections as a server argument, after the image",
    (service) => {
      const spec = PLANS[service].container(options("--max-connections=750"));
      const argv = dockerRunArgv(spec);
      const image = argv.indexOf(spec.image);
      expect(image).toBeGreaterThan(0);
      // Docker options before the image, the server's after it.
      expect(argv.slice(image)).toEqual([spec.image, "--max-connections=750"]);
    },
  );

  it("uses the default limit when none is given", () => {
    const argv = dockerRunArgv(PLANS.mariadb.container(options()));
    expect(argv.at(-1)).toBe(`--max-connections=${defaultMaxConnections()}`);
  });

  it.each(["redis", "mongodb"] as const)(
    "%s gets no --max-connections and ends at its image",
    (service) => {
      const spec = PLANS[service].container(options());
      const argv = dockerRunArgv(spec);
      expect(argv.at(-1)).toBe(spec.image);
      expect(argv.some((arg) => arg.includes("max-connections"))).toBe(false);
    },
  );

  it("keeps the shape every container had: loopback, ulimit, env", () => {
    const argv = dockerRunArgv(PLANS.mysql.container(options()));
    expect(argv.slice(0, 7)).toEqual([
      "docker",
      "run",
      "--detach",
      "--name",
      "bun-jobs-mysql",
      "--restart",
      "unless-stopped",
    ]);
    expect(argv).toContain("127.0.0.1:3307:3306");
    expect(argv).toContain("nofile=65536:65536");
    expect(argv).toContain("MYSQL_USER=bunjobs");
  });

  it("reads the limit a container was created with from its command line", () => {
    expect(maxConnectionsArg(["mysqld"])).toBeNull();
    expect(maxConnectionsArg(null)).toBeNull();
    expect(maxConnectionsArg(["--max-connections=1000"])).toBe(1000);
    // Both spellings the servers accept; the last one wins, as for them.
    expect(
      maxConnectionsArg(["--max_connections=200", "--max-connections=300"]),
    ).toBe(300);
    expect(maxConnectionsArg(["--max-connections-x=5"])).toBeNull();
  });

  it("MariaDB and MySQL are raised live; Postgres has its own path", () => {
    expect(PLANS.mariadb.managesConnectionLimit).toBe(true);
    expect(PLANS.mysql.managesConnectionLimit).toBe(true);
    expect(PLANS.postgres.managesConnectionLimit).toBeUndefined();
  });

  it("raises an existing container as the root account it was created with", () => {
    const opts = options();
    expect(PLANS.mariadb.containerRootUrl?.(opts)).toBe(
      "mariadb://root:bunjobs@127.0.0.1:3306/bun_jobs_test",
    );
    // MYSQL_ROOT_PASSWORD is the password plus "-root".
    expect(PLANS.mysql.container(opts).env.MYSQL_ROOT_PASSWORD).toBe(
      "bunjobs-root",
    );
    expect(PLANS.mysql.containerRootUrl?.(opts)).toBe(
      "mysql://root:bunjobs-root@127.0.0.1:3307/bun_jobs_test?allowPublicKeyRetrieval=true",
    );
  });

  it("MySQL persists the raise; MariaDB can only set it live", () => {
    expect(limitStatement("mysql", 1000)).toBe(
      "SET PERSIST max_connections = 1000;",
    );
    expect(limitStatement("mariadb", 1000)).toBe(
      "SET GLOBAL max_connections = 1000;",
    );
  });
});

describe("native MariaDB", () => {
  it("writes a [mysqld] drop-in with the target", () => {
    const cnf = mariadbLimitCnf(1000);
    expect(cnf).toEndWith("[mysqld]\nmax_connections = 1000\n");
    // Everything above the section is a comment.
    const before = cnf.slice(0, cnf.indexOf("[mysqld]")).trim().split("\n");
    expect(before.every((line) => line.startsWith("#"))).toBe(true);
    expect(MARIADB_LIMIT_FILE).toBe("99-bun-jobs.cnf");
  });

  it("looks in each distribution's drop-in directory", () => {
    expect(mariadbConfDirs("apt")[0]).toBe("/etc/mysql/mariadb.conf.d");
    expect(mariadbConfDirs("dnf")).toEqual(["/etc/my.cnf.d"]);
    expect(mariadbConfDirs("pacman")).toEqual(["/etc/my.cnf.d"]);
    expect(mariadbConfDirs("zypper")).toEqual(["/etc/my.cnf.d"]);
    expect(mariadbConfDirs("brew")).toContain("/opt/homebrew/etc/my.cnf.d");
    expect(mariadbConfDirs(null).length).toBeGreaterThan(0);
  });

  it("writes the file and sets the value live, both through sudo", () => {
    const path = `/etc/mysql/mariadb.conf.d/${MARIADB_LIMIT_FILE}`;
    const steps = nativeLimitSteps({ needsSudo: true }, "mariadb", path, 1000);
    expect(steps.map((step) => step.argv)).toEqual([
      ["sudo", "tee", path],
      ["sudo", "mariadb", "-u", "root"],
    ]);
    expect(steps[0]?.input).toBe(mariadbLimitCnf(1000));
    expect(steps[1]?.input).toBe("SET GLOBAL max_connections = 1000;");
  });

  it("needs no sudo where the machine needs none (Homebrew)", () => {
    const steps = nativeLimitSteps({ needsSudo: false }, "mysql", "/x.cnf", 1);
    expect(steps.map((step) => step.argv)).toEqual([
      ["tee", "/x.cnf"],
      ["mysql", "-u", "root"],
    ]);
  });

  it("sets only the live value when there is no drop-in directory", () => {
    const steps = nativeLimitSteps({ needsSudo: true }, "mariadb", null, 1000);
    expect(steps.map((step) => step.argv)).toEqual([
      ["sudo", "mariadb", "-u", "root"],
    ]);
  });
});

describe("runLimitSteps", () => {
  let logs: string[];
  let spy: ReturnType<typeof spyOn<Console, "log">>;

  beforeEach(() => {
    logs = [];
    spy = spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
  });
  afterEach(() => spy.mockRestore());

  /** A runner that records each call and answers with `ok`. */
  const recorder = (ok: (argv: string[]) => boolean) => {
    const calls: Array<{ argv: string[]; input?: string }> = [];
    const runner: Runner = async (argv, options) => {
      calls.push({ argv, input: options?.input });
      const success = ok(argv);
      return {
        code: success ? 0 : 1,
        stdout: "",
        stderr: success ? "" : "denied",
        ok: success,
      };
    };
    return { calls, runner };
  };

  const steps = nativeLimitSteps(
    { needsSudo: true },
    "mariadb",
    "/etc/mysql/mariadb.conf.d/99-bun-jobs.cnf",
    1000,
  );

  it("a dry run prints every command and runs none", async () => {
    const { calls, runner } = recorder(() => true);
    expect(await runLimitSteps(steps, true, runner)).toBe(true);
    expect(calls).toEqual([]);
    expect(logs.join("\n")).toContain(
      "$ sudo tee /etc/mysql/mariadb.conf.d/99-bun-jobs.cnf < ([mysqld] max_connections = 1000)",
    );
    expect(logs.join("\n")).toContain(
      "$ sudo mariadb -u root < (SET GLOBAL max_connections = 1000;)",
    );
  });

  it("a real run runs each step in order with its input", async () => {
    const { calls, runner } = recorder(() => true);
    expect(await runLimitSteps(steps, false, runner)).toBe(true);
    expect(calls).toEqual(
      steps.map((step) => ({ argv: step.argv, input: step.input })),
    );
  });

  it("stops at the first step that fails", async () => {
    const { calls, runner } = recorder((argv) => !argv.includes("tee"));
    expect(await runLimitSteps(steps, false, runner)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(logs.join("\n")).toContain("denied");
  });
});

describe("--postgres-max-connections and --restart-postgres", () => {
  it("defaults to the measured 700 per 16 cores, scaled to this host, and no restart, when absent", () => {
    // One 16-worker parallel run peaked at 182 Postgres connections.
    expect(POSTGRES_MAX_CONNECTIONS).toBe(700);
    const options = parseArgs([]);
    expect(options.postgresMaxConnections).toBe(
      defaultPostgresMaxConnections(),
    );
    expect(options.postgresMaxConnections).toBeGreaterThanOrEqual(
      POSTGRES_MAX_CONNECTIONS,
    );
    expect(options.restartPostgres).toBe(false);
  });

  it("takes a valid value, separately from --max-connections", () => {
    const options = parseArgs([
      "--postgres-max-connections=800",
      "--max-connections=900",
      "--restart-postgres",
    ]);
    expect(options.postgresMaxConnections).toBe(800);
    expect(options.maxConnections).toBe(900);
    expect(options.restartPostgres).toBe(true);
  });

  it.each(["abc", "", "1e3", "-1", "0", "700.5"])(
    "refuses a value that is not a positive whole number: %p",
    (raw) => {
      expect(() => parseArgs([`--postgres-max-connections=${raw}`])).toThrow(
        `--postgres-max-connections must be a positive whole number, not "${raw}"`,
      );
    },
  );

  it("refuses more than the sane ceiling, below Postgres's own", () => {
    expect(POSTGRES_MAX_CONNECTIONS_CEILING).toBeLessThan(262_143);
    expect(
      parseArgs([
        `--postgres-max-connections=${POSTGRES_MAX_CONNECTIONS_CEILING}`,
      ]).postgresMaxConnections,
    ).toBe(POSTGRES_MAX_CONNECTIONS_CEILING);
    expect(() =>
      parseArgs([
        `--postgres-max-connections=${POSTGRES_MAX_CONNECTIONS_CEILING + 1}`,
      ]),
    ).toThrow(`at most ${POSTGRES_MAX_CONNECTIONS_CEILING}`);
  });
});

describe("planPostgresLimit", () => {
  /** A state with nothing pending. */
  const now = (current: number): PostgresLimitState => ({
    current,
    pendingRestart: false,
    pendingValue: null,
  });

  it("raises a server below the target", () => {
    expect(planPostgresLimit(now(100), 700)).toEqual({
      action: "raise",
      current: 100,
      target: 700,
    });
  });

  it("leaves a server at the target alone", () => {
    expect(planPostgresLimit(now(700), 700).action).toBe("keep");
  });

  it("never lowers a server above the target", () => {
    expect(planPostgresLimit(now(2000), 700)).toEqual({
      action: "keep",
      current: 2000,
      target: 700,
    });
  });

  it("reports a sufficient value waiting for a restart, and does not set it again", () => {
    expect(
      planPostgresLimit(
        { current: 100, pendingRestart: true, pendingValue: 700 },
        700,
      ),
    ).toEqual({ action: "pending", current: 100, pending: 700, target: 700 });
    // Pending, value unreadable (not a superuser): still not set again.
    expect(
      planPostgresLimit(
        { current: 100, pendingRestart: true, pendingValue: null },
        700,
      ).action,
    ).toBe("pending");
  });

  it("raises again when the pending value is known to fall short", () => {
    expect(
      planPostgresLimit(
        { current: 100, pendingRestart: true, pendingValue: 300 },
        700,
      ).action,
    ).toBe("raise");
  });

  it("calls an unreadable server unknown", () => {
    expect(planPostgresLimit(null, 700).action).toBe("unknown");
  });

  it("describes each plan", () => {
    expect(describePostgresLimit(planPostgresLimit(now(300), 700))).toBe(
      "max_connections is 300, below 700: setting it to 700 with ALTER SYSTEM",
    );
    expect(describePostgresLimit(planPostgresLimit(now(700), 700))).toBe(
      "max_connections is 700, at least 700: left alone",
    );
    expect(
      describePostgresLimit(
        planPostgresLimit(
          { current: 300, pendingRestart: true, pendingValue: 800 },
          700,
        ),
      ),
    ).toContain("800 is already set and waiting for a restart");
  });
});

describe("Postgres commands", () => {
  it("a new container starts with -c max_connections, after the image", () => {
    const spec = PLANS.postgres.container(
      parseArgs(["--postgres-max-connections=750"]),
    );
    const argv = dockerRunArgv(spec);
    expect(argv.slice(argv.indexOf(spec.image))).toEqual([
      spec.image,
      "-c",
      "max_connections=750",
    ]);
    expect(
      dockerRunArgv(PLANS.postgres.container(parseArgs([]))).slice(-2),
    ).toEqual(["-c", `max_connections=${defaultPostgresMaxConnections()}`]);
  });

  it("raises a container as POSTGRES_USER, which the image makes superuser", () => {
    const options = parseArgs([]);
    const spec = PLANS.postgres.container(options);
    expect(PLANS.postgres.containerRootUrl?.(options)).toBe(
      `postgres://${spec.env.POSTGRES_USER}:${spec.env.POSTGRES_PASSWORD}@127.0.0.1:5432/${spec.env.POSTGRES_DB}`,
    );
  });

  it("reads what a container's command line pins", () => {
    expect(postgresMaxConnectionsArg(["postgres"])).toBeNull();
    expect(postgresMaxConnectionsArg(null)).toBeNull();
    expect(postgresMaxConnectionsArg(["-c", "max_connections=700"])).toBe(700);
    expect(postgresMaxConnectionsArg(["-cmax_connections=300"])).toBe(300);
    expect(
      postgresMaxConnectionsArg([
        "-c",
        "shared_buffers=1GB",
        "--max_connections=200",
        "-c",
        "max_connections=500",
      ]),
    ).toBe(500);
    expect(postgresMaxConnectionsArg(["max_connections=9"])).toBeNull();
  });

  it("runs ALTER SYSTEM natively as the postgres OS user", () => {
    const statement = postgresLimitStatement(700);
    expect(statement).toBe("ALTER SYSTEM SET max_connections = 700;");
    expect(
      postgresAdminArgv({ needsSudo: true, manager: "apt" }, statement),
    ).toEqual([
      "sudo",
      "-u",
      "postgres",
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      statement,
    ]);
    // As root there is no sudo to strip: runuser, not a bare "-u".
    expect(
      postgresAdminArgv({ needsSudo: false, manager: "apt" }, statement)[0],
    ).toBe("runuser");
    expect(
      postgresAdminArgv({ needsSudo: false, manager: "brew" }, statement),
    ).toEqual([
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-d",
      "postgres",
      "-c",
      statement,
    ]);
  });

  it("knows each way to restart it", () => {
    const linux = { needsSudo: true, manager: "apt" as const, systemd: true };
    expect(
      postgresRestartArgv(
        "container",
        linux,
        "postgresql",
        "bun-jobs-postgres",
      ),
    ).toEqual(["docker", "restart", "bun-jobs-postgres"]);
    expect(postgresRestartArgv("native", linux, "postgresql", "x")).toEqual([
      "sudo",
      "systemctl",
      "restart",
      "postgresql",
    ]);
    expect(
      postgresRestartArgv(
        "native",
        { needsSudo: false, manager: "brew", systemd: false },
        "postgresql@16",
        "x",
      ),
    ).toEqual(["brew", "services", "restart", "postgresql@16"]);
    expect(
      postgresRestartArgv(
        "native",
        { needsSudo: true, manager: "apt", systemd: false },
        "postgresql",
        "x",
      ),
    ).toBeNull();
  });
});

describe("applyPostgresLimit", () => {
  let logs: string[];
  let spy: ReturnType<typeof spyOn<Console, "log">>;

  beforeEach(() => {
    logs = [];
    spy = spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
  });
  afterEach(() => spy.mockRestore());

  /** Fakes for every effect, recording what was asked of each. */
  const fakes = (
    after: PostgresLimitState | null = {
      current: 700,
      pendingRestart: false,
      pendingValue: null,
    },
  ) => {
    const commands: string[][] = [];
    const statements: string[] = [];
    let waits = 0;
    let reads = 0;
    const io: PostgresLimitIo = {
      runner: async (argv) => {
        commands.push(argv);
        return { code: 0, stdout: "", stderr: "", ok: true };
      },
      execSuperuser: async (statement) => {
        statements.push(statement);
        return null;
      },
      waitReady: async () => {
        waits++;
        return true;
      },
      readState: async () => {
        reads++;
        return after;
      },
    };
    return {
      io,
      commands,
      statements,
      waits: () => waits,
      reads: () => reads,
    };
  };

  /** A context for this machine's case: this script's container. */
  const ctx = (
    overrides: Partial<PostgresLimitContext> = {},
  ): PostgresLimitContext => ({
    host: "container",
    platform: { needsSudo: true, manager: "apt", systemd: true },
    unit: "postgresql",
    containerName: "bun-jobs-postgres",
    containerExists: true,
    containerPin: null,
    dryRun: false,
    restart: false,
    ...overrides,
  });

  const raise = planPostgresLimit(
    { current: 100, pendingRestart: false, pendingValue: null },
    700,
  );

  it("with --restart-postgres, a server that does not come back: says why it may not have, and how to back the raise out", async () => {
    const f = fakes();
    f.io.waitReady = async () => false;
    const note = await applyPostgresLimit(raise, ctx({ restart: true }), f.io);
    expect(note).toBe("max_connections unknown (not back after the restart)");
    const out = logs.join("\n");
    expect(out).toContain(
      "Postgres did not accept connections again after the restart",
    );
    expect(out).toContain(
      "max_connections 700 may need more shared memory than this machine gives Postgres",
    );
    expect(out).toContain("docker logs bun-jobs-postgres | cat");
    // In place on the stopped container's volume, as the postgres user: no
    // `docker exec` (it is down), no root-owned copy, nothing through /tmp.
    // The container's own image, as root, giving the file back its owner:
    // the postgres user's uid differs by image (70 on Alpine, 999 on Debian).
    expect(out).toContain(
      `docker run --rm --user root --volumes-from bun-jobs-postgres --entrypoint sh "$(docker inspect -f '{{.Config.Image}}' bun-jobs-postgres | cat)"`,
    );
    expect(out).toContain(
      `-c 'for f in $(find /var/lib/postgresql -name postgresql.auto.conf); do o=$(stat -c %u:%g "$f"); sed -i "/^max_connections/d" "$f" && chown "$o" "$f"; done' && docker start bun-jobs-postgres;`,
    );
    expect(out).not.toContain("/tmp");
    const native = postgresNotBackHint(700, ctx({ host: "native" }));
    expect(native).toContain("journalctl -u postgresql");
    expect(native).toContain("postgresql.auto.conf in its data directory");
  });

  it("without --restart-postgres: sets it, prints the notice and the command, restarts nothing", async () => {
    const f = fakes();
    const note = await applyPostgresLimit(raise, ctx(), f.io);
    expect(f.statements).toEqual(["ALTER SYSTEM SET max_connections = 700;"]);
    expect(f.commands).toEqual([]);
    expect(f.waits()).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain(
      "max_connections set to 700; restart Postgres to apply it (it drops open connections)",
    );
    expect(out).toContain("docker restart bun-jobs-postgres");
    expect(note).toBe("max_connections 100, 700 after a restart");
  });

  it("natively, without the flag: ALTER SYSTEM through sudo psql and the systemctl command printed", async () => {
    const f = fakes();
    await applyPostgresLimit(raise, ctx({ host: "native" }), f.io);
    expect(f.commands).toEqual([
      postgresAdminArgv(
        { needsSudo: true, manager: "apt" },
        "ALTER SYSTEM SET max_connections = 700;",
      ),
    ]);
    expect(f.statements).toEqual([]);
    expect(logs.join("\n")).toContain("sudo systemctl restart postgresql");
  });

  it("with --restart-postgres: sets it, restarts, waits, and confirms", async () => {
    const f = fakes();
    const note = await applyPostgresLimit(raise, ctx({ restart: true }), f.io);
    expect(f.statements).toHaveLength(1);
    expect(f.commands).toEqual([["docker", "restart", "bun-jobs-postgres"]]);
    expect(f.waits()).toBe(1);
    expect(f.reads()).toBe(1);
    expect(note).toBe("max_connections 100 → 700");
  });

  it("with the flag, says so when the restart did not apply it", async () => {
    const f = fakes({ current: 100, pendingRestart: true, pendingValue: 700 });
    const note = await applyPostgresLimit(raise, ctx({ restart: true }), f.io);
    expect(note).toContain("restart did not apply it");
    expect(logs.join("\n")).toContain(
      "max_connections is 100 after the restart",
    );
  });

  it("a pending value is not set again; the flag applies it", async () => {
    const pending = planPostgresLimit(
      { current: 100, pendingRestart: true, pendingValue: 700 },
      700,
    );
    const quiet = fakes();
    await applyPostgresLimit(pending, ctx(), quiet.io);
    expect(quiet.statements).toEqual([]);
    expect(quiet.commands).toEqual([]);

    const restart = fakes();
    await applyPostgresLimit(pending, ctx({ restart: true }), restart.io);
    expect(restart.statements).toEqual([]);
    expect(restart.commands).toEqual([
      ["docker", "restart", "bun-jobs-postgres"],
    ]);
  });

  it("a kept value changes nothing, flag or not", async () => {
    const f = fakes();
    const keep = planPostgresLimit(
      { current: 700, pendingRestart: false, pendingValue: null },
      700,
    );
    expect(await applyPostgresLimit(keep, ctx({ restart: true }), f.io)).toBe(
      "max_connections 700",
    );
    expect(f.statements).toEqual([]);
    expect(f.commands).toEqual([]);
  });

  it("a dry run prints the plan and runs nothing, even with the flag", async () => {
    for (const host of ["container", "native"] as const) {
      const f = fakes();
      await applyPostgresLimit(
        raise,
        ctx({ host, dryRun: true, restart: true }),
        f.io,
      );
      expect(f.statements).toEqual([]);
      expect(f.commands).toEqual([]);
      expect(f.waits()).toBe(0);
    }
    expect(logs.join("\n")).toContain(
      "ALTER SYSTEM SET max_connections = 700;",
    );
    expect(logs.join("\n")).toContain("$ docker restart bun-jobs-postgres");
  });

  it("refuses to fight a container whose command line pins a lower value", async () => {
    const f = fakes();
    const note = await applyPostgresLimit(
      raise,
      ctx({ containerPin: 300, restart: true }),
      f.io,
    );
    expect(f.statements).toEqual([]);
    expect(f.commands).toEqual([]);
    expect(note).toContain("pinned by the container's command line");
  });
});

describe("bun-cache's database", () => {
  const options = parseArgs([]);

  it("is bun_cache_test by default, and --cache-database renames it", () => {
    expect(CACHE_DATABASE).toBe("bun_cache_test");
    expect(options.cacheDatabase).toBe("bun_cache_test");
    expect(parseArgs(["--cache-database=other"]).cacheDatabase).toBe("other");
    // bun-jobs' own database is untouched by it.
    expect(parseArgs(["--cache-database=other"]).database).toBe(
      "bun_jobs_test",
    );
  });

  it("lives on the SQL servers, beside bun-jobs': same host, port, user and query, its own database", () => {
    for (const service of ["postgres", "mariadb", "mysql"] as const) {
      const plan = PLANS[service];
      expect(plan.cacheEnvVar).toBe(
        `BUN_CACHE_TEST_${service.toUpperCase()}_URL`,
      );
      const cacheUrl = plan.cacheUrl!(options);
      expect(cacheUrl).toBe(
        plan.url(options).replace("/bun_jobs_test", "/bun_cache_test"),
      );
    }
    // MySQL's needs the same allowPublicKeyRetrieval as bun-jobs'.
    expect(PLANS.mysql.cacheUrl!(options)).toEndWith(
      "/bun_cache_test?allowPublicKeyRetrieval=true",
    );
  });

  it("is on the MongoDB server too, which creates it on first write: no statements", () => {
    expect(PLANS.mongodb.cacheEnvVar).toBe("BUN_CACHE_TEST_MONGODB_URL");
    expect(PLANS.mongodb.cacheUrl!(options)).toBe(
      "mongodb://127.0.0.1:27017/bun_cache_test",
    );
    expect(cacheDatabaseStatements("mongodb", options, "native")).toEqual([]);
  });

  it("is on the MongoDB replica set too, a container of its own on 27018 that bun-jobs has no variable for", () => {
    const plan = PLANS["mongodb-rs"];
    expect(plan.envVar).toBeUndefined();
    expect(plan.cacheEnvVar).toBe("BUN_CACHE_TEST_MONGODB_RS_URL");
    expect(plan.cacheUrl!(options)).toBe(
      "mongodb://127.0.0.1:27018/bun_cache_test?replicaSet=rs0",
    );
    expect(plan.dockerOnly).toBeString();
    expect(plan.port).toBe(27018);
    expect(cacheDatabaseStatements("mongodb-rs", options, "container")).toEqual(
      [],
    );
  });

  it("runs the replica set as mongo:7 with --replSet rs0, published and listening on 27018, with the open-file limit", () => {
    const argv = dockerRunArgv(PLANS["mongodb-rs"].container(options));
    expect(argv).toContain("127.0.0.1:27018:27018");
    expect(argv).toContain(`nofile=65536:65536`);
    expect(argv.slice(argv.indexOf("mongo:7"))).toEqual([
      "mongo:7",
      "--replSet",
      "rs0",
      "--bind_ip_all",
      "--port",
      "27018",
      "--setParameter",
      "enableTestCommands=1",
    ]);
    expect(PLANS["mongodb-rs"].container(options).image).toBe(
      PLANS.mongodb.container(options).image,
    );
  });

  it("initiates rs0 with one member the host can reach, and only when rs.status() fails", () => {
    const argv = mongoRsInitArgv();
    expect(argv.slice(0, 4)).toEqual([
      "docker",
      "exec",
      "bun-cache-mongodb-rs",
      "mongosh",
    ]);
    const script = argv.at(-1)!;
    expect(script).toStartWith("try { rs.status() } catch");
    expect(script).toContain('host: "127.0.0.1:27018"');
    expect(script).toContain('_id: "rs0"');
  });

  it("on Redis is bun-jobs' test database: a variable of its own, nothing to create", () => {
    expect(PLANS.redis.cacheEnvVar).toBe("BUN_CACHE_TEST_REDIS_URL");
    expect(PLANS.redis.cacheUrl).toBeUndefined();
    expect(PLANS.redis.url(options)).toBe("redis://127.0.0.1:6379/15");
  });

  it("is created conditionally, and never dropped", () => {
    const all = [
      ...cacheDatabaseStatements("postgres", options, "native"),
      ...cacheDatabaseStatements("postgres", options, "container"),
      ...cacheDatabaseStatements("mariadb", options, "native"),
      ...cacheDatabaseStatements("mysql", options, "container"),
    ];
    expect(all.some((statement) => /DROP|TRUNCATE/i.test(statement))).toBe(
      false,
    );
    // psql: \gexec over a NOT EXISTS check; over SQL the caller checks
    // pg_database first (CREATE DATABASE has no IF NOT EXISTS).
    expect(cacheDatabaseStatements("postgres", options, "native")).toEqual([
      "SELECT 'CREATE DATABASE bun_cache_test OWNER bunjobs' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'bun_cache_test') \\gexec",
    ]);
    expect(cacheDatabaseStatements("postgres", options, "container")).toEqual([
      "CREATE DATABASE bun_cache_test OWNER bunjobs",
    ]);
    expect(cacheDatabaseStatements("mysql", options, "container")).toEqual([
      "CREATE DATABASE IF NOT EXISTS `bun_cache_test`",
      "GRANT ALL PRIVILEGES ON `bun_cache_test`.* TO 'bunjobs'@'%'",
    ]);
    // A native MariaDB has the 'localhost' user `configure` made, too.
    expect(cacheDatabaseStatements("mariadb", options, "native")).toEqual([
      "CREATE DATABASE IF NOT EXISTS `bun_cache_test`",
      "GRANT ALL PRIVILEGES ON `bun_cache_test`.* TO 'bunjobs'@'%'",
      "GRANT ALL PRIVILEGES ON `bun_cache_test`.* TO 'bunjobs'@'localhost'",
    ]);
    expect(cacheDatabaseStatements("redis", options, "native")).toEqual([]);
  });

  it("--print-env prints the BUN_CACHE_TEST_* variables beside bun-jobs'", async () => {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        new URL("../setup-databases.ts", import.meta.url).pathname,
        "--print-env",
      ],
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    const exports = out
      .split("\n")
      .filter((line) => line.startsWith("export BUN_CACHE_TEST_"));
    expect(exports).toEqual([
      "export BUN_CACHE_TEST_REDIS_URL=redis://127.0.0.1:6379/15",
      "export BUN_CACHE_TEST_POSTGRES_URL=postgres://bunjobs:bunjobs@127.0.0.1:5432/bun_cache_test",
      "export BUN_CACHE_TEST_MARIADB_URL=mariadb://bunjobs:bunjobs@127.0.0.1:3306/bun_cache_test",
      "export BUN_CACHE_TEST_MYSQL_URL=mysql://bunjobs:bunjobs@127.0.0.1:3307/bun_cache_test?allowPublicKeyRetrieval=true",
      "export BUN_CACHE_TEST_MONGODB_URL=mongodb://127.0.0.1:27017/bun_cache_test",
      "export BUN_CACHE_TEST_MONGODB_RS_URL=mongodb://127.0.0.1:27018/bun_cache_test?replicaSet=rs0",
      "export BUN_CACHE_TEST_S3_URL=s3://test:test@127.0.0.1:8333/bun-cache-test?scheme=http",
      `export BUN_CACHE_TEST_AZURE_URL=azure://devstoreaccount1:${encodeURIComponent(AZURE_ACCOUNT_KEY)}@127.0.0.1:10000/devstoreaccount1/bun-cache-test?scheme=http`,
      `export BUN_CACHE_TEST_AZURE_OAUTH_URL=azure://devstoreaccount1:${encodeURIComponent(AZURE_ACCOUNT_KEY)}@127.0.0.1:10100/devstoreaccount1/bun-cache-test`,
    ]);
    expect(out).toContain(
      "export BUN_JOBS_TEST_S3_URL=s3://test:test@127.0.0.1:8333/bun-jobs-test?scheme=http",
    );
  });
});

describe("the S3 server (SeaweedFS)", () => {
  const options = parseArgs([]);

  it("is a pinned SeaweedFS container on 8333, checking signatures, its data in the image's volume", () => {
    const plan = PLANS.s3;
    expect(plan.dockerOnly).toContain("container");
    expect(plan.installed()).toBe(false);
    const spec = plan.container(options);
    expect(spec.image).toBe(S3_CONTAINER_IMAGE);
    expect(S3_CONTAINER_IMAGE).toBe("chrislusf/seaweedfs:4.48");
    const argv = dockerRunArgv(spec);
    expect(argv).toContain("bun-jobs-s3");
    expect(argv).toContain("127.0.0.1:8333:8333");
    expect(argv).toContain("nofile=65536:65536");
    // The credentials by environment make SeaweedFS verify every signature.
    expect(argv).toContain(`AWS_ACCESS_KEY_ID=${S3_ACCESS_KEY}`);
    expect(argv).toContain(`AWS_SECRET_ACCESS_KEY=${S3_SECRET_KEY}`);
    expect(argv.slice(argv.indexOf(spec.image))).toEqual([
      spec.image,
      "server",
      "-s3",
      "-dir=/data",
    ]);
    // Nothing of /tmp, which snap Docker cannot use, and no bind mount.
    expect(argv.some((arg) => arg.includes("/tmp"))).toBe(false);
    expect(argv).not.toContain("--volume");
  });

  it("gives each package its own bucket, in the S3 driver's URL form", () => {
    expect(PLANS.s3.envVar).toBe("BUN_JOBS_TEST_S3_URL");
    expect(PLANS.s3.cacheEnvVar).toBe("BUN_CACHE_TEST_S3_URL");
    expect(PLANS.s3.url(options)).toBe(s3TestUrl(S3_BUCKET));
    expect(PLANS.s3.cacheUrl!(options)).toBe(
      "s3://test:test@127.0.0.1:8333/bun-cache-test?scheme=http",
    );
    expect(S3_CACHE_BUCKET).toBe("bun-cache-test");
    expect(parseS3TestUrl(PLANS.s3.url(options))).toEqual({
      endpoint: "http://127.0.0.1:8333",
      bucket: "bun-jobs-test",
      accessKeyId: "test",
      secretAccessKey: "test",
    });
    // No SQL statements: its bucket is made by a signed request.
    expect(cacheDatabaseStatements("s3", options, "container")).toEqual([]);
  });

  it("makes its bucket in the container's one-time setup, which a dry run only prints", async () => {
    expect(PLANS.s3.initContainer).toBeFunction();
    const fetched = spyOn(globalThis, "fetch");
    try {
      expect(await PLANS.s3.initContainer!(parseArgs(["--dry-run"]))).toBe(
        true,
      );
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      fetched.mockRestore();
    }
    expect(parseArgs(["--only=s3"]).services).toEqual(["s3"]);
  });

  it("signs the bucket requests with SigV4: AWS's published GET Bucket example", () => {
    const headers = signS3(
      {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
      "GET",
      new URL("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J"),
      new Date("2013-05-24T00:00:00Z"),
      "us-east-1",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    );
  });

  it("takes a bucket that is already ours as created, and nothing else", () => {
    expect(bucketCreated(200, "")).toBe(true);
    expect(
      bucketCreated(409, "<Error><Code>BucketAlreadyOwnedByYou</Code></Error>"),
    ).toBe(true);
    // Somebody else's bucket of that name is not ours to use.
    expect(
      bucketCreated(409, "<Error><Code>BucketAlreadyExists</Code></Error>"),
    ).toBe(false);
    expect(bucketCreated(403, "")).toBe(false);
  });
});

describe("the Azure Blob Storage server (Azurite)", () => {
  const options = parseArgs([]);

  it("is a pinned Azurite container on 10000, blob service only, its data in the image's volume", () => {
    const plan = PLANS.azure;
    expect(plan.dockerOnly).toContain("container");
    expect(plan.installed()).toBe(false);
    const spec = plan.container(options);
    expect(spec.image).toBe(AZURE_CONTAINER_IMAGE);
    expect(AZURE_CONTAINER_IMAGE).toBe(
      "mcr.microsoft.com/azure-storage/azurite:3.37.0",
    );
    const argv = dockerRunArgv(spec);
    expect(argv).toContain("bun-cache-azurite");
    expect(argv).toContain("127.0.0.1:10000:10000");
    expect(argv).toContain("nofile=65536:65536");
    expect(argv.slice(argv.indexOf(spec.image))).toEqual([
      spec.image,
      "azurite-blob",
      "--blobHost",
      "0.0.0.0",
      "--blobPort",
      "10000",
      "--location",
      "/data",
    ]);
    // Nothing of /tmp, which snap Docker cannot use, and no bind mount.
    expect(argv.some((arg) => arg.includes("/tmp"))).toBe(false);
    expect(argv).not.toContain("--volume");
  });

  it("is bun-cache's alone, printed in the driver's URL form with the published development account", () => {
    expect(PLANS.azure.envVar).toBeUndefined();
    expect(PLANS.azure.cacheEnvVar).toBe("BUN_CACHE_TEST_AZURE_URL");
    expect(PLANS.azure.cacheUrl).toBeUndefined();
    expect(PLANS.azure.url(options)).toBe(azureTestUrl(AZURE_CACHE_CONTAINER));
    expect(AZURE_CACHE_CONTAINER).toBe("bun-cache-test");
    expect(AZURE_ACCOUNT).toBe("devstoreaccount1");
    expect(parseAzureTestUrl(PLANS.azure.url(options))).toEqual({
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "bun-cache-test",
      account: "devstoreaccount1",
      key: AZURE_ACCOUNT_KEY,
    });
    expect(cacheDatabaseStatements("azure", options, "container")).toEqual([]);
    expect(parseArgs(["--only=azure"]).services).toEqual(["azure"]);
  });

  it("makes its blob container in the container's one-time setup, which a dry run only prints", async () => {
    expect(PLANS.azure.initContainer).toBeFunction();
    const fetched = spyOn(globalThis, "fetch");
    try {
      expect(await PLANS.azure.initContainer!(parseArgs(["--dry-run"]))).toBe(
        true,
      );
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      fetched.mockRestore();
    }
  });

  it("signs with Shared Key: the documented string to sign, path-style, under the base64-decoded key", () => {
    const url = new URL(
      "http://127.0.0.1:10000/devstoreaccount1/bun-cache-test?restype=container",
    );
    const headers = signAzure(
      { account: AZURE_ACCOUNT, key: AZURE_ACCOUNT_KEY },
      "PUT",
      url,
      new Date("2026-10-28T12:00:00Z"),
    );
    // Verb, eleven empty standard headers, the x-ms-* ones, then the
    // resource with the account twice (the emulator's path style).
    const stringToSign =
      "PUT\n\n\n\n\n\n\n\n\n\n\n\n" +
      "x-ms-date:Wed, 28 Oct 2026 12:00:00 GMT\nx-ms-version:2025-01-05\n" +
      "/devstoreaccount1/devstoreaccount1/bun-cache-test\nrestype:container";
    const expected = createHmac(
      "sha256",
      Buffer.from(AZURE_ACCOUNT_KEY, "base64"),
    )
      .update(stringToSign)
      .digest("base64");
    expect(headers).toEqual({
      "x-ms-date": "Wed, 28 Oct 2026 12:00:00 GMT",
      "x-ms-version": "2025-01-05",
      authorization: `SharedKey devstoreaccount1:${expected}`,
    });
  });

  it("takes a blob container that already exists as created, and nothing else", () => {
    expect(azureContainerCreated(201, "")).toBe(true);
    expect(
      azureContainerCreated(
        409,
        "<Error><Code>ContainerAlreadyExists</Code></Error>",
      ),
    ).toBe(true);
    expect(
      azureContainerCreated(
        409,
        "<Error><Code>ContainerBeingDeleted</Code></Error>",
      ),
    ).toBe(false);
    expect(azureContainerCreated(403, "")).toBe(false);
  });
});

describe("the Entra ID Azure server (Azurite with --oauth basic)", () => {
  const options = parseArgs([]);

  it("is a second pinned Azurite on 10100, HTTPS with --oauth basic, beside the Shared Key one", () => {
    const plan = PLANS["azure-oauth"];
    expect(plan.dockerOnly).toContain("container");
    expect(plan.installed()).toBe(false);
    expect(plan.port).toBe(10_100);
    expect(AZURE_OAUTH_PORT).toBe(10_100);
    const spec = plan.container(options);
    expect(spec.name).toBe(AZURE_OAUTH_CONTAINER);
    expect(spec.name).not.toBe(PLANS.azure.container(options).name);
    expect(spec.image).toBe(AZURE_CONTAINER_IMAGE);
    const argv = dockerRunArgv(spec);
    expect(argv).toContain("127.0.0.1:10100:10000");
    expect(argv).toContain("nofile=65536:65536");
    expect(argv.slice(argv.indexOf(spec.image))).toEqual([
      spec.image,
      "azurite-blob",
      "--blobHost",
      "0.0.0.0",
      "--blobPort",
      "10000",
      "--location",
      "/data",
      "--oauth",
      "basic",
      "--cert",
      "/certs/cert.pem",
      "--key",
      "/certs/key.pem",
    ]);
    // The certificate is copied in, never bind-mounted.
    expect(argv).not.toContain("--volume");
    expect(spec.copyIn).toEqual({ from: azureOauthCertDir(), to: "/" });
    expect(plan.prepareContainer).toBeFunction();
  });

  it("negative control: the Shared Key Azurite has neither --oauth nor a certificate", () => {
    const argv = dockerRunArgv(PLANS.azure.container(options));
    expect(argv).not.toContain("--oauth");
    expect(argv).not.toContain("--cert");
    expect(PLANS.azure.container(options).copyIn).toBeUndefined();
  });

  it("creates then copies then starts: docker create is docker run without the start", () => {
    const spec = PLANS["azure-oauth"].container(options);
    const create = dockerCreateArgv(spec);
    const run = dockerRunArgv(spec);
    expect(create.slice(0, 2)).toEqual(["docker", "create"]);
    expect(create).not.toContain("--detach");
    expect(create.slice(2)).toEqual(run.slice(3));
    expect(run.slice(0, 4)).toEqual(["docker", "run", "--detach", "--name"]);
    expect(create).toContain(spec.name);
  });

  it("keeps its certificate outside the repository and outside dot-directories", () => {
    const dir = azureOauthCertDir({}, "/src/mine/bun-node");
    expect(dir).toBe("/src/mine/_scratch/bun-node/test-certs/azure-oauth");
    expect(
      azureOauthCertDir(
        { BUN_NODE_TEST_CERTS: "/srv/c" },
        "/src/mine/bun-node",
      ),
    ).toBe("/srv/c/azure-oauth");
    const repo = new URL("../..", import.meta.url).pathname;
    const real = azureOauthCertDir();
    expect(real.startsWith(repo)).toBe(false);
    expect(real.split("/").some((part) => part.startsWith("."))).toBe(false);
  });

  it("makes a self-signed certificate for 127.0.0.1 and localhost with openssl", () => {
    const argv = azureOauthCertArgv("/d");
    expect(argv.slice(0, 3)).toEqual(["openssl", "req", "-x509"]);
    expect(argv).toContain("/d/certs/key.pem");
    expect(argv).toContain("/d/certs/cert.pem");
    expect(argv).toContain("subjectAltName=IP:127.0.0.1,DNS:localhost");
  });

  it("is bun-cache's alone, printed in the HTTPS form (no scheme parameter) the Entra ID lane reads", () => {
    const plan = PLANS["azure-oauth"];
    expect(plan.envVar).toBeUndefined();
    expect(plan.cacheEnvVar).toBe("BUN_CACHE_TEST_AZURE_OAUTH_URL");
    expect(plan.url(options)).toBe(azureTestUrl(AZURE_CACHE_CONTAINER, true));
    expect(parseAzureTestUrl(plan.url(options))).toEqual({
      endpoint: "https://127.0.0.1:10100/devstoreaccount1",
      container: "bun-cache-test",
      account: "devstoreaccount1",
      key: AZURE_ACCOUNT_KEY,
    });
    // Negative control: the Shared Key URL is plain HTTP on 10000.
    expect(parseAzureTestUrl(PLANS.azure.url(options)).endpoint).toBe(
      "http://127.0.0.1:10000/devstoreaccount1",
    );
    expect(parseArgs(["--only=azure-oauth"]).services).toEqual(["azure-oauth"]);
    expect(parseArgs([]).services).toContain("azure-oauth");
  });

  it("a dry run of its one-time setup fetches nothing", async () => {
    const fetched = spyOn(globalThis, "fetch");
    try {
      expect(
        await PLANS["azure-oauth"].initContainer!(parseArgs(["--dry-run"])),
      ).toBe(true);
      expect(
        await PLANS["azure-oauth"].prepareContainer!(parseArgs(["--dry-run"])),
      ).toBe(true);
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      fetched.mockRestore();
    }
  });
});

describe("bun-cache's benchmark database", () => {
  const options = parseArgs([]);

  it("is bun_cache_bench by default, and --cache-bench-database renames it, leaving the others", () => {
    expect(CACHE_BENCH_DATABASE).toBe("bun_cache_bench");
    expect(options.cacheBenchDatabase).toBe("bun_cache_bench");
    const renamed = parseArgs(["--cache-bench-database=other"]);
    expect(renamed.cacheBenchDatabase).toBe("other");
    expect(renamed.cacheDatabase).toBe("bun_cache_test");
    expect(renamed.database).toBe("bun_jobs_test");
  });

  it("has a URL on every server that has the test database's, in its form, under BUN_CACHE_BENCH_*_URL", () => {
    for (const service of [
      "postgres",
      "mariadb",
      "mysql",
      "mongodb",
    ] as const) {
      const plan = PLANS[service];
      expect(plan.cacheBenchEnvVar).toBe(
        `BUN_CACHE_BENCH_${service.toUpperCase()}_URL`,
      );
      expect(plan.cacheBenchUrl!(options)).toBe(
        plan.cacheUrl!(options).replace("/bun_cache_test", "/bun_cache_bench"),
      );
    }
    expect(PLANS.mysql.cacheBenchUrl!(options)).toEndWith(
      "/bun_cache_bench?allowPublicKeyRetrieval=true",
    );
    // Redis: database 12, nothing to create.
    expect(PLANS.redis.cacheBenchEnvVar).toBe("BUN_CACHE_BENCH_REDIS_URL");
    expect(PLANS.redis.cacheBenchUrl!(options)).toBe(
      "redis://127.0.0.1:6379/12",
    );
    expect(PLANS["mongodb-rs"].cacheBenchUrl).toBeUndefined();
  });

  it("is created and granted to the suites' user by the same conditional statements, never dropped", () => {
    const bench = { ...options, cacheDatabase: options.cacheBenchDatabase };
    expect(cacheDatabaseStatements("postgres", bench, "native")).toEqual([
      "SELECT 'CREATE DATABASE bun_cache_bench OWNER bunjobs' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'bun_cache_bench') \\gexec",
    ]);
    expect(cacheDatabaseStatements("mysql", bench, "container")).toEqual([
      "CREATE DATABASE IF NOT EXISTS `bun_cache_bench`",
      "GRANT ALL PRIVILEGES ON `bun_cache_bench`.* TO 'bunjobs'@'%'",
    ]);
  });

  it("--print-env prints the BUN_CACHE_BENCH_* variables", async () => {
    const run = async (...args: string[]): Promise<string> => {
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          new URL("../setup-databases.ts", import.meta.url).pathname,
          ...args,
        ],
        env: { ...process.env, NO_COLOR: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(child.stdout).text();
      await child.exited;
      return out;
    };
    const env = await run("--print-env");
    expect(
      env
        .split("\n")
        .filter((line) => line.startsWith("export BUN_CACHE_BENCH_")),
    ).toEqual([
      "export BUN_CACHE_BENCH_REDIS_URL=redis://127.0.0.1:6379/12",
      "export BUN_CACHE_BENCH_POSTGRES_URL=postgres://bunjobs:bunjobs@127.0.0.1:5432/bun_cache_bench",
      "export BUN_CACHE_BENCH_MARIADB_URL=mariadb://bunjobs:bunjobs@127.0.0.1:3306/bun_cache_bench",
      "export BUN_CACHE_BENCH_MYSQL_URL=mysql://bunjobs:bunjobs@127.0.0.1:3307/bun_cache_bench?allowPublicKeyRetrieval=true",
      "export BUN_CACHE_BENCH_MONGODB_URL=mongodb://127.0.0.1:27017/bun_cache_bench",
    ]);
  });
});

describe("--recreate", () => {
  /** The options a run with `argv` would use. */
  const options = (...argv: string[]) =>
    parseArgs([
      "--max-connections=1000",
      "--postgres-max-connections=700",
      ...argv,
    ]);
  const mysql = PLANS.mysql.container(options());
  /** The open-file limit every container is created with. */
  const nofile = [{ Name: "nofile", Soft: 65_536, Hard: 65_536 }];

  it("is off by default, and the flag turns it on", () => {
    expect(parseArgs([]).recreate).toBe(false);
    expect(parseArgs(["--recreate"]).recreate).toBe(true);
  });

  describe("drift: a spec against an inspected container", () => {
    it("finds MySQL created without --max-connections (this machine's bun-jobs-mysql)", () => {
      const drift = containerDrift(mysql, { cmd: ["mysqld"], ulimits: nofile });
      expect(drift.map((item) => item.setting)).toEqual(["max-connections"]);
      expect(drift[0]?.message).toContain("without --max-connections");
      expect(drift[0]?.message).toContain("--max-connections=1000");
    });

    it("negative control: a container created with the spec's arguments has none", () => {
      expect(
        containerDrift(mysql, {
          cmd: ["--max-connections=1000"],
          ulimits: nofile,
        }),
      ).toEqual([]);
    });

    it("counts a pin below the target, never one at or above it", () => {
      const below = containerDrift(mysql, {
        cmd: ["--max-connections=500"],
        ulimits: nofile,
      });
      expect(below[0]?.message).toContain("with --max-connections=500");
      for (const cmd of [
        ["--max-connections=2000"],
        ["--max_connections=1000"],
      ]) {
        expect(containerDrift(mysql, { cmd, ulimits: nofile })).toEqual([]);
      }
    });

    it("finds a missing or low open-file limit, on any container", () => {
      const redis = PLANS.redis.container(options());
      expect(
        containerDrift(redis, { cmd: null, ulimits: null }).map(
          (item) => item.setting,
        ),
      ).toEqual(["nofile"]);
      const low = containerDrift(redis, {
        cmd: null,
        ulimits: [{ Name: "nofile", Soft: 1024, Hard: 1024 }],
      });
      expect(low[0]?.message).toContain("open-file limit of 1024");
      // Negative control: the limit it is created with.
      expect(containerDrift(redis, { cmd: null, ulimits: nofile })).toEqual([]);
    });

    it("reports both when both are behind", () => {
      expect(
        containerDrift(mysql, { cmd: ["mysqld"], ulimits: null }).map(
          (item) => item.setting,
        ),
      ).toEqual(["nofile", "max-connections"]);
    });

    it("on Postgres, counts only a pin below the target: ALTER SYSTEM keeps an unpinned value", () => {
      const postgres = PLANS.postgres.container(options());
      expect(
        containerDrift(postgres, { cmd: ["postgres"], ulimits: nofile }),
      ).toEqual([]);
      const pinned = containerDrift(postgres, {
        cmd: ["postgres", "-c", "max_connections=100"],
        ulimits: nofile,
      });
      expect(pinned.map((item) => item.setting)).toEqual(["max-connections"]);
      expect(pinned[0]?.message).toContain("-c max_connections=100");
      // Negative control: the spec's own pin.
      expect(
        containerDrift(postgres, {
          cmd: ["-c", "max_connections=700"],
          ulimits: nofile,
        }),
      ).toEqual([]);
    });

    it("reads docker inspect's line, and nothing else", () => {
      const line =
        '["b64c52d6f0fd","mysql:8.4",["mysqld"],[{"Hard":65536,"Name":"nofile","Soft":65536}]]\n';
      expect(parseInspected(line)).toEqual({
        id: "b64c52d6f0fd",
        image: "mysql:8.4",
        cmd: ["mysqld"],
        ulimits: [{ Hard: 65_536, Name: "nofile", Soft: 65_536 }],
      });
      expect(parseInspected('["x","mongo:7",null,null]')).toEqual({
        id: "x",
        image: "mongo:7",
        cmd: null,
        ulimits: null,
      });
      expect(parseInspected("")).toBeNull();
      expect(parseInspected("Error: No such container")).toBeNull();
      expect(parseInspected("[1,2,3,4]")).toBeNull();
      expect(INSPECT_FORMAT).toContain("{{json .Config.Cmd}}");
    });

    it("refuses another image, and a container with files copied in", () => {
      expect(recreateBlocker(mysql, { image: "mysql:8.4" })).toBeNull();
      expect(recreateBlocker(mysql, { image: "mysql:8.0" })).toContain(
        "mysql:8.0",
      );
      expect(
        recreateBlocker(PLANS["azure-oauth"].container(options()), {
          image: AZURE_CONTAINER_IMAGE,
        }),
      ).toContain("copied into it");
    });
  });

  describe("the commands", () => {
    it("stops, renames to -prev, runs the spec with --volumes-from -prev, and removes -prev without -v", () => {
      const argv = recreateArgv(mysql);
      const prev = `bun-jobs-mysql${RECREATE_SUFFIX}`;
      expect(prev).toBe("bun-jobs-mysql-prev");
      expect(argv.stop).toEqual([
        "docker",
        "stop",
        "--time",
        String(RECREATE_STOP_SECONDS),
        "bun-jobs-mysql",
      ]);
      expect(argv.rename).toEqual(["docker", "rename", "bun-jobs-mysql", prev]);
      expect(argv.remove).toEqual(["docker", "rm", prev]);

      // The same container as a fresh one, under the same name, with the old
      // one's volumes: the same ports, limit, environment and arguments.
      const run = argv.run;
      const at = run.indexOf("--volumes-from");
      expect(run[at + 1]).toBe(prev);
      expect(at).toBeLessThan(run.indexOf(mysql.image));
      expect(run.toSpliced(at, 2)).toEqual(dockerRunArgv(mysql));
      expect(run.slice(3, 5)).toEqual(["--name", "bun-jobs-mysql"]);
      expect(run).toContain("127.0.0.1:3307:3306");
      expect(run).toContain("nofile=65536:65536");
      expect(run.at(-1)).toBe("--max-connections=1000");
    });

    it("negative control: a fresh container mounts no other container's volumes", () => {
      expect(dockerRunArgv(mysql)).not.toContain("--volumes-from");
    });
  });

  describe("recreateContainer", () => {
    let logs: string[];
    let spy: ReturnType<typeof spyOn<Console, "log">>;

    beforeEach(() => {
      logs = [];
      spy = spyOn(console, "log").mockImplementation((line: unknown) => {
        logs.push(String(line));
      });
    });
    afterEach(() => spy.mockRestore());

    const OLD = "old0000";
    const NEW = "new1111";

    /**
     * A fake Docker holding containers by name, through the script's command
     * seam. `fail` makes a command fail; a `run` that `createsOnFailure` still
     * leaves the container behind, as a start failure does.
     */
    const fakeDocker = (
      setup: {
        fail?: (argv: string[]) => boolean;
        createsOnFailure?: boolean;
        prevExists?: boolean;
        /** `docker rename` answers success and renames nothing. */
        renameLies?: boolean;
        ready?: boolean[];
        problem?: string | null;
      } = {},
    ) => {
      const containers = new Map<string, string>([["bun-jobs-mysql", OLD]]);
      if (setup.prevExists) {
        containers.set("bun-jobs-mysql-prev", "stale99");
      }
      const calls: string[][] = [];
      const ready = [...(setup.ready ?? [true, true])];
      let waits = 0;
      let verifies = 0;
      const answer = (ok: boolean, stdout = "") => ({
        code: ok ? 0 : 1,
        stdout,
        stderr: ok ? "" : "simulated failure",
        ok,
      });
      const runner: Runner = async (argv) => {
        calls.push(argv);
        const [, verb] = argv;
        if (verb === "ps") {
          const name = /\^\/(.+)\$/.exec(argv[4] ?? "")?.[1] ?? "";
          return answer(true, containers.has(name) ? "running\n" : "");
        }
        if (verb === "container") {
          const id = containers.get(argv.at(-1) ?? "");
          const inspected: Omit<InspectedContainer, "id"> = {
            image: "mysql:8.4",
            cmd: ["mysqld"],
            ulimits: null,
          };
          return id
            ? answer(
                true,
                JSON.stringify([
                  id,
                  inspected.image,
                  inspected.cmd,
                  inspected.ulimits,
                ]),
              )
            : answer(false);
        }
        const failed = setup.fail?.(argv) ?? false;
        if (verb === "run") {
          if (!failed || setup.createsOnFailure) {
            containers.set(argv[4] ?? "", NEW);
          }
          return answer(!failed);
        }
        if (failed) {
          return answer(false);
        }
        if (verb === "rename" && setup.renameLies) {
          return answer(true);
        }
        if (verb === "rename") {
          const id = containers.get(argv[2] ?? "");
          if (!id) {
            return answer(false);
          }
          containers.delete(argv[2] ?? "");
          containers.set(argv[3] ?? "", id);
        } else if (verb === "rm") {
          const target = argv.at(-1) ?? "";
          for (const [name, id] of containers) {
            if (name === target || id === target) {
              containers.delete(name);
            }
          }
        }
        return answer(true);
      };
      const io: RecreateIo = {
        runner,
        waitReady: async () => {
          waits++;
          return ready.shift() ?? true;
        },
        verify: async () => {
          verifies++;
          return setup.problem ?? null;
        },
      };
      /** The commands that change something: no ps, no inspect. */
      const changes = () =>
        calls.filter(([, verb]) => verb !== "ps" && verb !== "container");
      return {
        io,
        containers,
        calls,
        changes,
        waits: () => waits,
        verifies: () => verifies,
      };
    };
    const argv = recreateArgv(mysql);
    /** Whether any command removed a volume, or the old container. */
    const destroyedData = (calls: string[][]) =>
      calls.some(
        (call) =>
          call.includes("-v") ||
          call.includes("--volumes") ||
          (call[1] === "rm" && call.includes(OLD)),
      );

    it("a dry run prints every command, and the rollback, and runs none", async () => {
      const f = fakeDocker();
      const result = await recreateContainer(mysql, true, f.io);
      expect(result.outcome).toBe("planned");
      expect(f.calls).toEqual([]);
      const printed = logs.join("\n");
      for (const command of [argv.stop, argv.rename, argv.run, argv.remove]) {
        expect(printed).toContain(`$ ${command.join(" ")}`);
      }
      expect(printed).toContain("--volumes-from bun-jobs-mysql-prev");
      expect(printed).toContain(
        "docker rename bun-jobs-mysql-prev bun-jobs-mysql; docker start bun-jobs-mysql",
      );
    });

    it("recreates: stop, rename, run, wait, verify, and only then remove -prev", async () => {
      const f = fakeDocker();
      const result = await recreateContainer(mysql, false, f.io);
      expect(result.outcome).toBe("recreated");
      expect(f.changes()).toEqual([
        argv.stop,
        argv.rename,
        argv.run,
        argv.remove,
      ]);
      expect(f.waits()).toBe(1);
      expect(f.verifies()).toBe(1);
      expect([...f.containers]).toEqual([["bun-jobs-mysql", NEW]]);
      expect(destroyedData(f.calls)).toBe(false);
    });

    it("rolls back when the new container fails its check: removes the new one by id, renames -prev back, starts it", async () => {
      const f = fakeDocker({ problem: "bun_cache_test no longer connects" });
      const result = await recreateContainer(mysql, false, f.io);
      expect(result.outcome).toBe("rolled-back");
      expect(result.note).toContain("bun_cache_test no longer connects");
      expect(f.changes()).toEqual([
        argv.stop,
        argv.rename,
        argv.run,
        ["docker", "rm", "--force", NEW],
        ["docker", "rename", "bun-jobs-mysql-prev", "bun-jobs-mysql"],
        ["docker", "start", "bun-jobs-mysql"],
      ]);
      // The new one waited for, then the old one once it was back.
      expect(f.waits()).toBe(2);
      expect([...f.containers]).toEqual([["bun-jobs-mysql", OLD]]);
      expect(destroyedData(f.calls)).toBe(false);
    });

    it("negative control: the data check would catch a rollback that removed the old container", () => {
      expect(destroyedData([["docker", "rm", "--force", OLD]])).toBe(true);
      expect(destroyedData([["docker", "rm", "-v", "x"]])).toBe(true);
    });

    it("rolls back when the new container never accepts the credentials", async () => {
      const f = fakeDocker({ ready: [false, true] });
      const result = await recreateContainer(mysql, false, f.io);
      expect(result.outcome).toBe("rolled-back");
      expect(f.verifies()).toBe(0);
      expect([...f.containers]).toEqual([["bun-jobs-mysql", OLD]]);
    });

    it("rolls back a failing start: a run that made the container removes it; one that made none removes nothing", async () => {
      const made = fakeDocker({
        fail: (call) => call[1] === "run",
        createsOnFailure: true,
      });
      expect((await recreateContainer(mysql, false, made.io)).outcome).toBe(
        "rolled-back",
      );
      expect(made.changes()).toContainEqual(["docker", "rm", "--force", NEW]);
      expect([...made.containers]).toEqual([["bun-jobs-mysql", OLD]]);

      const none = fakeDocker({ fail: (call) => call[1] === "run" });
      expect((await recreateContainer(mysql, false, none.io)).outcome).toBe(
        "rolled-back",
      );
      expect(none.changes().some((call) => call[1] === "rm")).toBe(false);
      expect([...none.containers]).toEqual([["bun-jobs-mysql", OLD]]);
      expect(destroyedData(made.calls) || destroyedData(none.calls)).toBe(
        false,
      );
    });

    it("a failed stop renames nothing and starts the old container again", async () => {
      const f = fakeDocker({ fail: (call) => call[1] === "stop" });
      const result = await recreateContainer(mysql, false, f.io);
      expect(result.outcome).toBe("rolled-back");
      expect(f.changes()).toEqual([
        argv.stop,
        ["docker", "start", "bun-jobs-mysql"],
      ]);
    });

    it("says so when the old container does not come back, naming where its data is", async () => {
      const f = fakeDocker({ ready: [false, false] });
      const result = await recreateContainer(mysql, false, f.io);
      expect(result.outcome).toBe("rollback-failed");
      expect(logs.join("\n")).toContain("did not come back");
    });

    it("leaves -prev in place when renaming it back fails, and says how to finish", async () => {
      const f = fakeDocker({
        problem: "max_connections is 151, not 1000",
        fail: (call) =>
          call[1] === "rename" && call[2] === "bun-jobs-mysql-prev",
      });
      const result = await recreateContainer(mysql, false, f.io);
      expect(result.outcome).toBe("rollback-failed");
      expect(f.containers.get("bun-jobs-mysql-prev")).toBe(OLD);
      expect(logs.join("\n")).toContain(
        "docker rename bun-jobs-mysql-prev bun-jobs-mysql && docker start bun-jobs-mysql",
      );
    });

    it("never removes the old container, even after a rename that said it worked and did not", async () => {
      const f = fakeDocker({
        renameLies: true,
        // The name is still taken, so the new container cannot be made.
        fail: (call) => call[1] === "run",
      });
      await recreateContainer(mysql, false, f.io);
      expect(f.containers.get("bun-jobs-mysql")).toBe(OLD);
      expect(destroyedData(f.calls)).toBe(false);
    });

    it("refuses to start when an earlier recreate left a -prev, changing nothing", async () => {
      const f = fakeDocker({ prevExists: true });
      const result = await recreateContainer(mysql, false, f.io);
      expect(result.outcome).toBe("refused");
      expect(f.changes()).toEqual([]);
      expect(f.containers.get("bun-jobs-mysql-prev")).toBe("stale99");
    });

    it("keeps the new container when only removing -prev fails, and says so", async () => {
      const f = fakeDocker({
        fail: (call) => call[1] === "rm",
      });
      const result = await recreateContainer(mysql, false, f.io);
      expect(result.outcome).toBe("recreated");
      expect(result.note).toContain("left to remove");
      expect(f.containers.get("bun-jobs-mysql")).toBe(NEW);
      expect(f.containers.get("bun-jobs-mysql-prev")).toBe(OLD);
    });
  });
});
