/**
 * End to end in Chrome (PR-R1, `webrtc.md` §6): two in-page peers on the
 * browser's own `RTCPeerConnection` connect through `connectPeer` over
 * bun-common's `signallingRelay`, and a data channel carries a message each
 * way. The page (`fixtures/webrtc-page.ts`) is bundled for a browser and
 * served beside the relay on port 0; headless Chrome loads it through
 * `Bun.WebView`, as bun-jobs-ui's e2e tests do.
 *
 * Skips visibly when no Chrome is found (`BUN_CHROME_PATH` overrides the
 * search).
 */
import type { BunHttpAdapter as Adapter } from "@kingsleyweb/bun-common";
import type { PageOutcome } from "./fixtures/webrtc-page";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter, createTestLogger } from "@kingsleyweb/bun-common";
import { signallingContract } from "@kingsleyweb/bun-common/lib/webrtc/signalling";
import { signallingRelay } from "@kingsleyweb/bun-common/webrtc";

/** Where Chrome may be, in search order. */
const CHROME_CANDIDATES = [
  process.env.BUN_CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((path): path is string => typeof path === "string" && path !== "");

/** The first Chrome that exists, if any. */
const chromePath = CHROME_CANDIDATES.find((path) => existsSync(path));

/** Every profile directory this suite makes starts with this, then `p<pid>-`. */
const PROFILE_PREFIX = "bun-client-webrtc-";

/**
 * Removes the profiles of runs whose process has exited (a run killed before
 * its `afterAll` leaves its ~100 MB profile behind), never a live one's.
 */
function sweepProfiles(): void {
  for (const name of readdirSync(tmpdir())) {
    const owner = /^bun-client-webrtc-p(\d+)-/.exec(name);
    if (owner === null || Number(owner[1]) === process.pid) continue;
    try {
      process.kill(Number(owner[1]), 0);
    } catch (error) {
      if ((error as { code?: string }).code === "ESRCH") {
        rmSync(join(tmpdir(), name), { recursive: true, force: true });
      }
    }
  }
}

/** The page's shell: the bundled script, nothing else. */
const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>webrtc</title></head><body><script type="module" src="/page.js"></script></body></html>`;

describe.skipIf(chromePath === undefined)(
  `connectPeer in Chrome${chromePath === undefined ? " — SKIPPED: no Chrome found (set BUN_CHROME_PATH)" : ""}`,
  () => {
    let adapter: Adapter;
    let origin: string;
    let view: Bun.WebView | undefined;
    let profile: string | undefined;
    const pageConsole: string[] = [];

    beforeAll(async () => {
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, "fixtures", "webrtc-page.ts")],
        target: "browser",
      });
      if (!built.success) throw new AggregateError(built.logs, "page build");
      const script = await built.outputs[0].text();

      const { logger } = createTestLogger();
      adapter = new BunHttpAdapter(0, { logger });
      adapter.ws(
        ...signallingRelay(signallingContract({ path: "/rtc/:room" })),
      );
      adapter.get("/", (_req, res) => {
        res.type("html").send(HTML);
      });
      adapter.get("/page.js", (_req, res) => {
        res.type("js").send(script);
      });
      const server = await adapter.listen(0);
      origin = `http://127.0.0.1:${server.port}`;

      sweepProfiles();
      profile = mkdtempSync(
        join(tmpdir(), `${PROFILE_PREFIX}p${process.pid}-`),
      );
      view = new Bun.WebView({
        backend: {
          type: "chrome",
          url: false,
          path: chromePath,
          // Keeps headless Chrome off the desktop's display (bun-jobs-ui's
          // e2e tests: a hung compositor once left a page rendering nothing).
          argv: ["--use-gl=disabled"],
        },
        dataStore: { directory: profile },
        width: 800,
        height: 600,
        console: (type, ...args) => {
          pageConsole.push(`${type}: ${args.map(String).join(" ")}`);
        },
      });
    }, 60_000);

    afterAll(async () => {
      view?.close();
      await adapter?.close();
      // Chrome writes a few last files as it exits: delete, wait, again.
      const directory = profile;
      if (directory === undefined) return;
      for (let attempt = 0; attempt < 6; attempt++) {
        rmSync(directory, { recursive: true, force: true });
        await Bun.sleep(300);
        if (!existsSync(directory)) break;
      }
    });

    it("connects two in-page peers over the relay, with the browser's RTCPeerConnection, and a data channel carries a message each way", async () => {
      await view!.navigate(`${origin}/`);
      const outcome = await view!.evaluate<PageOutcome>(`(async () => {
        const deadline = Date.now() + 20000;
        while (globalThis.__webrtc === undefined && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return await Promise.race([
          globalThis.__webrtc,
          new Promise((resolve) => setTimeout(() => resolve({ errors: [], rtc: "", error: "timed out" }), 20000)),
        ]);
      })()`);
      if (outcome.error !== undefined) {
        throw new Error(
          `the page failed: ${outcome.error}; page console:\n${pageConsole.join("\n")}`,
        );
      }
      expect(outcome).toEqual({
        atBob: "ping",
        reply: "echo:ping",
        errors: [],
        rtc: "function",
      });
    }, 60_000);
  },
);
