import type { JobsApiConfig } from "@kingsleyweb/bun-jobs";
import { readFileSync, writeFileSync } from "node:fs";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { afterAll, describe, expect, it } from "bun:test";
import { readWsDoc } from "../../app/screens/docs/ws/model";

/**
 * The WebSocket reference against a REAL `createJobsApi` with its socket.
 *
 * The JSON fixtures the reference's unit tests render
 * (`../app/docs/ws/fixtures/*.json`) are what the API serves today, in three
 * configurations: mode `both`, mode `runner` (pruning), and mode `jobs` with
 * security schemes and replay off. `UPDATE_WS_FIXTURES=1` rewrites them.
 * `info.version` (the bun-jobs version) is normalised, so a release does not
 * stale them.
 *
 * bun-jobs is a devDependency of this package, used by this file alone: the
 * golden net is the jobs vocabulary's documents, which this package's default
 * extension prefixes (`x-bun-common`, then `x-bun-jobs`) must keep reading.
 * bun-jobs-ui keeps its own copies of the fixtures until its migration (F2).
 */

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

/** A real API in `config`, and a `fetch` into its router. */
function realApi(
  name: string,
  config: Pick<JobsApiConfig, "mode" | "websocket" | "docs">,
): (path: string) => Promise<Response> {
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
  return async (path) =>
    root.fetch(new Request(`http://localhost${path}`, { method: "GET" }));
}

/** The document an API serves over HTTP, `info.version` normalised. */
async function served(
  fetch: (path: string) => Promise<Response>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${BASE}/asyncapi.json`);
  expect(response.status).toBe(200);
  const document = (await response.json()) as {
    info: { version: string };
  } & Record<string, unknown>;
  document.info.version = "0.0.0-fixture";
  return document;
}

/** A fixture's path. */
function fixturePath(name: string): URL {
  return new URL(`../app/docs/ws/fixtures/${name}.json`, import.meta.url);
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

describe("the served document through the viewer's model", () => {
  it("reads the served channels and extensions with the default prefixes", async () => {
    const document = await served(
      realApi("screen", { mode: "both", websocket: {} }),
    );
    const doc = readWsDoc(document);
    expect(doc.channels.map((channel) => channel.slug)).toEqual([
      "channel-connection",
      "channel-all",
      "channel-queues",
      "channel-queue",
      "channel-job",
      "channel-workers",
      "channel-queueWorkers",
      "channel-runners",
      "channel-runner",
    ]);
    expect(doc.channels[0].address).toBe(`${BASE}/ws`);
    expect(doc.channels[4].address).toBe("queue/{queue}/job/{jobId}");
    // Worker events travel on their own channels, off `all` and `queues`.
    expect(doc.channels[6].address).toBe("queue/{queue}/workers");
    expect(
      doc.messages
        .filter((message) => message.event !== null)
        .map((message) => message.name),
    ).toContain("queue.completed");
    // The served document names the request's own host, and the subprotocol.
    expect(doc.server?.url).toBe(`ws://localhost${BASE}/ws`);
    expect(doc.subprotocol).toEqual({
      value: "bun-jobs.v1",
      fromDocument: true,
      source: "server-extension",
    });
    expect(doc.extensionKeys.limits).toBe("x-bun-jobs-limits");
    expect(doc.limits?.replay).toEqual({ size: 1000, maxAgeMs: 300000 });
  });
});
