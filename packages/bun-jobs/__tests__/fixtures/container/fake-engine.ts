/* eslint-disable no-console -- a CLI stand-in: its output is its product */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";

/**
 * A stand-in for the Docker CLI, for tests: the commands the `container`
 * target runs, answered from a state directory instead of a daemon.
 *
 * Run as `bun fake-engine.ts <state dir> <docker args…>`, through a `docker`
 * shim on `PATH` that the test writes (`helpers/fakeEngine.ts`). Every call is
 * appended to `<state>/calls.jsonl` with its argv and **its environment**, so
 * a test can see what reached the CLI. A "container" is a local `bun` process
 * running the exact command the target asked for, with only the `--env`
 * values it was given (and `PATH`): it inherits this process's stdio, so the
 * worker talks to it as it would to `docker run --interactive`.
 *
 * `<state>/config.json` steers it: `versionFails`, `runtimes`, `images`,
 * `pullFails`, `probeFails` ({ code, stderr }), `createDelayMs` (how long a
 * `run` waits before its container exists, which is when `rm` can find it),
 * `runFails` ({ code, stderr }), `killedExit` (what a killed container's
 * `run` exits with instead of 137: a code, or `"signal"` to die of SIGKILL
 * itself, as a CLI that is killed would), and `exitDelayMs` (how long `run`
 * stays up after its container has exited), and `commandExitDelayMs` (how
 * long `kill` and `rm` take to return after doing their work), and
 * `destroyDelayMs` (how long a container whose process has ended stays
 * listed before the engine destroys it and `run` returns), `killDelayMs`
 * (how long `kill` and `rm` wait before acting), and `missingLabelText` (what
 * `inspect` prints for a label a container lacks: Docker's own templates
 * print `<no value>` there). `flood <bytes>` writes that many bytes to stdout.
 */

interface Config {
  versionFails?: boolean;
  runtimes?: string[];
  images?: string[];
  pullFails?: boolean;
  probeFails?: { code: number; stderr: string };
  runFails?: { code: number; stderr: string };
  createDelayMs?: number;
  killedExit?: number | "signal";
  exitDelayMs?: number;
  commandExitDelayMs?: number;
  destroyDelayMs?: number;
  killDelayMs?: number;
  missingLabelText?: string;
}

interface Container {
  name: string;
  labels: Record<string, string>;
  created: number;
  pid?: number;
  cli?: number;
  killed?: boolean;
}

const [state, ...args] = process.argv.slice(2);
if (!state) {
  process.exit(2);
}
const dir = join(state, "containers");
mkdirSync(dir, { recursive: true });

const config: Config = existsSync(join(state, "config.json"))
  ? (JSON.parse(readFileSync(join(state, "config.json"), "utf8")) as Config)
  : {};

appendFileSync(
  join(state, "calls.jsonl"),
  `${JSON.stringify({ args, env: process.env, at: Date.now() })}\n`,
);

const recordPath = (name: string) => join(dir, `${name}.json`);
const read = (name: string): Container | undefined =>
  existsSync(recordPath(name))
    ? (JSON.parse(readFileSync(recordPath(name), "utf8")) as Container)
    : undefined;
const write = (container: Container) =>
  writeFileSync(recordPath(container.name), JSON.stringify(container));
const all = (): Container[] =>
  readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => read(file.slice(0, -5)))
    .filter((c): c is Container => c !== undefined);

