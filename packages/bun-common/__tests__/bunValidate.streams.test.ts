/**
 * Response contracts with streamed bodies (plan `docs/plans/bun-validate/`
 * §4.4.2–§4.4.3, §4.7.1, V3b): `chunks()`, `sse()` and `opaque()` in a
 * status's `content` map; the chunk gate on piped streams and on
 * `write()`/`end()` streams; a whole-body schema against a stream (skipped,
 * one warning per route, Q-H4); `sendFile()`'s bytes; a media type mapped to
 * `null`. H-numbers name the cases of `evidence/http-complete/`.
 *
 * Every stream kind runs under `off` (the bad chunk is sent), `warn` (sent,
 * one warning per stream, no value from it) and `error` (cut off at the bad
 * chunk, logged at `error`; the client sees the stream error), with zod
 * (synchronous) and yup (a Promise), over a real socket on port 0 and through
 * `router.fetch()`.
 */
import type { BunResponse } from "../lib/BunResponse";
import type { LogEvent } from "../lib/logging";
import type { RouterErrorMiddlewareHandler } from "../lib/types/general";
import type { StandardSchemaV1 } from "../lib/types/standardSchema";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as yup from "yup";
import { z } from "zod";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import { validate } from "../lib/BunValidate";
import { createReceiver, createSender } from "../lib/contract/guard";
import { describeContract } from "../lib/contract/describe";
import { getContract } from "../lib/contract/transport";
import { httpTransport } from "../lib/contract/http";
import { createTestLogger } from "../lib/logging";
import {
  chunks,
  LineFramer,
  opaque,
  sse,
  SseFramer,
} from "../lib/responseBodies";
import { ResponseValidationError } from "../lib/responseValidation";

type Mode = "off" | "warn" | "error";
const MODES: readonly Mode[] = ["off", "warn", "error"];
type Vendor = "zod" | "yup";
const VENDORS: readonly Vendor[] = ["zod", "yup"];
/** How a test reaches the routes: over a socket on port 0, or through `router.fetch()`. */
type Via = "socket" | "router.fetch()";
const VIAS: readonly Via[] = ["socket", "router.fetch()"];

const encoder = new TextEncoder();

/** Adapters to close after each test. */
const open: BunHttpAdapter[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
});

/** Renders a `ResponseValidationError` as a 500 listing `part.path` per issue. */
const renderRefusal = ((error, _req, res, _next) => {
  if (error instanceof ResponseValidationError) {
    res.status(500).json({
      error: error.name,
      issues: error.issues.map(
        (i) => `${i.target}${i.path === "" ? "" : `.${i.path}`}`,
      ),
    });
    return;
  }
  res.status(500).json({ error: String(error) });
}) satisfies RouterErrorMiddlewareHandler;

/** A router (or a listening adapter) logging into a test sink, with `responseValidation: mode`. */
async function serve(
  via: Via,
  mode: Mode | undefined,
  build: (router: BunRouter) => void,
): Promise<{ get: (path: string) => Promise<Response>; events: LogEvent[] }> {
  const { logger, events } = createTestLogger();
  const options =
    mode === undefined ? { logger } : { logger, responseValidation: mode };
  if (via === "router.fetch()") {
    const router = new BunRouter(options);
    build(router);
    return { get: async (path) => router.fetch(path), events };
  }
  const adapter = new BunHttpAdapter(0, options);
  build(adapter);
  await adapter.listen(0);
  open.push(adapter);
  return {
    get: async (path) =>
      fetch(`http://127.0.0.1:${adapter.listeningPort}${path}`),
    events,
  };
}

/** Everything a client read of a body, and how the body ended: cleanly, or with an error (a cut stream). */
async function drain(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const chunksRead: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done)
        return {
          status: response.status,
          text,
          chunksRead,
          end: "done" as const,
        };
      const piece = decoder.decode(value, { stream: true });
      chunksRead.push(piece);
      text += piece;
    }
  } catch (error) {
    return {
      status: response.status,
      text,
      chunksRead,
      end: "error" as const,
      error,
    };
  }
}

/** Waits for a condition a background check settles (a yup Promise). */
async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(1);
  }
}

/** The log lines a stream's mismatch wrote, by level. */
const streamLogs = (events: LogEvent[], level: "warn" | "error") =>
  events.filter(
    (e) => e.level === level && e.message.startsWith("streamed response"),
  );

/**
 * Whether a cut-off stream delivered what it should have before the cut:
 * exactly `sent` through `router.fetch()`. Over a socket, `sent` or nothing:
 * Bun resets a connection whose body stream errors, and under heavy load
 * (two 16-worker suites at once, measured) it can reset before it has
 * flushed the chunk that passed, as `BunResponse#pullDestroyed` describes
 * for `res.destroy()`. The bad chunk never arrives either way.
 */
function sentBeforeCut(via: Via, text: string, sent: string): boolean {
  return text === sent || (via === "socket" && text === "");
}

/** A typed `res` as the unconstrained `BunResponse`. */
const untyped = (res: unknown): BunResponse => res as BunResponse;

/** The pause between chunks, so a socket and Bun's stream readers keep them apart. */
const GAP = 5;

// ---------------------------------------------------------------------------
// Every stream kind × mode × vendor × socket/router.fetch()
// ---------------------------------------------------------------------------

/** A text chunk: `ok` and a digit. */
const OK_ZOD = z.string().regex(/^ok\d$/);
const OK_YUP = yup
  .string()
  .strict()
  .required()
  .matches(/^ok\d$/);
const CHUNK: Record<Vendor, StandardSchemaV1> = { zod: OK_ZOD, yup: OK_YUP };

/** Sends `parts` as one kind of stream, a pause between chunks. */
type Producer = (res: BunResponse, parts: string[]) => unknown;

const KINDS: [name: string, h: string, produce: Producer][] = [
  [
    "ReadableStream",
    "H19–H20",
    (res, parts) => {
      const queue = [...parts];
      return res.send(
        new ReadableStream({
          async pull(controller) {
            await Bun.sleep(GAP);
            const next = queue.shift();
            if (next === undefined) controller.close();
            else controller.enqueue(encoder.encode(next));
          },
        }),
      );
    },
  ],
  [
    "Node Readable",
    "H19–H20",
    (res, parts) => {
      const queue = [...parts];
      return res.send(
        new Readable({
          read() {
            setTimeout(() => this.push(queue.shift() ?? null), GAP);
          },
        }),
      );
    },
  ],
  [
    "async iterable",
    "H19–H20",
    (res, parts) =>
      res.send({
        async *[Symbol.asyncIterator]() {
          for (const part of parts) {
            await Bun.sleep(GAP);
            yield part;
          }
        },
      }),
  ],
  [
    "async function*",
    "H19–H20",
    (res, parts) =>
      res.send(async function* () {
        for (const part of parts) {
          await Bun.sleep(GAP);
          yield part;
        }
      }),
  ],
  [
    "write()/end()",
    "H21–H22",
    async (res, parts) => {
      for (const part of parts) {
        res.write(part);
        await Bun.sleep(GAP);
      }
      await res.end();
    },
  ],
];

