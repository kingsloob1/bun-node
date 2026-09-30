import type { ProviderCallContext } from "../../../lib/provider/index";
import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { noopLogger } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import {
  BunQueue,
  createDriver,
  defineSummoner,
  SummonController,
} from "../../../lib/index";
import { PROVIDER_FETCH_PROBE } from "../../../lib/provider/context";
import { findSecrets, trackTimers } from "../../../lib/provider/testing/scan";
import { testNamespace } from "../../helpers";

/** The module `runScript` lives in, for a scratch script to import. */
const SPAWN_MODULE = join(
  import.meta.dir,
  "../../../lib/provider/testing/spawn.ts",
);

/**
 * The kit's instruments, each with a negative control: the secret scanner,
 * the timer tracker, and the controller's `ctx.fetch` seam (summon-compute §13.10 Q-p7).
 */

describe("the secret scanner", () => {
  const secret = "bjcanary0x5f3e9a1c2b7d4e6f8a0b1c2d";

  it("finds a secret as it is, URL-encoded, base64-encoded, and inside what a redactor leaves alone", () => {
    const places: unknown[] = [
      `token=${secret}`,
      { nested: { deeper: [`x ${secret} y`] } },
      new URL(`https://user:${secret}@api.example/x`),
      new Headers({ authorization: `Bearer ${secret}` }),
      new Map([["k", secret]]),
      new Error("wrapper", { cause: new Error(`inner ${secret}`) }),
      encodeURIComponent(`a/${secret}+`),
      `Basic ${Buffer.from(`acme:${secret}`).toString("base64")}`,
      Buffer.from(`xx${secret}`).toString("base64url"),
    ];
    for (const place of places) {
      expect(findSecrets([place], [secret]), String(place)).toHaveLength(1);
    }
  });

  it("finds nothing in text without the secret, or with a redacted one", () => {
    expect(
      findSecrets(
        [
          "[REDACTED]",
          { token: "[REDACTED]" },
          new URL("https://api.example/x?y=1"),
          Buffer.from("something else entirely").toString("base64"),
          secret.slice(0, 20),
        ],
        [secret],
      ),
    ).toEqual([]);
  });
});

describe("the timer tracker", () => {
  it("counts a timer the call leaves, and not one it clears or that fired", async () => {
    const timers = trackTimers();
    try {
      await timers.run(async () => {
        const cleared = setTimeout(() => {}, 5_000);
        clearTimeout(cleared);
        const interval = setInterval(() => {}, 5_000);
        clearInterval(interval);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      });
      expect(timers.pending()).toBe(0);
      // The negative control: a timer nobody clears, created in a
      // continuation of the call.
      const left = await timers.run(async () => {
        await Promise.resolve();
        return setTimeout(() => {}, 5_000);
      });
      expect(timers.pending()).toBe(1);
      clearTimeout(Number(left));
      expect(timers.pending()).toBe(0);
    } finally {
      timers.restore();
    }
  });

  it("keeps util.promisify's custom form and the caller's this while it tracks", async () => {
    const timers = trackTimers();
    try {
      const sleep = promisify(setTimeout);
      expect(await sleep(5, "slept")).toBe("slept");
      const holder = { setTimeout };
      const handle = holder.setTimeout(() => {}, 5_000);
      clearTimeout(handle);
    } finally {
      timers.restore();
    }
    expect(timers.pending()).toBe(0);
  });

  it("does not count a timer other code creates meanwhile, nor one after restore", () => {
    const timers = trackTimers();
    let foreign: ReturnType<typeof setTimeout> | undefined;
    try {
      foreign = setTimeout(() => {}, 5_000);
      expect(timers.pending()).toBe(0);
    } finally {
      timers.restore();
      clearTimeout(foreign);
    }
    const after = setTimeout(() => {}, 5_000);
    clearTimeout(after);
    expect(timers.pending()).toBe(0);
  });
});

describe("runScript", () => {
  /** Runs a scratch script calling `runScript` with `body`, and answers its exit and stderr. */
  async function script(
    body: string,
  ): Promise<{ code: number; stderr: string; ms: number }> {
    const dir = await mkdtemp(join(tmpdir(), "bun-jobs-runscript-"));
    try {
      const file = join(dir, "script.ts");
      await Bun.write(
        file,
        `import { runScript } from ${JSON.stringify(SPAWN_MODULE)};\n${body}\n`,
      );
      const started = Date.now();
      const proc = Bun.spawn([process.execPath, file], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
      ]);
      return { code, stderr, ms: Date.now() - started };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("ends a main that hangs at its cap, exiting 1 with a message", async () => {
    const result = await script("runScript(() => new Promise(() => {}), 300);");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("did not finish within 300ms");
    expect(result.ms).toBeLessThan(10_000);
  });

  it("does not hold a main that finishes, nor exit it early (the negative control)", async () => {
    const done = await script(
      "runScript(async () => { await Bun.sleep(50); process.exit(0); }, 5_000);",
    );
    expect(done.code).toBe(0);
    expect(done.stderr).toBe("");
    const failing = await script(
      'runScript(async () => { throw new Error("boom"); }, 5_000);',
    );
    expect(failing.code).toBe(1);
    expect(failing.stderr).toContain("boom");
  });
});

describe("the controller's ctx.fetch seam", () => {
  /** One controller check on a fresh backlog: the `ctx.fetch` its summoner was handed. */
  async function fetchSeen(
    probe: typeof fetch | undefined,
  ): Promise<ProviderCallContext["fetch"] | undefined> {
    const dir = await mkdtemp(join(tmpdir(), "bun-jobs-seam-"));
    const driver = createDriver({ type: "file", root: join(dir, "driver") });
    await driver.connect();
    const namespace = testNamespace("seam");
    const queue = new BunQueue("work", {
      namespace,
      driver,
      logger: noopLogger,
    });
    let seen: ProviderCallContext["fetch"] | undefined;
    const controller = new SummonController({
      driver,
      namespace,
      queue: "work",
      summoner: defineSummoner({
        invoke: async (_request, context) => {
          seen = context.fetch;
        },
      }),
      triggers: { onAdd: false, events: false, poll: false },
      cooldown: 0,
      logger: noopLogger,
      ...(probe === undefined ? {} : { [PROVIDER_FETCH_PROBE]: probe }),
    } as ConstructorParameters<typeof SummonController>[0]);
    try {
      await queue.add("a", {});
      expect((await controller.check()).action).toBe("summoned");
      return seen;
    } finally {
      await controller.close();
      await queue.close();
      await driver.purge(namespace);
      await driver.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("hands the kit's fetch to the summoner when set, and the global one otherwise", async () => {
    const kitFetch = Object.assign(
      async (): Promise<Response> => new Response(),
      { preconnect: fetch.preconnect },
    ) as typeof fetch;
    expect(await fetchSeen(kitFetch)).toBe(kitFetch);
    expect(await fetchSeen(undefined)).toBe(globalThis.fetch);
  });

  it("is exported from no entry", async () => {
    for (const entry of [
      await import("../../../lib/index"),
      await import("../../../lib/provider/index"),
      await import("../../../lib/provider/testing/index"),
      await import("../../../lib/summon/index"),
    ]) {
      expect(Object.values(entry)).not.toContain(PROVIDER_FETCH_PROBE);
      expect("PROVIDER_FETCH_PROBE" in entry).toBe(false);
    }
  });
});