function alive(pid: number | undefined): boolean {
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs the rest of a `kill` or `rm` now, and holds the CLI open for
 * `commandExitDelayMs` afterwards: a CLI that returns after its work is done.
 */
async function finishLater(): Promise<void> {
  if (config.commandExitDelayMs) {
    process.on("exit", () => {});
    setTimeout(() => process.exit(0), config.commandExitDelayMs);
    await Promise.resolve();
  }
}

/** Kills a container's process and forgets it, as `rm --force` does. */
function remove(name: string): void {
  const container = read(name);
  if (!container) {
    return;
  }
  write({ ...container, killed: true });
  if (alive(container.pid)) {
    process.kill(container.pid!, "SIGKILL");
  }
  // With a destroy delay, the `run` still attached destroys it, late.
  if (config.destroyDelayMs && alive(container.cli)) {
    return;
  }
  rmSync(recordPath(name), { force: true });
}

const [command, ...rest] = args;

switch (command) {
  case "version": {
    if (config.versionFails) {
      console.error(
        "Cannot connect to the Docker daemon at unix:///fake.sock. Is the docker daemon running?",
      );
      process.exit(1);
    }
    console.log("Server: fake 0.0.0");
    break;
  }
  case "info": {
    const map = Object.fromEntries(
      (config.runtimes ?? ["runc"]).map((name) => [name, {}]),
    );
    console.log(JSON.stringify(map));
    break;
  }
  case "image": {
    const image = rest.at(-1)!;
    if (!(config.images ?? []).includes(image)) {
      console.error(`Error: No such image: ${image}`);
      process.exit(1);
    }
    console.log("sha256:fake");
    break;
  }
  case "pull": {
    const image = rest.at(-1)!;
    if (config.pullFails) {
      console.error(
        `Error response from daemon: pull access denied for ${image}`,
      );
      process.exit(1);
    }
    writeFileSync(
      join(state, "config.json"),
      JSON.stringify({ ...config, images: [...(config.images ?? []), image] }),
    );
    break;
  }
  case "flood": {
    const chunk = "f".repeat(64 * 1024);
    let left = Number(rest[0] ?? 0);
    while (left > 0) {
      await Bun.write(Bun.stdout, chunk.slice(0, Math.min(left, chunk.length)));
      left -= chunk.length;
    }
    break;
  }
  case "kill": {
    if (config.killDelayMs) {
      await Bun.sleep(config.killDelayMs);
    }
    await finishLater();
    const name = rest.at(-1)!;
    const container = read(name);
    if (!container) {
      console.error(`Error response from daemon: No such container: ${name}`);
      process.exit(1);
    }
    write({ ...container, killed: true });
    if (alive(container.pid)) {
      process.kill(container.pid!, "SIGKILL");
    }
    break;
  }
  case "rm": {
    if (config.killDelayMs) {
      await Bun.sleep(config.killDelayMs);
    }
    await finishLater();
    for (const name of rest.filter((arg) => !arg.startsWith("-"))) {
      remove(name);
    }
    break;
  }
  case "ps": {
    const filters = rest
      .filter((arg) => arg.startsWith("--filter=label="))
      .map((arg) => arg.slice("--filter=label=".length))
      .map(
        (pair) =>
          [
            pair.slice(0, pair.indexOf("=")),
            pair.slice(pair.indexOf("=") + 1),
          ] as const,
      );
    for (const container of all()) {
      if (filters.every(([key, value]) => container.labels[key] === value)) {
        console.log(container.name);
      }
    }
    break;
  }
  case "inspect": {
    for (const name of rest.filter((arg) => !arg.startsWith("-"))) {
      const container = read(name);
      if (container) {
        const created = new Date(container.created)
          .toISOString()
          .replace("Z", "123456Z");
        console.log(
          `/${container.name}\t${container.labels["bun-jobs.worker-id"] ?? config.missingLabelText ?? ""}\t${created}`,
        );
      }
    }
    break;
  }
  case "run": {
    await run(rest);
    break;
  }
  default:
    console.error(`fake engine: unknown command ${command}`);
    process.exit(2);
}

/** `run`: parse the flags, then start the command as a local process. */
async function run(argv: string[]): Promise<void> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: "/tmp",
  };
  const labels: Record<string, string> = {};
  let name = `fake-${Math.random().toString(16).slice(2)}`;
  let index = 0;
  for (; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("-")) {
      break;
    }
    const value = arg.slice(arg.indexOf("=") + 1);
    if (arg.startsWith("--env=")) {
      env[value.slice(0, value.indexOf("="))] = value.slice(
        value.indexOf("=") + 1,
      );
    } else if (arg.startsWith("--label=")) {
      labels[value.slice(0, value.indexOf("="))] = value.slice(
        value.indexOf("=") + 1,
      );
    } else if (arg.startsWith("--name=")) {
      name = value;
    }
  }
  const command = argv.slice(index + 1);
  const probe = name.endsWith("-probe");

  if (probe && config.probeFails) {
    console.error(config.probeFails.stderr);
    process.exit(config.probeFails.code);
  }
  if (!probe && config.runFails) {
    console.error(config.runFails.stderr);
    process.exit(config.runFails.code);
  }

  if (config.createDelayMs) {
    await Bun.sleep(config.createDelayMs);
  }
  write({ name, labels, created: Date.now() });

  const child = Bun.spawn([process.execPath, ...command], {
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const current = read(name);
  if (!current || current.killed) {
    child.kill("SIGKILL");
  } else {
    write({ ...current, pid: child.pid, cli: process.pid });
  }
  const code = await child.exited;
  if (config.destroyDelayMs) {
    await Bun.sleep(config.destroyDelayMs);
  }
  const record = read(name);
  // Removed (`rm --force`) or killed while it ran: what the engine reports
  // for a container it killed.
  const killed = record === undefined || record.killed === true;
  rmSync(recordPath(name), { force: true });
  if (config.exitDelayMs) {
    await Bun.sleep(config.exitDelayMs);
  }
  if (
    (child.signalCode === "SIGKILL" || killed) &&
    config.killedExit !== undefined
  ) {
    if (config.killedExit === "signal") {
      process.kill(process.pid, "SIGKILL");
    }
    process.exit(config.killedExit === "signal" ? 1 : config.killedExit);
  }
  process.exit(child.signalCode === "SIGKILL" || killed ? 137 : code);
}
