import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { ContainerEngine } from "../../../lib/queue/container/engine";
import { ContainerExecutor } from "../../../lib/queue/container/executor";
import { resolveContainerTarget } from "../../../lib/queue/container/target";

/**
 * Run as its own process by `container-fake-engine.test.ts`, started with
 * `I1_STARTUP_ONLY` in its environment: deletes it, sets `I1_LIVE_ONLY`, then
 * drives the fake engine (on the `PATH` it was given) through both of the
 * target's `Bun.spawn` sites — a CLI command and an attempt — so the engine's
 * call log shows which environment each really got. A plain `Bun.spawn`
 * would pass the startup environment, deleted variable included.
 */
delete process.env.I1_STARTUP_ONLY;
process.env.I1_LIVE_ONLY = "live";
process.env.DOCKER_CONFIG = "/i1/live-docker-config";

await new ContainerEngine({ cli: "docker", host: undefined }).exec(["version"]);

const executor = new ContainerExecutor(
  resolveContainerTarget({ kind: "container", image: "fake/bun:1" }),
  {
    workerKey: "i1test-env",
    workerId: "i1test-env.1",
    namespace: "ns",
    queue: "q",
  },
  process.argv[2]!,
);
const handle = executor.start({
  context: {
    runId: "env.1",
    runnerId: "q",
    runnerName: "i1test-env.1",
    namespace: "ns",
    attempt: 1,
    source: "queued",
    mode: "child-process",
    startedAt: Date.now(),
    deadline: null,
    args: null,
    signal: new AbortController().signal,
    logger: noopLogger,
    log: () => {},
    flushLogs: async () => {},
    progress: () => {},
    send: () => {},
    onMessage: () => () => {},
  },
  file: "unused",
  timeout: 0,
  closeTimeout: 1000,
  killTimeout: 0,
  waitToExit: true,
  forwardLogs: true,
  kind: "job",
  job: {
    id: "env",
    name: "x",
    data: {},
    opts: {},
    attemptsMade: 1,
    stacktrace: [],
    repeatKey: null,
  } as never,
  events: {
    onProgress: () => {},
    onMessage: () => {},
    onLog: () => {},
    onOutput: () => {},
    onPid: () => {},
  },
});
const outcome = await handle.done;
await handle.exited;
// eslint-disable-next-line no-console -- the test reads it
console.log(JSON.stringify({ status: outcome.status }));
