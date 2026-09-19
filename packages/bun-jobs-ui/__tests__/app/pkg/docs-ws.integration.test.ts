import type { JobsApiConfig } from "@kingsleyweb/bun-jobs";
import type { FetchLike } from "../../../app/api/client";
import { readFileSync, writeFileSync } from "node:fs";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { encodeJobId } from "@kingsleyweb/bun-jobs/api/contract";
import { afterAll, describe, expect, it } from "bun:test";

/**
 * The WebSocket reference against a REAL `createJobsApi` with its socket.
 *
 * 1. The JSON fixtures the reference's unit tests render
 *    (`../docs/ws/fixtures/*.json`) are what the API serves today, in three
 *    configurations: mode `both`, mode `runner` (pruning), and mode `jobs`
 *    with security schemes and replay off. `UPDATE_WS_FIXTURES=1` rewrites
 *    them. `info.version` (the bun-jobs version) is normalised, so a release
 *    does not stale them.
 * 2. The screen, over a fetch shim into the real router, renders the served
 *    document's channels, and its try-it builds a job channel the Events
 *    console accepts and watches.
 *
 * This project compiles without the DOM lib, so the DOM side is loaded by
 * dynamic imports the compiler does not follow (see
 * `runners.integration.test.ts`).
 */

/** What this file uses of `../dom`. */
interface DomModule {
  /** Registers happy-dom and the per-test cleanup. */
  setupDom: () => void;
}

/** What this file uses of `../register-dom`. */
interface RegisterDomModule {
  /** Bun's own networking globals, captured before happy-dom replaced them. */
  native: { Request: typeof Request; Response: typeof Response };
}

/** What this file uses of `../docs/ws/realApiScreen`. */
interface ScreenModule {
  /** Renders the job channel, fills its try-it and follows it into the console. */
  tryJobChannel: (
    fetch: FetchLike,
    queue: string,
    jobId: string,
  ) => Promise<{
    channels: { slug: string; hint: string }[];
    eventMessages: string[];
    serverUrl: string;
    subprotocol: string;
    tryHref: string;
    consoleChannel: string;
    consoleTypes: string;
  }>;
}

/** Imports a module by a specifier the compiler does not resolve. */
function load<T>(specifier: string): Promise<T> {
  return import(specifier) as Promise<T>;
}

const dom = await load<DomModule>(["..", "dom"].join("/"));
const { native } = await load<RegisterDomModule>(
  ["..", "register-dom"].join("/"),
);
dom.setupDom();

const BASE = "/jobs-api";

/** The fixture configurations, by file name. */
const FIXTURES: Record<
  string,
  Pick<JobsApiConfig, "mode" | "websocket" | "docs">
> = {
  both: { mode: "both", websocket: {} },
  runner: { mode: "runner", websocket: {} },
  "jobs-secured": {
    mode: "jobs",
    websocket: { replay: false },
    docs: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        apiKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
        session: { type: "apiKey", in: "cookie", name: "sid" },
      },
      security: [{ session: [] }, { bearer: [], apiKey: [] }],
    },
  },
};

/** Everything created, closed after the file. */
const closers: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const close of closers.reverse()) {
    await close();
  }
});

/**
 * Runs `fn` with Bun's `Response` as the global: the API builds its
 * responses from the global, which happy-dom has replaced.
 */
async function withBunGlobals<T>(fn: () => Promise<T>): Promise<T> {
  const saved = globalThis.Response;
  globalThis.Response = native.Response;
  try {
    return await fn();
  } finally {
    globalThis.Response = saved;
  }
}

