import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/**
 * A fake container engine on `PATH`, for the `container` target's tests: a
 * `docker` shim that runs `fixtures/container/fake-engine.ts` against a state
 * directory of its own. See that file for what it answers and how a test
 * steers it.
 */

/** The fake engine's script. */
const ENGINE = join(
  import.meta.dir,
  "..",
  "fixtures",
  "container",
  "fake-engine.ts",
);

/** What the fake engine's `config.json` may say. */
export interface FakeEngineConfig {
  /** `docker version` fails, as with no daemon. */
  versionFails?: boolean;
  /** The runtimes `docker info` lists. Defaults to `["runc"]`. */
  runtimes?: string[];
  /** The images present. */
  images?: string[];
  /** `docker pull` fails. */
  pullFails?: boolean;
  /** The probe container exits with this code and stderr. */
  probeFails?: { code: number; stderr: string };
  /** Every attempt's `docker run` fails with this code and stderr. */
  runFails?: { code: number; stderr: string };
  /** How long a `run` takes before its container exists, in ms. */
  createDelayMs?: number;
  /** What a killed container's `run` exits with instead of 137; `"signal"` dies of SIGKILL. */
  killedExit?: number | "signal";
  /** How long `run` stays up after its container has exited, in ms. */
  exitDelayMs?: number;
  /** How long `kill` and `rm` take to return after doing their work, in ms. */
  commandExitDelayMs?: number;
}

/** One recorded CLI call. */
export interface FakeEngineCall {
  /** The argv after the CLI's name. */
  args: string[];
  /** The environment the CLI was run with. */
  env: Record<string, string>;
  /** When, in epoch ms. */
  at: number;
}

/** A fake engine installed on `PATH` for one test. */
export interface FakeEngine {
  /** Its state directory. */
  dir: string;
  /** Rewrites its config. */
  configure: (config: FakeEngineConfig) => void;
  /** Every call so far. */
  calls: () => FakeEngineCall[];
  /** The calls whose first argument is `command`. */
  callsOf: (command: string) => FakeEngineCall[];
  /** Adds a container record, as one a crashed worker left. */
  addContainer: (container: {
    name: string;
    labels: Record<string, string>;
    created: number;
  }) => void;
  /** The names of the containers that exist now. */
  containers: () => string[];
  /** Takes it off `PATH` and deletes its state. */
  uninstall: () => void;
}

/**
 * Installs a fake `docker` at the front of `PATH` — the live `process.env`,
 * which is what the target builds the CLI's environment from — and returns
 * its handle. Call `uninstall()` after the test.
 */
export function installFakeEngine(config: FakeEngineConfig = {}): FakeEngine {
  const dir = mkdtempSync(join(tmpdir(), "bun-jobs-fake-engine-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, "containers"));
  const shim = join(bin, "docker");
  writeFileSync(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${ENGINE}" "${dir}" "$@"\n`,
  );
  chmodSync(shim, 0o755);
  const configure = (next: FakeEngineConfig) =>
    writeFileSync(join(dir, "config.json"), JSON.stringify(next));
  configure(config);

  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous ?? ""}`;

  const calls = (): FakeEngineCall[] =>
    existsSync(join(dir, "calls.jsonl"))
      ? readFileSync(join(dir, "calls.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as FakeEngineCall)
      : [];

  return {
    dir,
    configure,
    calls,
    callsOf: (command) => calls().filter((call) => call.args[0] === command),
    addContainer: (container) =>
      writeFileSync(
        join(dir, "containers", `${container.name}.json`),
        JSON.stringify(container),
      ),
    containers: () =>
      readdirSync(join(dir, "containers"))
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -5)),
    uninstall: () => {
      process.env.PATH = previous;
      // A container still running belongs to this test alone: kill it by
      // the pid its record holds, never by a pattern.
      for (const file of existsSync(join(dir, "containers"))
        ? readdirSync(join(dir, "containers")).filter((name) =>
            name.endsWith(".json"),
          )
        : []) {
        try {
          const { pid } = JSON.parse(
            readFileSync(join(dir, "containers", file), "utf8"),
          ) as { pid?: number };
          if (pid !== undefined) {
            process.kill(pid, "SIGKILL");
          }
        } catch {
          // Gone already.
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
