import type { Runner } from "../setup-databases";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  describeLimit,
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
  PLANS,
  runLimitSteps,
  UsageError,
} from "../setup-databases";

// Importing the script must not provision anything: it runs `main` only under
// `import.meta.main`. These tests reach no database, no sudo and no Docker.

describe("--max-connections", () => {
  it("defaults to the measured 1000 when absent", () => {
    // About 180 connections per server for one 16-worker parallel run, so
    // 1000 leaves room for several runs and the servers' other users.
    expect(MAX_CONNECTIONS).toBe(1000);
    expect(parseArgs([]).maxConnections).toBe(MAX_CONNECTIONS);
    expect(parseArgs(["--dry-run", "--docker"]).maxConnections).toBe(
      MAX_CONNECTIONS,
    );
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
    expect(argv.at(-1)).toBe(`--max-connections=${MAX_CONNECTIONS}`);
  });

  it.each(["redis", "postgres", "mongodb"] as const)(
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

  it("only MariaDB and MySQL have their limit managed", () => {
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
