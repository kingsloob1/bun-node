import type {
  PostgresLimitContext,
  PostgresLimitIo,
  PostgresLimitState,
  Runner,
} from "../setup-databases";
import { availableParallelism } from "node:os";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  applyPostgresLimit,
  BASELINE_CORES,
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