describe("chunks(): every stream kind × mode × vendor (H19–H22)", () => {
  for (const [name, h, produce] of KINDS) {
    for (const vendor of VENDORS) {
      for (const via of VIAS) {
        for (const mode of MODES) {
          it(`${h} ${name}, ${vendor}, ${mode}, ${via}: a bad second chunk`, async () => {
            const { get, events } = await serve(via, mode, (router) => {
              router.get(
                "/x",
                validate(
                  {},
                  {
                    responses: {
                      200: { content: { "text/plain": chunks(CHUNK[vendor]) } },
                    },
                  },
                ),
                (_req, res) => {
                  res.type("text/plain");
                  return produce(untyped(res), ["ok1", "LEAK-bad", "ok3"]);
                },
              );
            });
            const read = await drain(await get("/x"));
            expect(read.status).toBe(200);
            if (mode === "error") {
              // Cut off at the bad chunk: nothing from it or after it.
              expect(read.end).toBe("error");
              expect(sentBeforeCut(via, read.text, "ok1")).toBe(true);
              await until(() => streamLogs(events, "error").length === 1);
              expect(streamLogs(events, "warn")).toHaveLength(0);
            } else {
              expect(read.end).toBe("done");
              expect(read.text).toBe("ok1LEAK-badok3");
              if (mode === "warn") {
                await until(() => streamLogs(events, "warn").length === 1);
              }
              expect(streamLogs(events, "error")).toHaveLength(0);
              await Bun.sleep(5);
              expect(streamLogs(events, "warn")).toHaveLength(
                mode === "warn" ? 1 : 0,
              );
            }
            // Never the received value.
            expect(JSON.stringify(events)).not.toContain("LEAK");
          });
        }
        it(`${h} ${name}, ${vendor}, ${via}: a good stream passes under error`, async () => {
          const { get, events } = await serve(via, "error", (router) => {
            router.get(
              "/x",
              validate(
                {},
                {
                  responses: {
                    200: { content: { "text/plain": chunks(CHUNK[vendor]) } },
                  },
                },
              ),
              (_req, res) => {
                res.type("text/plain");
                return produce(untyped(res), ["ok1", "ok2", "ok3"]);
              },
            );
          });
          const read = await drain(await get("/x"));
          expect(read).toMatchObject({
            status: 200,
            end: "done",
            text: "ok1ok2ok3",
          });
          expect(events).toHaveLength(0);
        });
      }
    }
  }

  it("over a socket, a piped chunk that passed is sent before a bad one right behind it cuts the stream", async () => {
    const { get } = await serve("socket", "error", (router) => {
      router.get(
        "/x",
        validate(
          {},
          { responses: { 200: { content: { "text/plain": chunks(OK_ZOD) } } } },
        ),
        (_req, res) => {
          res.type("text/plain");
          res.send(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode("ok1"));
                controller.enqueue(encoder.encode("bad"));
                controller.close();
              },
            }),
          );
        },
      );
    });
    // Every try is cut before the bad chunk; on an idle machine every try
    // also delivers the good one (40 of 40 measured; 0 of 40 when the stream
    // is errored without the timer), under heavy load Bun can lose it.
    let delivered = 0;
    for (let i = 0; i < 10; i++) {
      const read = await get("/x").then(drain, () => ({
        text: "",
        end: "error" as const,
      }));
      expect(read.end).toBe("error");
      expect(["", "ok1"]).toContain(read.text);
      if (read.text === "ok1") delivered++;
    }
    expect(delivered).toBeGreaterThan(0);
  });

  it("warn reports a stream's first mismatch only, whatever follows", async () => {
    const { get, events } = await serve("router.fetch()", "warn", (router) => {
      router.get(
        "/x",
        validate(
          {},
          { responses: { 200: { content: { "text/plain": chunks(OK_ZOD) } } } },
        ),
        async (_req, res) => {
          res.type("text/plain");
          for (const part of ["ok1", "bad", "bad", "ok4", "bad"]) {
            res.write(part);
          }
          await res.end();
        },
      );
    });
    expect((await drain(await get("/x"))).text).toBe("ok1badbadok4bad");
    expect(streamLogs(events, "warn")).toHaveLength(1);
    // A second stream gets its own report.
    await drain(await get("/x"));
    expect(streamLogs(events, "warn")).toHaveLength(2);
  });

  it("the cut-off error names the issues and never the value; issues carry the status and declared media type", async () => {
    const { get, events } = await serve("router.fetch()", "error", (router) => {
      router.get(
        "/x",
        validate(
          {},
          { responses: { 200: { content: { "text/*": chunks(OK_ZOD) } } } },
        ),
        async (_req, res) => {
          res.type("text/plain");
          res.write("ok1");
          res.write("LEAK");
          await res.end();
        },
      );
    });
    const read = await drain(await get("/x"));
    expect(read.error).toBeInstanceOf(ResponseValidationError);
    const error = read.error as ResponseValidationError;
    expect(error.message).not.toContain("LEAK");
    expect(error.issues).toEqual([
      expect.objectContaining({
        target: "body",
        path: "",
        key: "200",
        mediaType: "text/*",
      }),
    ]);
    expect(streamLogs(events, "error")[0].fields).toMatchObject({
      method: "GET",
      route: "/x",
      status: 200,
    });
  });

  it("raw chunks of a non-text media type are bytes; zero-length chunks are not checked", async () => {
    const seen: unknown[] = [];
    const bytes = z.custom<Uint8Array>((v) => {
      seen.push(v);
      return v instanceof Uint8Array && v.length === 2;
    });
    const { get } = await serve("router.fetch()", "error", (router) => {
      router.get(
        "/x",
        validate(
          {},
          {
            responses: {
              200: { content: { "application/octet-stream": chunks(bytes) } },
            },
          },
        ),
        async (_req, res) => {
          res.type("application/octet-stream");
          res.write(new Uint8Array([1, 2]));
          res.write("");
          res.write("ab");
          await res.end();
        },
      );
    });
    const read = await drain(await get("/x"));
    expect(read.end).toBe("done");
    expect(seen).toHaveLength(2);
    expect(seen.every((v) => v instanceof Uint8Array)).toBe(true);
  });

  it("raw text chunks are decoded across a split multi-byte character", async () => {
    const seen: unknown[] = [];
    const text = z.custom<string>((v) => {
      seen.push(v);
      return typeof v === "string";
    });
    const { get } = await serve("router.fetch()", "error", (router) => {
      router.get(
        "/x",
        validate(
          {},
          { responses: { 200: { content: { "text/plain": chunks(text) } } } },
        ),
        async (_req, res) => {
          res.type("text/plain");
          const euro = encoder.encode("€"); // 3 bytes
          res.write(euro.slice(0, 1));
          res.write(euro.slice(1));
          await res.end();
        },
      );
    });
    expect((await drain(await get("/x"))).text).toBe("€");
    expect(seen).toEqual(["", "€"]);
  });
});

// ---------------------------------------------------------------------------
// write()/end(): the opening, async chains, the end
// ---------------------------------------------------------------------------

describe("a bad FIRST chunk over a socket, under error (accepted behaviour)", () => {
  /** A socket route sending `["LEAK-first", "ok2"]` as `kind` under `chunks()`. */
  async function first(kind: "piped" | "write()") {
    const { get, events } = await serve("socket", "error", (router) => {
      router.get(
        "/x",
        validate(
          {},
          { responses: { 200: { content: { "text/plain": chunks(OK_ZOD) } } } },
        ),
        async (_req, res) => {
          res.type("text/plain");
          if (kind === "piped") {
            return untyped(res).send(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(encoder.encode("LEAK-first"));
                  controller.enqueue(encoder.encode("ok2"));
                  controller.close();
                },
              }),
            );
          }
          res.write("LEAK-first");
          res.write("ok2");
          await res.end();
        },
      );
      router.use(renderRefusal);
    });
    return { attempt: get("/x"), events };
  }

  it("a piped stream is cut before Bun writes its headers: the connection resets, no response, logged at error", async () => {
    const { attempt, events } = await first("piped");
    let outcome: string;
    try {
      const response = await attempt;
      outcome = `status ${response.status}`;
      // A response that did arrive must not carry the bad chunk.
      expect((await drain(response)).text).not.toContain("LEAK");
    } catch {
      outcome = "reset";
    }
    expect(outcome).toBe("reset");
    await until(() => streamLogs(events, "error").length === 1);
    expect(JSON.stringify(events)).not.toContain("LEAK");
  });

  it("negative control: a write() stream's bad first chunk is a clean 500", async () => {
    const { attempt, events } = await first("write()");
    const response = await attempt;
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "ResponseValidationError",
      issues: ["body"],
    });
    expect(JSON.stringify(events)).not.toContain("LEAK");
  });
});

