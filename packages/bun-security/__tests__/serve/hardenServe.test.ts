/**
 * `hardenServe` (layers.md L1, README §3.4): the listener's own limits set,
 * bad ones refused, and T-L1-1 — a client that opens a request and goes
 * quiet is closed at the idle timeout — in a child process.
 */
import { join } from "node:path";
import { connect } from "node:net";
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  hardenServe,
} from "../../lib/serve/index";

const fetchHandler = () => new Response("ok");

describe("hardenServe", () => {
  it("sets idleTimeout and maxRequestBodySize, keeping the rest", () => {
    const options = hardenServe(
      { port: 0, fetch: fetchHandler },
      { production: false },
    );
    expect(options).toEqual({
      port: 0,
      fetch: fetchHandler,
      idleTimeout: DEFAULT_IDLE_TIMEOUT_SECONDS,
      maxRequestBodySize: DEFAULT_MAX_REQUEST_BODY_SIZE,
    });
    expect(DEFAULT_IDLE_TIMEOUT_SECONDS).toBe(10);
    expect(DEFAULT_MAX_REQUEST_BODY_SIZE).toBe(1_048_576);
  });

  it("keeps the caller's own values", () => {
    const options = hardenServe(
      { fetch: fetchHandler, idleTimeout: 30, maxRequestBodySize: 10 },
      { production: false },
    );
    expect(options.idleTimeout).toBe(30);
    expect(options.maxRequestBodySize).toBe(10);
  });

  it("refuses an idle timeout of 0 or outside 1-255, and a bad body size", () => {
    for (const idleTimeout of [0, 256, 1.5, -1]) {
      expect(() =>
        hardenServe(
          { fetch: fetchHandler, idleTimeout },
          { production: false },
        ),
      ).toThrow("idleTimeout");
    }
    for (const maxRequestBodySize of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() =>
        hardenServe(
          { fetch: fetchHandler, maxRequestBodySize },
          { production: false },
        ),
      ).toThrow("maxRequestBodySize");
    }
  });

  it("refuses development mode in production, and allows it elsewhere", () => {
    expect(() =>
      hardenServe(
        { fetch: fetchHandler, development: true },
        { production: true },
      ),
    ).toThrow("development is on under NODE_ENV=production");
    expect(() =>
      hardenServe(
        { fetch: fetchHandler, development: { hmr: false } },
        { production: true },
      ),
    ).toThrow();
    expect(
      hardenServe(
        { fetch: fetchHandler, development: false },
        { production: true },
      ).development,
    ).toBe(false);
    expect(
      hardenServe(
        { fetch: fetchHandler, development: true },
        { production: false },
      ).development,
    ).toBe(true);
  });

  it("reads NODE_ENV when not told", () => {
    const before = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(() =>
        hardenServe({ fetch: fetchHandler, development: true }),
      ).toThrow();
      process.env.NODE_ENV = "development";
      expect(() =>
        hardenServe({ fetch: fetchHandler, development: true }),
      ).not.toThrow();
    } finally {
      process.env.NODE_ENV = before;
    }
  });

  it("is accepted by Bun.serve", async () => {
    const server = Bun.serve(
      hardenServe({ port: 0, fetch: fetchHandler }, { production: false }),
    );
    try {
      expect(
        await (await fetch(`http://127.0.0.1:${server.port}/`)).text(),
      ).toBe("ok");
    } finally {
      await server.stop(true);
    }
  });
});

/** Opens a request, sends half its headers, goes quiet; resolves with the seconds until the server closed it. */
function quietClient(port: number, giveUpMs: number): Promise<number | "open"> {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = connect(port, "127.0.0.1", () => {
      socket.write("GET / HTTP/1.1\r\nHost: test\r\n");
    });
    socket.on("error", () => {});
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("open");
    }, giveUpMs);
    socket.on("close", () => {
      clearTimeout(timer);
      resolve((performance.now() - started) / 1000);
    });
  });
}

describe("T-L1-1: a quiet (slowloris) connection", () => {
  it("is closed at the idle timeout, in a child process", async () => {
    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "../fixtures/hardened-server.ts"), "5"],
      {
        stdout: "pipe",
        stderr: "inherit",
      },
    );
    try {
      const reader = child.stdout.getReader();
      const { value } = await reader.read();
      reader.releaseLock();
      const port = Number(new TextDecoder().decode(value).trim());
      expect(port).toBeGreaterThan(0);
      // Bun checks idle timeouts on a 4 s tick (oven-sh/bun#46211): a 5 s
      // timeout closes between 5 and about 9 s.
      const closedAfter = await quietClient(port, 15_000);
      expect(closedAfter).not.toBe("open");
      expect(closedAfter as number).toBeGreaterThanOrEqual(4);
    } finally {
      child.kill();
      await child.exited;
    }
  }, 30_000);
});
