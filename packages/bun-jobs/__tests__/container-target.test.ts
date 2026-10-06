import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import {
  BunQueueWorker,
  ConfigError,
  IsolationUnavailableError,
  MemoryDriver,
} from "../lib/index";
import { parseCreated } from "../lib/queue/container/engine";
import { LineReader } from "../lib/queue/container/lines";
import {
  CONTAINER_BOOTSTRAP,
  containerRunArgs,
  resolveContainerTarget,
} from "../lib/queue/container/target";
import { testNamespace } from "./helpers";

/**
 * The `container` target without an engine: its options, the refusals with
 * no escape hatch, and the exact argument list they become. The engine's
 * behaviour is `container-fake-engine.test.ts`; a real Docker is
 * `container-docker.test.ts`.
 */

const owner = {
  workerKey: "i1test-key",
  workerId: "i1test-key.w1",
  namespace: "ns",
  queue: "q",
};

/** The `run` argv for `target`, with fixed test values for the rest. */
function argsFor(target: Record<string, unknown>): string[] {
  return containerRunArgs(
    resolveContainerTarget({
      kind: "container",
      image: "oven/bun:1",
      ...target,
    }),
    {
      name: "bun-jobs-test",
      owner,
      prefix: "a".repeat(32),
      processor: "/app/p.ts",
      script: CONTAINER_BOOTSTRAP,
      markers: { BUN_JOBS_CHILD: "1", BUN_JOBS_MODE: "container" },
    },
  );
}