describe("write()/end(): the opening is a commit (H38), later writes are chunks", () => {
  for (const vendor of VENDORS) {
    it(`a bad FIRST chunk is refused before anything went out: a clean 500 (${vendor})`, async () => {
      let wroteAfter: boolean | undefined;
      const { get, events } = await serve(
        "router.fetch()",
        "error",
        (router) => {
          router.get(
            "/x",
            validate(
              {},
              {
                responses: {
                  200: { content: { "text/plain": chunks(CHUNK[vendor]) } },
                },
              },
            ),
            (_req, res) => {
              res.type("text/plain");
              res.write("LEAK-first");
              // The producer goes on: dropped, the error handler answers
              // (a yup verdict is still to come: the write is queued behind it).
              wroteAfter = res.write("ok2");
              void res.end("ok3");
            },
          );
          router.use(renderRefusal);
        },
      );
      const response = await get("/x");
      expect(wroteAfter).toBe(vendor === "yup");
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "ResponseValidationError",
        issues: ["body"],
      });
      expect(JSON.stringify(events)).not.toContain("LEAK");
    });
  }

  it("negative control: under warn the same first chunk is sent and reported once", async () => {
    const { get, events } = await serve("router.fetch()", "warn", (router) => {
      router.get(
        "/x",
        validate(
          {},
          { responses: { 200: { content: { "text/plain": chunks(OK_ZOD) } } } },
        ),
        (_req, res) => {
          res.type("text/plain");
          res.write("bad1");
          res.write("bad2");
          void res.end();
        },
      );
    });
    expect((await drain(await get("/x"))).text).toBe("bad1bad2");
    expect(
      events.filter((e) => e.level === "warn" && e.message.includes("match")),
    ).toHaveLength(1);
  });

  it("H38 an undeclared media type refuses the opening: 500, with the refused response's own headers dropped (Q-H3)", async () => {
    const { get } = await serve("router.fetch()", "error", (router) => {
      router.get(
        "/x",
        validate(
          {},
          {
            responses: {
              200: { content: { "text/event-stream": sse({ tick: null }) } },
            },
          },
        ),
        (_req, res) => {
          res.set("Access-Control-Allow-Origin", "*");
          res.set("Vary", "Origin");
          res.cookie("sid", "LEAK");
          res.type("text/csv");
          res.write("a,b\n");
        },
      );
      router.use(renderRefusal);
    });
    const response = await get("/x");
    expect(response.status).toBe(500);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("vary")).toBe("Origin");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      error: "ResponseValidationError",
      issues: ["body"],
    });
  });

  it("H38 flushHeaders() with an undeclared status refuses the opening (500)", async () => {
    const { get } = await serve("router.fetch()", "error", (router) => {
      router.get(
        "/x",
        validate({}, { responses: { 200: null } }),
        (_req, res) => {
          untyped(res).status(202);
          res.flushHeaders();
          res.write("late");
        },
      );
      router.use(renderRefusal);
    });
    const response = await get("/x");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "ResponseValidationError",
      issues: ["status"],
    });
  });

  it("a write() stream with no Content-Type under a declared body is refused", async () => {
    const { get } = await serve("router.fetch()", "error", (router) => {
      router.get(
        "/x",
        validate(
          {},
          { responses: { 200: { content: { "text/plain": chunks(OK_ZOD) } } } },
        ),
        (_req, res) => {
          res.write("ok1");
          void res.end();
        },
      );
      router.use(renderRefusal);
    });
    expect((await get("/x")).status).toBe(500);
  });

  it("a refused opening with no error handler: router.fetch() rejects with the ResponseValidationError (H43)", async () => {
    const router = new BunRouter({
      responseValidation: "error",
      logger: createTestLogger().logger,
    });
    router.get(
      "/x",
      validate(
        {},
        { responses: { 200: { content: { "text/plain": chunks(OK_ZOD) } } } },
      ),
      (_req, res) => {
        res.type("text/plain");
        res.write("bad");
      },
    );
    await expect(router.fetch("/x")).rejects.toBeInstanceOf(
      ResponseValidationError,
    );
  });

  it("async verdicts are chained in order, and end() waits for the chain (yup)", async () => {
    let atEnd: unknown;
    const { get } = await serve("router.fetch()", "error", (router) => {
      router.get(
        "/x",
        validate(
          {},
          { responses: { 200: { content: { "text/plain": chunks(OK_YUP) } } } },
        ),
        async (_req, res) => {
          res.type("text/plain");
          for (let i = 1; i <= 6; i++) res.write(`ok${i}`);
          // Nothing is written yet: each write waits for its verdict.
          expect(res.getBody()).toBeUndefined();
          await res.end("ok7");
          atEnd = [...(res.getBody() as string[])];
        },
      );
    });
    const read = await drain(await get("/x"));
    expect(read).toMatchObject({ end: "done", text: "ok1ok2ok3ok4ok5ok6ok7" });
    await until(() => atEnd !== undefined);
    expect(atEnd).toEqual(["ok1", "ok2", "ok3", "ok4", "ok5", "ok6", "ok7"]);
  });

  it("an async verdict that fails mid-chain stops every later write, already queued (yup)", async () => {
    const { get, events } = await serve("router.fetch()", "error", (router) => {
      router.get(
        "/x",
        validate(
          {},
          {
            responses: { 200: { content: { "text/plain": chunks(OK_YUP) } } },
          },
        ),
        async (_req, res) => {
          res.type("text/plain");
          res.write("ok1");
          res.write("ok2");
          res.write("bad");
          res.write("ok4");
          await res.end("ok5");
        },
      );
    });
    const read = await drain(await get("/x"));
    expect(read.end).toBe("error");
    expect(read.text).toBe("ok1ok2");
    expect(streamLogs(events, "error")).toHaveLength(1);
  });

  it("a synchronous vendor writes in place: the chunk is written when write() returns (zod)", async () => {
    let afterWrite: unknown;
    const { get } = await serve("router.fetch()", "error", (router) => {
      router.get(
        "/x",
        validate(
          {},
          { responses: { 200: { content: { "text/plain": chunks(OK_ZOD) } } } },
        ),
        (_req, res) => {
          res.type("text/plain");
          res.write("ok1");
          res.write("ok2");
          afterWrite = [...(res.getBody() as string[])];
          void res.end();
        },
      );
    });
    await drain(await get("/x"));
    expect(afterWrite).toEqual(["ok1", "ok2"]);
  });

  it("a write after end() on a checked stream is after the end", async () => {
    let wrote: boolean | undefined;
    const { get } = await serve("router.fetch()", "error", (router) => {
      router.get(
        "/x",
        validate(
          {},
          { responses: { 200: { content: { "text/plain": chunks(OK_YUP) } } } },
        ),
        (_req, res) => {
          res.type("text/plain");
          res.write("ok1");
          void res.end();
          wrote = res.write("ok2");
        },
      );
    });
    expect((await drain(await get("/x"))).text).toBe("ok1");
    expect(wrote).toBe(false);
  });

  it("an error handler's stream is only reported, never cut (Q-H2)", async () => {
    const { get, events } = await serve("router.fetch()", "error", (router) => {
      router.get(
        "/x",
        validate(
          {},
          {
            responses: {
              200: { content: { "text/plain": chunks(OK_ZOD) } },
              500: { content: { "text/plain": chunks(OK_ZOD) } },
            },
          },
        ),
        () => {
          throw new Error("boom");
        },
      );
      router.use(((_error, _req, res, _next) => {
        res.status(500).type("text/plain");
        res.write("ok1");
        res.write("bad");
        void res.end("ok3");
      }) satisfies RouterErrorMiddlewareHandler);
    });
    const read = await drain(await get("/x"));
    expect(read).toMatchObject({ status: 500, end: "done", text: "ok1badok3" });
    expect(streamLogs(events, "warn")).toHaveLength(1);
    expect(streamLogs(events, "error")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// NDJSON framing
// ---------------------------------------------------------------------------

const ROW = z.object({ n: z.number() });

describe("chunks(S, { framing: 'ndjson' })", () => {
  it("frames lines split across chunks, CRLF and blank lines included", async () => {
    const seen: unknown[] = [];
    const row = ROW.refine((v) => {
      seen.push(v);
      return true;
    });
    const { get } = await serve("router.fetch()", "error", (router) => {
      router.get(
        "/x",
        validate(
          {},
          {
            responses: {
              200: {
                content: {
                  "application/x-ndjson": chunks(row, { framing: "ndjson" }),
                },
              },
            },
          },
        ),
        async (_req, res) => {
          res.type("application/x-ndjson");
          for (const part of ['{"n":1}\n{"', 'n":2}\r', "\n\n", '{"n":3}']) {
            res.write(part);
          }
          await res.end();
        },
      );
    });
    expect((await drain(await get("/x"))).end).toBe("done");
    // The last line, without its \n, is checked at the end.
    expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  for (const via of VIAS) {
    it(`a bad line split across chunks cuts the stream at the chunk completing it (${via})`, async () => {
      const { get } = await serve(via, "error", (router) => {
        router.get(
          "/x",
          validate(
            {},
            {
              responses: {
                200: {
                  content: {
                    "application/x-ndjson": chunks(ROW, { framing: "ndjson" }),
                  },
                },
              },
            },
          ),
          async (_req, res) => {
            res.type("application/x-ndjson");
            for (const part of ['{"n":1}\n{"n":', '"LEAK"}\n', '{"n":3}\n']) {
              res.write(part);
              await Bun.sleep(GAP);
            }
            await res.end();
          },
        );
      });
      const read = await drain(await get("/x"));
      expect(read.end).toBe("error");
      expect(sentBeforeCut(via, read.text, '{"n":1}\n{"n":')).toBe(true);
    });
  }

  it("a line that is not JSON is a mismatch; a bad last line is caught at the end", async () => {
    const { get, events } = await serve("router.fetch()", "error", (router) => {
      const route = validate(
        {},
        {
          responses: {
            200: {
              content: {
                "application/x-ndjson": chunks(ROW, { framing: "ndjson" }),
              },
            },
          },
        },
      );
      router.get("/a", route, async (_req, res) => {
        res.type("application/x-ndjson");
        res.write('{"n":1}\n');
        res.write("LEAK not json\n");
        await res.end();
      });
      router.get("/b", route, async (_req, res) => {
        res.type("application/x-ndjson");
        res.write('{"n":1}\n');
        await res.end('{"n":"LEAK"}');
      });
    });
    const a = await drain(await get("/a"));
    expect(a).toMatchObject({ end: "error", text: '{"n":1}\n' });
    expect((a.error as ResponseValidationError).issues[0].message).toBe(
      "A line is not valid JSON",
    );
    const b = await drain(await get("/b"));
    // The last write is sent (it completes no line); the end check cuts it.
    expect(b.end).toBe("error");
    expect(JSON.stringify(events)).not.toContain("LEAK");
  });

  it("LineFramer: the same lines whatever the chunking", () => {
    const text = '{"a":1}\r\n\n  \n{"b":2}\n{"c":3}';
    const whole = new LineFramer();
    const one = [...whole.push(text), whole.end()];
    const split = new LineFramer();
    const parts: (string | undefined)[] = [];
    for (const ch of text) parts.push(...split.push(ch));
    parts.push(split.end());
    expect(parts).toEqual(one);
    expect(one).toEqual(['{"a":1}', "", "  ", '{"b":2}', '{"c":3}']);
  });
});

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

const TICK_ZOD = z.object({ n: z.number() });
const TICK_YUP = yup.object({ n: yup.number().strict().required() });
const TICK: Record<Vendor, StandardSchemaV1> = { zod: TICK_ZOD, yup: TICK_YUP };

/** An SSE route under `mode`, writing `parts` with `write()` (a pause between them). */
function sseRoute(
  mode: Mode,
  vendor: Vendor,
  parts: string[],
  via: Via = "router.fetch()",
  options?: { data?: "json" | "text" },
) {
  return serve(via, mode, (router) => {
    router.get(
      "/x",
      validate(
        {},
        {
          responses: {
            200: {
              content: {
                "text/event-stream": sse(
                  { tick: TICK[vendor], done: null },
                  options,
                ),
              },
            },
          },
        },
      ),
      async (_req, res) => {
        res.set("Content-Type", "text/event-stream");
        for (const part of parts) {
          res.write(part);
          await Bun.sleep(GAP);
        }
        await res.end();
      },
    );
  });
}

describe("sse(): each event, framed across chunks (H23, H24, H39)", () => {
  for (const vendor of VENDORS) {
    for (const via of VIAS) {
      for (const mode of MODES) {
        it(`H23–H24 ${vendor}, ${mode}, ${via}: stops at the bad event`, async () => {
          const { get, events } = await sseRoute(
            mode,
            vendor,
            [
              'event: tick\ndata: {"n":1}\n\n',
              'event: tick\ndata: {"n":"LEAK"}\n\n',
              "event: done\n\n",
            ],
            via,
          );
          const read = await drain(await get("/x"));
          if (mode === "error") {
            expect(read.end).toBe("error");
            expect(
              sentBeforeCut(via, read.text, 'event: tick\ndata: {"n":1}\n\n'),
            ).toBe(true);
            await until(() => streamLogs(events, "error").length === 1);
          } else {
            expect(read.end).toBe("done");
            expect(read.text).toContain("LEAK");
            expect(read.text).toEndWith("event: done\n\n");
            if (mode === "warn") {
              await until(() => streamLogs(events, "warn").length === 1);
            }
            await Bun.sleep(5);
            expect(streamLogs(events, "warn")).toHaveLength(
              mode === "warn" ? 1 : 0,
            );
          }
          expect(JSON.stringify(events)).not.toContain("LEAK");
        });
      }
    }

    it(`events split mid-chunk, CRLF split between chunks, comments, id and retry: all framed (${vendor})`, async () => {
      const { get, events } = await sseRoute("error", vendor, [
        ": a comment\n\nretry: 1000\n\nid: 7\n\n",
        'event: tick\r\ndata: {"n"',
        ":1}\r",
        "\n\r\n",
        'data: {"n":\n',
        "data: 2}\n\n",
        "event: done\ndata:\n\n",
      ]);
      // The unnamed event is `message`, which is not declared: the stream is
      // cut at the write completing it (its first line, which completed no
      // event, was sent).
      const read = await drain(await get("/x"));
      expect(read.end).toBe("error");
      expect(read.text).toBe(
        ': a comment\n\nretry: 1000\n\nid: 7\n\nevent: tick\r\ndata: {"n":1}\r\n\r\ndata: {"n":\n',
      );
      await until(() => streamLogs(events, "error").length === 1);
      expect(streamLogs(events, "error")[0].fields?.issues).toEqual([
        expect.objectContaining({
          message: "This event is not declared (tick, done)",
          path: "",
        }),
      ]);
    });
  }

  it("H39 an undeclared event: warn sends it and reports it without its name; error cuts at it", async () => {
    for (const mode of ["warn", "error"] as const) {
      const { get, events } = await sseRoute(mode, "zod", [
        'event: tick\ndata: {"n":1}\n\n',
        "event: LEAKname\ndata: {}\n\n",
      ]);
      const read = await drain(await get("/x"));
      expect(read.end).toBe(mode === "error" ? "error" : "done");
      await until(() => streamLogs(events, mode).length === 1);
      const text = JSON.stringify(events);
      expect(text).toContain("This event is not declared");
      expect(text).not.toContain("LEAK");
    }
  });

  it("a null event carries no data: data on it is a mismatch, its path the event's data", async () => {
    const { get, events } = await sseRoute("error", "zod", [
      "event: done\ndata: \n\n",
      "event: done\ndata: LEAK\n\n",
    ]);
    const read = await drain(await get("/x"));
    expect(read).toMatchObject({
      end: "error",
      text: "event: done\ndata: \n\n",
    });
    await until(() => streamLogs(events, "error").length === 1);
    expect(streamLogs(events, "error")[0].fields?.issues).toEqual([
      expect.objectContaining({
        path: "done.data",
        message: "No data is declared for this event",
      }),
    ]);
  });

  it("an event's data issue is located at <event>.data.<path>", async () => {
    const { get, events } = await sseRoute("error", "zod", [
      'event: tick\ndata: {"n":"x"}\n\n',
    ]);
    // The first write is the opening: refused before anything went out
    // (with no error handler, router.fetch() rejects with the refusal).
    await expect(get("/x")).rejects.toBeInstanceOf(ResponseValidationError);
    void events;
    const second = await sseRoute("error", "zod", [
      'event: tick\ndata: {"n":1}\n\n',
      'event: tick\ndata: {"n":"x"}\n\n',
    ]);
    const read = await drain(await second.get("/x"));
    expect((read.error as ResponseValidationError).issues).toEqual([
      expect.objectContaining({
        path: "tick.data.n",
        mediaType: "text/event-stream",
      }),
    ]);
  });

  it("Q-C13 data: 'text' hands the schema the string; the default 'json' parses it", async () => {
    const route = (data: "json" | "text" | undefined) =>
      serve("router.fetch()", "error", (router) => {
        router.get(
          "/x",
          validate(
            {},
            {
              responses: {
                200: {
                  content: {
                    "text/event-stream": sse(
                      { id: z.string() },
                      data === undefined ? undefined : { data },
                    ),
                  },
                },
              },
            },
          ),
          async (_req, res) => {
            res.set("Content-Type", "text/event-stream");
            res.write(": open\n\n");
            res.write("event: id\ndata: 123\n\n");
            await res.end();
          },
        );
      });
    const text = await route("text");
    expect((await drain(await text.get("/x"))).end).toBe("done");
    // Negative control: as JSON, "123" is the number 123, which z.string() refuses.
    const json = await route(undefined);
    expect((await drain(await json.get("/x"))).end).toBe("error");
    const explicit = await route("json");
    expect((await drain(await explicit.get("/x"))).end).toBe("error");
  });

  it("data that is not JSON under data: 'json' is a mismatch", async () => {
    const { get, events } = await sseRoute("error", "zod", [
      'event: tick\ndata: {"n":1}\n\n',
      "event: tick\ndata: LEAK{\n\n",
    ]);
    const read = await drain(await get("/x"));
    expect(read.end).toBe("error");
    await until(() => streamLogs(events, "error").length === 1);
    expect(JSON.stringify(events)).toContain(
      "The event's data is not valid JSON",
    );
    expect(JSON.stringify(events)).not.toContain("LEAK");
  });

  it("an SSE body piped from a ReadableStream is checked per event too", async () => {
    const { get } = await serve("router.fetch()", "error", (router) => {
      router.get(
        "/x",
        validate(
          {},
          {
            responses: {
              200: {
                content: { "text/event-stream": sse({ tick: TICK_ZOD }) },
              },
            },
          },
        ),
        (_req, res) => {
          res.set("Content-Type", "text/event-stream");
          const queue = [
            'event: tick\ndata: {"n":1}\n\n',
            "event: tick\ndata: {}\n\n",
          ];
          res.send(
            new ReadableStream({
              async pull(controller) {
                await Bun.sleep(GAP);
                const next = queue.shift();
                if (next === undefined) controller.close();
                else controller.enqueue(encoder.encode(next));
              },
            }),
          );
        },
      );
    });
    const read = await drain(await get("/x"));
    expect(read).toMatchObject({
      end: "error",
      text: 'event: tick\ndata: {"n":1}\n\n',
    });
  });

  it("an event the stream ends in the middle of is not checked (a client never dispatches it)", async () => {
    const { get } = await sseRoute("error", "zod", [
      'event: tick\ndata: {"n":1}\n\n',
      "event: LEAK\ndata: {",
    ]);
    expect((await drain(await get("/x"))).end).toBe("done");
  });

  it("SseFramer: the same events whatever the chunking (CRLF, CR, LF; comments; id-only blocks)", () => {
    const text =
      ": hi\r\nid: 1\r\n\r\nevent: a\rdata: x\r\rdata: 1\ndata: 2\n\nevent:\ndata: m\n\nevent: b\n\ndata: y\r\ndata: z\r\n\r\nevent: c\ndata";
    const whole = new SseFramer().push(text);
    const framer = new SseFramer();
    const split = [...text].flatMap((ch) => framer.push(ch));
    expect(split).toEqual(whole);
    expect(whole).toEqual([
      { name: "a", data: "x" },
      { name: "message", data: "1\n2" },
      { name: "message", data: "m" },
      { name: "b", data: undefined },
      { name: "message", data: "y\nz" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// A stream against a whole-body schema (H40, Q-H4)
// ---------------------------------------------------------------------------

describe("H40 a stream against a whole-body schema is never buffered (Q-H4)", () => {
  const unread = (events: LogEvent[]) =>
    events.filter((e) =>
      e.message.includes("is not checked against a whole-body schema"),
    );

  for (const [name, , produce] of KINDS) {
    it(`${name}: sent whole under error, one warning per route`, async () => {
      let validated = 0;
      const whole = z.string().refine(() => {
        validated++;
        return false;
      });
      const { get, events } = await serve(
        "router.fetch()",
        "error",
        (router) => {
          for (const path of ["/a", "/b"]) {
            router.get(
              path,
              validate(
                {},
                { responses: { 200: { content: { "text/plain": whole } } } },
              ),
              (_req, res) => {
                res.type("text/plain");
                return produce(untyped(res), ["x", "y"]);
              },
            );
          }
        },
      );
      for (const path of ["/a", "/a", "/b"]) {
        expect(await drain(await get(path))).toMatchObject({
          status: 200,
          end: "done",
          text: "xy",
        });
      }
      expect(unread(events)).toHaveLength(2);
      expect(unread(events).map((e) => e.fields?.route)).toEqual(["/a", "/b"]);
      expect(validated).toBe(0);
    });
  }

  it("its status, headers and media type are still checked", async () => {
    const { get } = await serve("router.fetch()", "error", (router) => {
      router.get(
        "/x",
        validate(
          {},
          {
            responses: {
              200: {
                headers: z.object({ "x-a": z.literal("1") }),
                content: { "text/plain": z.string() },
              },
            },
          },
        ),
        (_req, res) => {
          res.type("text/plain").set("x-a", "2");
          res.write("x");
          void res.end();
        },
      );
      router.use(renderRefusal);
    });
    const response = await get("/x");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "ResponseValidationError",
      issues: ["headers.x-a"],
    });
  });
});

// ---------------------------------------------------------------------------
// Buffered bodies under chunks()/sse(): a stream of one chunk
// ---------------------------------------------------------------------------

describe("a buffered body under chunks()/sse() is checked as one chunk", () => {
  async function status(
    contentType: string,
    decl: StandardSchemaV1,
    send: (res: BunResponse) => unknown,
  ) {
    const { get } = await serve("router.fetch()", "error", (router) => {
      router.get(
        "/x",
        validate(
          {},
          { responses: { 200: { content: { [contentType]: decl } } } },
        ),
        (_req, res) => {
          res.type(contentType);
          return send(untyped(res));
        },
      );
      router.use(renderRefusal);
    });
    return (await get("/x")).status;
  }

  it("SSE text: a bad event is a 500, a good one a 200", async () => {
    const decl = sse({ tick: TICK_ZOD });
    expect(
      await status("text/event-stream", decl, (res) =>
        res.send('event: tick\ndata: {"n":"x"}\n\n'),
      ),
    ).toBe(500);
    expect(
      await status("text/event-stream", decl, (res) =>
        res.send('event: tick\ndata: {"n":1}\n\n'),
      ),
    ).toBe(200);
  });

  it("NDJSON bytes: the last line without its \\n is checked", async () => {
    const decl = chunks(ROW, { framing: "ndjson" });
    expect(
      await status("application/x-ndjson", decl, (res) =>
        res.send(encoder.encode('{"n":1}\n{"n":2}')),
      ),
    ).toBe(200);
    expect(
      await status("application/x-ndjson", decl, (res) =>
        res.send(encoder.encode('{"n":1}\n{"n":"x"}')),
      ),
    ).toBe(500);
  });

  it("a json() value is checked as its JSON text", async () => {
    const decl = chunks(z.string().startsWith("{"));
    expect(
      await status("application/json", decl, (res) => res.json({ a: 1 })),
    ).toBe(200);
    expect(await status("application/json", decl, (res) => res.json([1]))).toBe(
      500,
    );
  });

  it("an empty body is a stream of no chunks", async () => {
    expect(
      await status("text/event-stream", sse({ tick: TICK_ZOD }), (res) =>
        res.end(),
      ),
    ).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// opaque()
// ---------------------------------------------------------------------------

describe("opaque(): the media type is declared, the body never read", () => {
  /** A route sending `body` as `image/png`, under `decl`. */
  async function route(
    decl: StandardSchemaV1,
    body: () => unknown,
    type = "image/png",
  ) {
    const { get } = await serve("router.fetch()", "error", (router) => {
      router.get(
        "/x",
        validate(
          {},
          { responses: { 200: { content: { "image/png": decl } } } },
        ),
        (_req, res) => {
          res.type(type);
          return untyped(res).send(body() as never);
        },
      );
      router.use(renderRefusal);
    });
    return get("/x");
  }
  const never = z.custom(() => false);

  it("a Blob is not read; negative control: under a whole-body schema it is", async () => {
    let reads = 0;
    const blob = (): Blob => {
      const b = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
      const read = b.arrayBuffer.bind(b);
      b.arrayBuffer = async () => {
        reads++;
        return read();
      };
      return b;
    };
    const ok = await route(opaque(), blob);
    expect(ok.status).toBe(200);
    expect((await ok.bytes()).length).toBe(3);
    expect(reads).toBe(0);
    expect((await route(never, blob)).status).toBe(500);
    expect(reads).toBe(1);
  });

  it("a passed-through Response is not cloned; negative control: under a whole-body schema it is", async () => {
    let clones = 0;
    const native = (): Response => {
      const r = new Response(new Uint8Array([1]), {
        headers: { "content-type": "image/png" },
      });
      const clone = r.clone.bind(r);
      Object.defineProperty(r, "clone", {
        value: () => {
          clones++;
          return clone();
        },
      });
      return r;
    };
    expect((await route(opaque(), native)).status).toBe(200);
    expect(clones).toBe(0);
    expect((await route(never, native)).status).toBe(500);
    expect(clones).toBeGreaterThan(0);
  });

  it("the media type is still checked", async () => {
    const response = await route(opaque(), () => "text", "text/plain");
    expect(response.status).toBe(500);
  });

  it("a piped stream under opaque() is not wrapped or warned about", async () => {
    const { get, events } = await serve("router.fetch()", "error", (router) => {
      router.get(
        "/x",
        validate(
          {},
          { responses: { 200: { content: { "image/png": opaque() } } } },
        ),
        (_req, res) => {
          res.type("image/png");
          res.write("x");
          void res.end();
        },
      );
    });
    expect((await drain(await get("/x"))).end).toBe("done");
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// opaque(mediaType): the status-level shorthand
// ---------------------------------------------------------------------------

describe("opaque(mediaType): a whole status's spec, exactly the keyed form", () => {
  /** A route sending `body` as `type` under `200: spec`. */
  async function route(
    spec: StandardSchemaV1,
    body: () => unknown,
    type: string,
  ) {
    const { get } = await serve("router.fetch()", "error", (router) => {
      router.get(
        "/x",
        validate({}, { responses: { 200: spec } }),
        (_req, res) => {
          res.type(type);
          return untyped(res).send(body() as never);
        },
      );
      router.use(renderRefusal);
    });
    return get("/x");
  }

  it("checks the media type: the declared one passes, another is refused", async () => {
    const png = () => new Uint8Array([1, 2, 3]);
    const ok = await route(opaque("image/png"), png, "image/png");
    expect(ok.status).toBe(200);
    expect((await ok.bytes()).length).toBe(3);
    const refused = await route(
      opaque("image/png"),
      () => "text",
      "text/plain",
    );
    expect(refused.status).toBe(500);
    expect(await refused.json()).toEqual({
      error: "ResponseValidationError",
      issues: ["body"],
    });
    // Negative control: a bare opaque() at status level is application/json, so image/png fails.
    expect((await route(opaque(), png, "image/png")).status).toBe(500);
  });

  it("wildcards and parameters follow the content-key rules", async () => {
    const bytes = () => new Uint8Array([1]);
    expect((await route(opaque("image/*"), bytes, "image/webp")).status).toBe(
      200,
    );
    expect((await route(opaque("image/*"), bytes, "text/plain")).status).toBe(
      500,
    );
    expect((await route(opaque("*/*"), bytes, "font/woff2")).status).toBe(200);
    expect(
      (
        await route(
          opaque("text/plain; version=0.0.4"),
          () => "# metrics",
          "text/plain; charset=utf-8",
        )
      ).status,
    ).toBe(200);
  });

  it("does not read the body; negative control: a whole-body schema does", async () => {
    let reads = 0;
    const blob = (): Blob => {
      const b = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
      const read = b.arrayBuffer.bind(b);
      b.arrayBuffer = async () => {
        reads++;
        return read();
      };
      return b;
    };
    const ok = await route(opaque("image/png"), blob, "image/png");
    expect(ok.status).toBe(200);
    expect((await ok.bytes()).length).toBe(3);
    expect(reads).toBe(0);
    const never = { content: { "image/png": z.custom(() => false) } };
    const { get } = await serve("router.fetch()", "error", (router) => {
      router.get(
        "/x",
        validate({}, { responses: { 200: never } }),
        (_req, res) => untyped(res).type("image/png").send(blob()),
      );
      router.use(renderRefusal);
    });
    expect((await get("/x")).status).toBe(500);
    expect(reads).toBe(1);
  });

  it("works in commonResponses too", async () => {
    const router = new BunRouter({
      responseValidation: "error",
      logger: createTestLogger().logger,
      commonResponses: { 200: opaque("image/png") },
    });
    // Only routes whose validators declare `responses` are checked.
    router.get("/:t", validate({}, { responses: { 404: null } }), (req, res) =>
      untyped(res)
        .type(req.params.t === "png" ? "image/png" : "text/plain")
        .send("x"),
    );
    router.use(renderRefusal);
    expect((await router.fetch("/png")).status).toBe(200);
    expect((await router.fetch("/txt")).status).toBe(500);
  });

  it("describeContract gives the shorthand exactly the keyed form's rows", () => {
    const rowsOf = (spec: StandardSchemaV1 | object) =>
      describeContract(
        getContract(validate({}, { responses: { 200: spec as never } }))!,
      ).entries.filter((e) => e.side === "outbound");
    const short = rowsOf(opaque("image/png"));
    const keyed = rowsOf({ content: { "image/png": opaque() } });
    expect(short).toHaveLength(1);
    const strip = ({ schema, ...rest }: (typeof short)[number]) => ({
      ...rest,
      schemaKind: (schema as { kind?: unknown } | null)?.kind,
      schemaMedia: (schema as { mediaType?: unknown } | null)?.mediaType,
    });
    expect(short.map(strip)).toEqual(keyed.map(strip));
    expect(short.map(strip)).toEqual([
      {
        side: "outbound",
        keyName: "status",
        key: "200",
        part: "body",
        mediaType: "image/png",
        kind: "opaque",
        encoding: "body",
        vendor: "bun-common/opaque",
        schemaKind: "opaque",
        schemaMedia: undefined,
      },
    ]);
    // Negative control: a bare opaque() at status level is another row.
    expect(rowsOf(opaque()).map((r) => r.mediaType)).toEqual([
      "application/json",
    ]);
  });

  it("carries its media type as written", () => {
    expect(opaque("Image/PNG; q=1").mediaType).toBe("Image/PNG; q=1");
    expect(opaque().mediaType).toBeUndefined();
  });

  it("throws a TypeError for a media type a content key could not be", () => {
    for (const bad of ["png", "*/json", "text/x*", "a/b/c", "", "/png", 5]) {
      expect(() => opaque(bad as never)).toThrow(TypeError);
    }
    expect(() => opaque("png" as never)).toThrow(
      'opaque(): "png" is not a media type (type/subtype, type/* or */*)',
    );
  });

  it("throws a TypeError at declaration inside a content map: the key already names the media type", () => {
    const inMap = (value: unknown) => () =>
      validate(
        {},
        { responses: { 200: { content: { "image/png": value as never } } } },
      );
    expect(inMap(opaque("image/png"))).toThrow(TypeError);
    expect(inMap(opaque("image/png"))).toThrow(
      'responses[200].content["image/png"]: opaque("image/png") names a second media type; inside a content map write opaque(), or declare the status as 200: opaque("image/png")',
    );
    expect(inMap(opaque("image/webp"))).toThrow("names a second media type");
    expect(inMap(opaque())).not.toThrow();
    expect(
      () =>
        new BunRouter({
          commonResponses: {
            200: { content: { "image/png": opaque("image/png") as never } },
          },
        }),
    ).toThrow("names a second media type");
    // The core's media maps refuse it too.
    expect(() =>
      httpTransport.contract({
        outbound: { 200: { body: { "image/png": opaque("image/png") } } },
      } as never),
    ).toThrow("names a second media type");
  });
});

// ---------------------------------------------------------------------------
// sendFile() under a whole-body schema (H17–H18)
// ---------------------------------------------------------------------------

describe("H17–H18 sendFile(): its bytes are read only under a whole-body schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "bun-common-v3b-"));
  const good = join(dir, "good.txt");
  const bad = join(dir, "bad.txt");
  writeFileSync(good, "ok-file");
  writeFileSync(bad, "LEAK-file");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const BODY: Record<Vendor, StandardSchemaV1> = {
    zod: z.string().startsWith("ok"),
    yup: yup.string().matches(/^ok/),
  };

  for (const vendor of VENDORS) {
    for (const mode of MODES) {
      it(`${vendor}, ${mode}`, async () => {
        const { get, events } = await serve(
          "router.fetch()",
          mode,
          (router) => {
            router.get(
              "/:name",
              validate(
                {},
                {
                  responses: {
                    200: { content: { "text/plain": BODY[vendor] } },
                  },
                },
              ),
              (req, res) =>
                res.sendFile(req.params.name === "bad" ? bad : good, {
                  headers: { "Content-Type": "text/plain" },
                }),
            );
            router.use(renderRefusal);
          },
        );
        const okResponse = await get("/good");
        expect(okResponse.status).toBe(200);
        expect(await okResponse.text()).toBe("ok-file");
        const badResponse = await get("/bad");
        if (mode === "error") {
          expect(badResponse.status).toBe(500);
          expect(await badResponse.json()).toEqual({
            error: "ResponseValidationError",
            issues: ["body"],
          });
        } else {
          expect(badResponse.status).toBe(200);
          expect(await badResponse.text()).toBe("LEAK-file");
          if (mode === "warn") {
            await until(() =>
              events.some(
                (e) => e.message === "response does not match its contract",
              ),
            );
          }
        }
        expect(JSON.stringify(events)).not.toContain("LEAK");
      });
    }
  }

  it("a range answer (206) is checked on the bytes it sends", async () => {
    const router = new BunRouter({ responseValidation: "error" });
    router.get(
      "/x",
      validate(
        {},
        {
          responses: {
            206: { content: { "text/plain": z.string().startsWith("ok") } },
          },
        },
      ),
      (_req, res) =>
        res.sendFile(good, { headers: { "Content-Type": "text/plain" } }),
    );
    router.use(renderRefusal);
    const head = await router.fetch({
      url: "/x",
      headers: { range: "bytes=0-1" },
    });
    expect(head.status).toBe(206);
    expect(await head.text()).toBe("ok");
    const tail = await router.fetch({
      url: "/x",
      headers: { range: "bytes=3-6" },
    });
    expect(tail.status).toBe(500);
  });

  it("under opaque() the file is not read: a body no schema would pass is sent", async () => {
    const router = new BunRouter({ responseValidation: "error" });
    router.get(
      "/x",
      validate(
        {},
        { responses: { 200: { content: { "text/plain": opaque() } } } },
      ),
      (_req, res) =>
        res.sendFile(bad, { headers: { "Content-Type": "text/plain" } }),
    );
    const response = await router.fetch("/x");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("LEAK-file");
  });

  it("under chunks() the file is piped through the check, not read whole", async () => {
    const router = new BunRouter({
      responseValidation: "error",
      logger: createTestLogger().logger,
    });
    router.get(
      "/x",
      validate(
        {},
        {
          responses: {
            200: {
              content: { "text/plain": chunks(z.string().startsWith("ok")) },
            },
          },
        },
      ),
      (req, res) =>
        res.sendFile(req.query.f === "bad" ? bad : good, {
          headers: { "Content-Type": "text/plain" },
        }),
    );
    expect(await drain(await router.fetch("/x"))).toMatchObject({
      status: 200,
      end: "done",
      text: "ok-file",
    });
    const cut = await drain(await router.fetch("/x?f=bad"));
    expect(cut).toMatchObject({ status: 200, end: "error", text: "" });
  });
});

// ---------------------------------------------------------------------------
// A media type mapped to null
// ---------------------------------------------------------------------------

describe("a media type mapped to null: that media type, with no body", () => {
  async function status(send: (res: BunResponse) => unknown) {
    const router = new BunRouter({ responseValidation: "error" });
    router.get(
      "/x",
      validate(
        {},
        {
          responses: {
            200: {
              content: { "text/plain": null, "application/json": z.object({}) },
            },
          },
        },
      ),
      (_req, res) => send(untyped(res)),
    );
    router.use(renderRefusal);
    const response = await router.fetch("/x");
    return {
      status: response.status,
      body: response.status === 500 ? await response.json() : undefined,
    };
  }

  it("an empty body of that type passes; a body of it is a mismatch", async () => {
    expect((await status((res) => res.type("text/plain").end())).status).toBe(
      200,
    );
    expect(
      (await status((res) => res.type("text/plain").send(""))).status,
    ).toBe(200);
    expect(await status((res) => res.type("text/plain").send("LEAK"))).toEqual({
      status: 500,
      body: { error: "ResponseValidationError", issues: ["body"] },
    });
    expect(
      (await status((res) => res.type("text/plain").send(new Uint8Array(0))))
        .status,
    ).toBe(200);
    expect(
      (await status((res) => res.type("text/plain").send(new Uint8Array(1))))
        .status,
    ).toBe(500);
  });

  it("an empty body with no Content-Type passes where a media type maps to null", async () => {
    expect((await status((res) => res.end())).status).toBe(200);
  });

  it("negative control: with no null entry, the same empty body is a mismatch", async () => {
    const router = new BunRouter({ responseValidation: "error" });
    router.get(
      "/x",
      validate(
        {},
        {
          responses: { 200: { content: { "application/json": z.object({}) } } },
        },
      ),
      (_req, res) => res.end(),
    );
    router.use(renderRefusal);
    expect((await router.fetch("/x")).status).toBe(500);
  });

  it("a stream of that type is a mismatch", async () => {
    expect(
      (
        await status((res) => {
          res.type("text/plain");
          res.write("x");
        })
      ).status,
    ).toBe(500);
  });

  it("the core: a sender and a receiver take a media map with a null entry", () => {
    const contract = httpTransport.contract({
      outbound: {
        200: { body: { "text/plain": null, "application/json": z.object({}) } },
      },
    });
    const send = createSender(contract, "outbound");
    expect(
      send({ status: 200, body: { mediaType: "text/plain" } } as never),
    ).toEqual({
      status: 200,
      body: { mediaType: "text/plain" },
    });
    const refused = send({
      status: 200,
      body: { mediaType: "text/plain", value: "LEAK" },
    } as never);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toContain(
      "No body is declared for this media type",
    );
    const receive = createReceiver(contract, "outbound");
    expect(
      receive({ status: 200, body: { mediaType: "text/plain" } }),
    ).not.toBeInstanceOf(Error);
    expect(() =>
      httpTransport.contract({
        outbound: { 200: { body: { "text/plain": "x" } } },
      } as never),
    ).toThrow("must be a Standard Schema or null");
  });
});

// ---------------------------------------------------------------------------
// Wildcards, commonResponses
// ---------------------------------------------------------------------------

describe("media keys and commonResponses with stream bodies", () => {
  it("the most specific key wins: text/event-stream's sse() over text/*'s chunks()", async () => {
    const { get } = await serve("router.fetch()", "error", (router) => {
      router.get(
        "/:t",
        validate(
          {},
          {
            responses: {
              200: {
                content: {
                  "text/*": chunks(z.string().max(3)),
                  "text/event-stream": sse({ tick: TICK_ZOD }),
                },
              },
            },
          },
        ),
        async (req, res) => {
          res.type(req.params.t === "sse" ? "text/event-stream" : "text/plain");
          res.write('event: tick\ndata: {"n":1}\n\n');
          await res.end();
        },
      );
      router.use(renderRefusal);
    });
    expect((await drain(await get("/sse"))).end).toBe("done");
    // The same bytes as text/plain fall under text/*: longer than 3, refused.
    expect((await get("/plain")).status).toBe(500);
  });

  it("commonResponses per part: the router's SSE body and the route's headers both apply", async () => {
    const router = new BunRouter({
      responseValidation: "error",
      logger: createTestLogger().logger,
      commonResponses: {
        200: { content: { "text/event-stream": sse({ tick: TICK_ZOD }) } },
      },
    });
    router.get(
      "/:h",
      validate(
        {},
        {
          responses: { 200: { headers: z.object({ "x-a": z.literal("1") }) } },
        },
      ),
      async (req, res) => {
        untyped(res)
          .set("Content-Type", "text/event-stream")
          .set("x-a", req.params.h);
        res.write('event: tick\ndata: {"n":1}\n\n');
        res.write("event: tick\ndata: {}\n\n");
        await res.end();
      },
    );
    router.use(renderRefusal);
    expect(await drain(await router.fetch("/1"))).toMatchObject({
      status: 200,
      end: "error",
      text: 'event: tick\ndata: {"n":1}\n\n',
    });
    expect((await router.fetch("/2")).status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Zero cost
// ---------------------------------------------------------------------------

describe("zero cost: no wrapper and no per-chunk work without a stream schema", () => {
  /** Counts `TransformStream`s built while `run` runs. */
  async function countTransforms(run: () => Promise<void>): Promise<number> {
    const Original = globalThis.TransformStream;
    let built = 0;
    globalThis.TransformStream = class extends Original<unknown, unknown> {
      constructor(...args: ConstructorParameters<typeof TransformStream>) {
        built++;
        super(...args);
      }
    } as typeof TransformStream;
    try {
      await run();
    } finally {
      globalThis.TransformStream = Original;
    }
    return built;
  }

  /** A router with a `/x` route sending a piped stream under `responses`. */
  async function pipedUnder(
    responses: Record<number, unknown> | undefined,
    mode: Mode,
  ) {
    const router = new BunRouter({
      responseValidation: mode,
      logger: createTestLogger().logger,
    });
    let stream: ReadableStream | undefined;
    let res: BunResponse | undefined;
    const handler = (_req: unknown, response: BunResponse) => {
      res = response;
      stream = new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode("x"));
          c.close();
        },
      });
      response.type("text/plain").send(stream);
    };
    if (responses === undefined) router.get("/x", handler as never);
    else
      router.get(
        "/x",
        validate({}, { responses: responses as never }),
        handler as never,
      );
    await (await router.fetch("/x")).text();
    return { body: res!.settledResponse?.body, stream: stream! };
  }

  it("no responses: the piped stream is the committed body itself, no TransformStream", async () => {
    let out: { body: unknown; stream: ReadableStream } | undefined;
    expect(
      await countTransforms(async () => {
        out = await pipedUnder(undefined, "error");
      }),
    ).toBe(0);
    expect(out!.body).toBe(out!.stream);
  });

  it("responses with no stream schema under error: the same body, no TransformStream", async () => {
    for (const responses of [
      { 200: { content: { "text/plain": z.string() } } },
      { 200: { headers: z.object({}) } },
      { 200: { content: { "text/plain": opaque() } } },
    ]) {
      let out: { body: unknown; stream: ReadableStream } | undefined;
      expect(
        await countTransforms(async () => {
          out = await pipedUnder(responses, "error");
        }),
      ).toBe(0);
      expect(out!.body).toBe(out!.stream);
    }
  });

  it("positive control: under chunks() the body is wrapped in one TransformStream", async () => {
    let out: { body: unknown; stream: ReadableStream } | undefined;
    expect(
      await countTransforms(async () => {
        out = await pipedUnder(
          { 200: { content: { "text/plain": chunks(z.string()) } } },
          "error",
        );
      }),
    ).toBe(1);
    expect(out!.body).not.toBe(out!.stream);
  });

  it("off: chunks() installs nothing (the same body)", async () => {
    let out: { body: unknown; stream: ReadableStream } | undefined;
    expect(
      await countTransforms(async () => {
        out = await pipedUnder(
          { 200: { content: { "text/plain": chunks(z.string()) } } },
          "off",
        );
      }),
    ).toBe(0);
    expect(out!.body).toBe(out!.stream);
  });

  it("a write() stream under a gate without a stream schema runs no schema per chunk", async () => {
    let calls = 0;
    const counting = z.string().refine(() => {
      calls++;
      return true;
    });
    for (const responses of [
      { 200: { content: { "text/plain": counting } } },
      { 200: { headers: z.object({}).refine(() => true) } },
    ]) {
      const router = new BunRouter({
        responseValidation: "error",
        logger: createTestLogger().logger,
      });
      router.get("/x", validate({}, { responses }), async (_req, res) => {
        res.type("text/plain");
        for (let i = 0; i < 5; i++) res.write("x");
        await res.end();
      });
      expect(await (await router.fetch("/x")).text()).toBe("xxxxx");
    }
    expect(calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Declarations and the contract (M4)
// ---------------------------------------------------------------------------

describe("chunks(), sse(), opaque(): declarations and contract rows (M4)", () => {
  it("refuse what they cannot check", () => {
    expect(() => chunks({} as never)).toThrow(
      "chunks(): expected a Standard Schema",
    );
    expect(() => chunks(z.string(), { framing: "lines" as never })).toThrow(
      'framing must be "raw" or "ndjson"',
    );
    expect(() => sse("x" as never)).toThrow(
      "sse(): expected an object of event names",
    );
    expect(() => sse({ a: "x" } as never)).toThrow(
      'event "a" must be a Standard Schema or null',
    );
    expect(() => sse({ "a\nb": null })).toThrow("holds a line break");
    expect(() => sse({ a: null }, { data: "xml" as never })).toThrow(
      'data must be "json" or "text"',
    );
    expect(() =>
      validate(
        {},
        { responses: { 200: { content: { "text/plain": "x" as never } } } },
      ),
    ).toThrow("expected a Standard Schema, chunks(), sse(), opaque() or null");
  });

  it("run directly, a stream declaration refuses every value and opaque() accepts any", () => {
    expect(chunks(z.string())["~standard"].validate("x")).toMatchObject({
      issues: [expect.anything()],
    });
    expect(sse({})["~standard"].validate("x")).toMatchObject({
      issues: [expect.anything()],
    });
    expect(opaque()["~standard"].validate(3)).toEqual({ value: 3 });
  });

  it("describeContract: each kind, a null media type, and sse()'s events as nested rows", () => {
    const Tick = z.object({ n: z.number() });
    const Row = z.object({ id: z.string() });
    const middleware = validate(
      {},
      {
        responses: {
          200: {
            content: {
              "text/event-stream": sse({ tick: Tick, done: null }),
              "application/x-ndjson": chunks(Row, { framing: "ndjson" }),
              "image/png": opaque(),
              "text/plain": null,
            },
          },
        },
      },
    );
    const rows = describeContract(getContract(middleware)!).entries.filter(
      (e) => e.side === "outbound",
    );
    expect(rows.map((r) => [r.mediaType, r.kind, r.vendor])).toEqual([
      ["application/x-ndjson", "chunks", "bun-common/chunks"],
      ["image/png", "opaque", "bun-common/opaque"],
      ["text/event-stream", "sse", "bun-common/sse"],
      ["text/plain", "value", undefined],
    ]);
    expect(rows[3].schema).toBeNull();
    expect(rows[0].nested).toBeUndefined();
    expect(rows[2].nested).toEqual([
      {
        side: "outbound",
        keyName: "event",
        key: "done",
        part: "data",
        encoding: "body",
        kind: "value",
        schema: null,
      },
      {
        side: "outbound",
        keyName: "event",
        key: "tick",
        part: "data",
        encoding: "body",
        kind: "value",
        schema: Tick,
        vendor: "zod",
      },
    ]);
    const decl = rows[0].schema as unknown as {
      chunk: unknown;
      framing: string;
    };
    expect(decl.chunk).toBe(Row);
    expect(decl.framing).toBe("ndjson");
  });
});