/** A real API in `config`, and a `fetch` into its router. */
function realApi(
  name: string,
  config: Pick<JobsApiConfig, "mode" | "websocket" | "docs">,
): FetchLike {
  const jobs = new BunJobs({
    namespace: `ui-docs-ws-${name}`,
    driver: new MemoryDriver(),
    logger: noopLogger,
  });
  const api = createJobsApi({
    jobs,
    basePath: BASE,
    authorize: () => true,
    logger: noopLogger,
    ...config,
  });
  closers.push(async () => {
    await api.close();
    await jobs.close();
  });
  const root = new BunRouter();
  root.use(api.basePath, api.router);
  // The app's AbortSignal is happy-dom's, which Bun's Request refuses;
  // nothing here is cancelled, so it is left out.
  return async (input, { signal: _signal, ...init }) =>
    withBunGlobals(async () => {
      const response = await root.fetch(
        new native.Request(new URL(input, "http://localhost").href, init),
      );
      return new Response(await response.text(), {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      });
    });
}

/** The document an API serves over HTTP, `info.version` normalised. */
async function served(fetch: FetchLike): Promise<Record<string, unknown>> {
  const response = await fetch(`${BASE}/asyncapi.json`, { method: "GET" });
  expect(response.status).toBe(200);
  const document = (await response.json()) as {
    info: { version: string };
  } & Record<string, unknown>;
  document.info.version = "0.0.0-fixture";
  return document;
}

/** A fixture's path. */
function fixturePath(name: string): URL {
  return new URL(`../docs/ws/fixtures/${name}.json`, import.meta.url);
}

describe("the WebSocket reference's fixtures", () => {
  for (const [name, config] of Object.entries(FIXTURES)) {
    it(`${name}.json is what a real API serves`, async () => {
      const actual = await served(realApi(`fixture-${name}`, config));
      if (process.env.UPDATE_WS_FIXTURES === "1") {
        // Formatted as the lint's prettier rule wants JSON, so a rewrite
        // lints clean (plain `JSON.stringify` breaks short arrays apart).
        const { format } = await import("prettier");
        writeFileSync(
          fixturePath(name),
          await format(JSON.stringify(actual), { parser: "json" }),
        );
      }
      const recorded = JSON.parse(
        readFileSync(fixturePath(name), "utf8"),
      ) as unknown;
      // Stale? Regenerate: UPDATE_WS_FIXTURES=1 bun test <this file>.
      expect(recorded).toEqual(actual);
    });
  }
});

describe("the WebSocket reference against a real API", () => {
  it("renders the served channels, and try-it opens a job channel the Events console watches", async () => {
    const fetch = realApi("screen", { mode: "both", websocket: {} });
    const screens = await load<ScreenModule>(
      ["..", "docs", "ws", "realApiScreen"].join("/"),
    );
    // A job id needing escaping: a slash, a space and a percent sign.
    const jobId = "a/b c%";
    const view = await screens.tryJobChannel(fetch, "mail", jobId);

    expect(view.channels.map((channel) => channel.slug)).toEqual([
      "channel-connection",
      "channel-all",
      "channel-queues",
      "channel-queue",
      "channel-job",
      "channel-runners",
      "channel-runner",
    ]);
    expect(view.channels[0]!.hint).toBe(`${BASE}/ws`);
    expect(view.channels[4]!.hint).toBe("queue/{queue}/job/{jobId}");
    expect(view.eventMessages).toContain("queue.completed");
    expect(view.eventMessages).toContain("runner.succeeded");
    // The served document names the request's own host.
    expect(view.serverUrl).toBe(`ws://localhost${BASE}/ws`);
    expect(view.subprotocol).toBe("bun-jobs.v1");

    const channel = `queue/mail/job/${encodeJobId(jobId)}`;
    const href = new URL(view.tryHref, "http://localhost");
    expect(href.pathname).toBe("/jobs/events");
    expect(href.searchParams.get("channel")).toBe(channel);
    // A job channel carries a subset of the queue events: the filter says which.
    const types = href.searchParams.get("types")!.split(",");
    expect(types).toContain("completed");
    expect(types).not.toContain("paused");
    expect(view.consoleChannel).toBe(channel);
    expect(view.consoleTypes).toContain("completed");
    expect(view.consoleTypes).not.toContain("paused");
  });
});