/** The `ConfigError` resolving `target` throws, or a failure. */
function refusal(target: Record<string, unknown>): ConfigError {
  try {
    resolveContainerTarget({
      kind: "container",
      image: "oven/bun:1",
      ...target,
    });
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error(`accepted ${JSON.stringify(target)}`);
}

describe("the container target's defaults", () => {
  it("applies the plan's defaults: 256m with equal swap, 1 CPU, 128 pids, 64m tmpfs, nobody, no network", () => {
    const resolved = resolveContainerTarget({
      kind: "container",
      image: "img",
    });
    expect(resolved).toMatchObject({
      pull: "missing",
      cli: "docker",
      limits: { memory: "256m", cpus: 1, pids: 128, tmpfs: "64m" },
      user: "65534:65534",
      closeTimeout: 5000,
      maxLogBytes: 1024 * 1024,
      mounts: [],
      env: {},
    });
    const args = argsFor({});
    for (const flag of [
      "--memory=256m",
      "--memory-swap=256m",
      "--cpus=1",
      "--pids-limit=128",
      "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m",
      "--user=65534:65534",
      "--network=none",
    ]) {
      expect(args).toContain(flag);
    }
  });

  it("copies the target, so changing the caller's object later changes nothing", () => {
    const env = { A: "1" };
    const resolved = resolveContainerTarget({
      kind: "container",
      image: "img",
      env,
    });
    env.A = "2";
    expect(resolved.env).toEqual({ A: "1" });
  });
});

describe("the fixed hardening", () => {
  it("is in every argument list, whatever the options say", () => {
    const args = argsFor({
      limits: { memory: "1g", cpus: 2, pids: 256, tmpfs: "8m" },
      user: "1000:1000",
      env: { NODE_ENV: "production" },
    });
    for (const flag of [
      "--interactive",
      "--rm",
      "--pull=never",
      "--read-only",
      "--cap-drop=ALL",
      "--ipc=none",
      "--security-opt=no-new-privileges",
      "--network=none",
      "--entrypoint=bun",
      "--no-env-file",
    ]) {
      expect(args).toContain(flag);
    }
    expect(args).toContain("--memory-swap=1g");
  });

  it("never copies a host value in: every --env has a value, and there is no --env-file", () => {
    const args = argsFor({ env: { A: "1", EMPTY: "" } });
    const envs = args.filter((arg) => arg.startsWith("--env") || arg === "-e");
    // `-e` appears once, as `bun -e <script>` after the image.
    const image = args.indexOf("oven/bun:1");
    for (const arg of envs) {
      if (arg === "-e") {
        expect(args.indexOf(arg)).toBeGreaterThan(image);
        continue;
      }
      expect(arg).toMatch(/^--env=[A-Z_a-z]\w*=/);
    }
    expect(args).toContain("--env=EMPTY=");
    expect(args.some((arg) => arg.startsWith("--env-file"))).toBe(false);
  });

  it("asks for nothing it refuses: no privileged, capability, device or host namespace", () => {
    const args = argsFor({
      mounts: [{ source: "/srv/data", target: "/data" }],
      security: { apparmor: "docker-default" },
      runtime: "runsc",
    });
    for (const arg of args.slice(0, args.indexOf("oven/bun:1"))) {
      expect(arg).not.toMatch(
        /^--(privileged|cap-add|device|pid[=\s]|pid$|uts|userns|env-file|volume)/,
      );
      expect(arg).not.toMatch(/=host$/);
    }
  });

  it("puts every value in --flag=value form, so none can be read as a flag", () => {
    const args = argsFor({ env: { A: "--privileged" } });
    expect(args).toContain("--env=A=--privileged");
    expect(args).not.toContain("--privileged");
  });

  it("sets bun-jobs' markers after the target's env, so the target cannot replace them", () => {
    const args = argsFor({ env: { BUN_JOBS_MODE: "child-process" } });
    const modes = args.filter((arg) => arg.startsWith("--env=BUN_JOBS_MODE="));
    expect(modes.at(-1)).toBe("--env=BUN_JOBS_MODE=container");
  });

  it("labels each container with the worker's key, id, namespace and queue", () => {
    const args = argsFor({});
    expect(args).toContain("--label=bun-jobs.worker-key=i1test-key");
    expect(args).toContain("--label=bun-jobs.worker-id=i1test-key.w1");
    expect(args).toContain("--label=bun-jobs.namespace=ns");
    expect(args).toContain("--label=bun-jobs.queue=q");
  });

  it("runs bun with the bootstrap, the prefix and the processor, after the image", () => {
    const args = argsFor({});
    expect(args.slice(args.indexOf("oven/bun:1"))).toEqual([
      "oven/bun:1",
      "--no-env-file",
      "-e",
      CONTAINER_BOOTSTRAP,
      "a".repeat(32),
      "/app/p.ts",
    ]);
  });

  it("mounts read-only unless asked otherwise", () => {
    const args = argsFor({
      mounts: [
        { source: "/srv/a", target: "/a" },
        { source: "/srv/b", target: "/b", readOnly: false },
      ],
    });
    expect(args).toContain(
      "--mount=type=bind,source=/srv/a,target=/a,readonly",
    );
    expect(args).toContain("--mount=type=bind,source=/srv/b,target=/b");
  });
});

describe("the refusals, with no escape hatch", () => {
  it.each([
    ["privileged", { privileged: true }, /privileged mode is refused/],
    [
      "added capabilities",
      { capAdd: ["SYS_ADMIN"] },
      /added capabilities are refused/,
    ],
    ["devices", { devices: ["/dev/kvm"] }, /devices are refused/],
    ["the host's PID namespace", { pid: "host" }, /PID namespace is refused/],
    ["the host's IPC namespace", { ipc: "host" }, /IPC namespace is refused/],
    ["the host's UTS namespace", { uts: "host" }, /UTS namespace is refused/],
    [
      "raw arguments",
      { args: ["--privileged"] },
      /raw engine arguments are refused/,
    ],
    ["the host's network", { network: "host" }, /host's network is refused/],
    [
      "the host's network by name",
      { network: { name: "host" } },
      /host's network is refused/,
    ],
    [
      "another network (not in this version)",
      { network: { name: "jobs" } },
      /network must be "none"/,
    ],
    [
      "seccomp=unconfined",
      { security: { seccomp: "unconfined" } },
      /security.seccomp: "unconfined" is refused/,
    ],
    [
      "apparmor=unconfined",
      { security: { apparmor: "unconfined" } },
      /security.apparmor: "unconfined" is refused/,
    ],
    [
      "turning no-new-privileges off",
      { security: { noNewPrivileges: false } },
      /no-new-privileges is always set/,
    ],
    ["root", { user: "0:0" }, /may not be root/],
    ["root by uid alone", { user: "0" }, /may not be root/],
    ["a user name", { user: "root" }, /numeric/],
    [
      "an env variable without a value",
      { env: { SECRET: undefined } },
      /would copy the host's/,
    ],
    [
      "an env value that is not a string",
      { env: { N: 1 } },
      /would copy the host's/,
    ],
    [
      "an env name that is not one",
      { env: { "A=B": "x" } },
      /not a variable name/,
    ],
    ["unlimited pids", { limits: { pids: 0 } }, /at least 16/],
    ["an unknown key", { reuse: "worker" }, /does not take reuse/],
  ])("refuses %s", (_name, target, message) => {
    expect(refusal(target).message).toMatch(message);
  });

  it.each([
    ["/"],
    ["/proc"],
    ["/proc/1"],
    ["/sys"],
    ["/dev"],
    ["/etc"],
    ["/etc/"],
    ["/run"],
    ["/var/run"],
    ["/var/run/docker.sock"],
    ["/run/docker.sock"],
    ["/run/user/1000/podman/podman.sock"],
    ["/home/me/.docker/run/docker.sock"],
    ["/var"],
    ["/var/../etc"],
  ])("refuses a mount of %s", (source) => {
    expect(refusal({ mounts: [{ source, target: "/m" }] }).message).toMatch(
      /mounts may not mount/,
    );
  });

  it("refuses a socket found at the mount's path, whatever it is called", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bun-jobs-sock-"));
    const path = join(dir, "engine");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(path, resolve));
    try {
      expect(
        refusal({ mounts: [{ source: path, target: "/m" }] }).message,
      ).toMatch(/may not mount a socket/);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an image that would be read as a flag", () => {
    expect(() =>
      resolveContainerTarget({ kind: "container", image: "--privileged" }),
    ).toThrow(/not an image reference/);
  });

  it("refuses a missing image", () => {
    expect(() => resolveContainerTarget({ kind: "container" })).toThrow(
      /image must be a non-empty string/,
    );
  });

  it("takes root when allowRoot says so", () => {
    expect(
      resolveContainerTarget({
        kind: "container",
        image: "img",
        user: "0:0",
        allowRoot: true,
      }).user,
    ).toBe("0:0");
  });

  it("refuses at construction, before the worker does anything", () => {
    const driver = new MemoryDriver();
    expect(
      () =>
        new BunQueueWorker("q", "/app/p.ts", {
          namespace: testNamespace(),
          driver,
          logger: noopLogger,
          target: {
            kind: "container",
            image: "img",
            privileged: true,
          } as never,
        }),
    ).toThrow(ConfigError);
  });

  it("needs a processor file: a function cannot be sent to a container", () => {
    expect(
      () =>
        new BunQueueWorker("q", async () => 1, {
          namespace: testNamespace(),
          driver: new MemoryDriver(),
          logger: noopLogger,
          target: { kind: "container", image: "img" },
        }),
    ).toThrow(/needs a processor file/);
  });

  it("takes a processor path that exists only in the image", () => {
    const worker = new BunQueueWorker("q", "/nowhere/on/this/host.ts", {
      namespace: testNamespace(),
      driver: new MemoryDriver(),
      logger: noopLogger,
      target: { kind: "container", image: "img", processor: "/app/p.ts" },
    });
    expect(worker.target).toEqual({
      kind: "container",
      processor: "file",
      file: "/app/p.ts",
      container: { image: "img" },
    });
  });

  it("reports the image and the runtime on the heartbeat record, never the env", () => {
    const worker = new BunQueueWorker("q", "/app/p.ts", {
      namespace: testNamespace(),
      driver: new MemoryDriver(),
      logger: noopLogger,
      target: {
        kind: "container",
        image: "img@sha256:abc",
        processor: "/app/p.ts",
        runtime: "runsc",
        env: { SECRET: "s3cret" },
      },
    });
    expect(worker.target.container).toEqual({
      image: "img@sha256:abc",
      runtime: "runsc",
    });
    expect(JSON.stringify(worker.target)).not.toContain("s3cret");
  });
});

describe("IsolationUnavailableError", () => {
  it("is a ConfigError naming the step and carrying the engine's words", () => {
    const error = new IsolationUnavailableError(
      "probe",
      "it failed",
      "the engine said no",
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.code).toBe("CONFIG");
    expect(error.name).toBe("IsolationUnavailableError");
    expect(error.context).toMatchObject({
      step: "probe",
      stderr: "the engine said no",
    });
    expect(error.message).toBe(
      "Container isolation is unavailable (probe): it failed: the engine said no",
    );
  });
});

describe("the channel's line reader", () => {
  const read = (max: number, chunks: string[]) => {
    const lines: string[] = [];
    const oversize: [string, number][] = [];
    const reader = new LineReader(
      max,
      (line) => lines.push(line),
      (head, bytes) => oversize.push([head, bytes]),
    );
    for (const chunk of chunks) {
      reader.push(new TextEncoder().encode(chunk));
    }
    reader.end();
    return { lines, oversize };
  };

  it("joins a line split across chunks, and keeps a last line without a newline", () => {
    expect(read(100, ["ab", "c\nde", "f\n", "tail"]).lines).toEqual([
      "abc",
      "def",
      "tail",
    ]);
  });

  it("skips a line past the cap, keeping its head and its length, and goes on", () => {
    const { lines, oversize } = read(10, [
      "short\nPFX ",
      "x".repeat(30),
      "\nnext\n",
    ]);
    expect(lines).toEqual(["short", "next"]);
    expect(oversize).toEqual([[`PFX ${"x".repeat(30)}`, 34]]);
  });

  it("decodes a multi-byte character split across chunks", () => {
    const bytes = new TextEncoder().encode("é\n");
    const lines: string[] = [];
    const reader = new LineReader(
      10,
      (line) => lines.push(line),
      () => {},
    );
    reader.push(bytes.subarray(0, 1));
    reader.push(bytes.subarray(1));
    expect(lines).toEqual(["é"]);
  });
});

describe("an engine's Created timestamp", () => {
  it("reads Docker's RFC 3339 with nanoseconds and Podman's spelling", () => {
    expect(parseCreated("2026-10-01T09:20:01.123456789Z")).toBe(
      Date.parse("2026-10-01T09:20:01.123Z"),
    );
    expect(parseCreated("2026-10-01 09:20:01.123456789 +0000 UTC")).toBe(
      Date.parse("2026-10-01T09:20:01.123Z"),
    );
    expect(parseCreated("nonsense")).toBeUndefined();
  });
});
