/**
 * Retries (plan §6.1, §6.2): the default statuses and `"network"`, the
 * idempotent methods, the attempt count, `Retry-After` (seconds and dates,
 * capped at `maxMs`), the backoff between attempts, and the merge of the
 * three configuration levels. A scripted `fetch` answers each attempt and
 * records when it came.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { createClient, NetworkError } from "../lib/index";

interface Routes {
  "GET /thing": { responses: { 200: { n: number }; 503: unknown } };
  "POST /thing": { body: { n: number }; responses: { 201: { n: number } } };
  "PUT /thing": { body: { n: number }; responses: { 200: { n: number } } };
}

/** One scripted answer: a status (with headers), or a thrown network failure. */
type Step =
  number | { status: number; headers?: Record<string, string> } | "network";

/** A fetch that plays `steps` in order (the last repeats), recording each attempt's time. */
function scripted(steps: Step[]) {
  const times: number[] = [];
  const methods: string[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    times.push(performance.now());
    methods.push(request.method);
    const step = steps[Math.min(times.length - 1, steps.length - 1)];
    if (step === "network") throw new TypeError("fetch failed");
    const { status, headers } =
      typeof step === "number" ? { status: step, headers: {} } : step;
    return Response.json({ n: times.length }, { status, headers });
  };
  /** Milliseconds between consecutive attempts. */
  const gaps = () => times.slice(1).map((time, index) => time - times[index]);
  return { fetch, times, methods, gaps };
}

// The default logger is `console`: keep its retry notes out of the test output.
let quiet: { mockRestore: () => void } | undefined;
beforeAll(() => {
  quiet = spyOn(console, "debug").mockImplementation(() => {});
});
afterAll(() => quiet?.mockRestore());

/** A fast schedule: no jitter, so each wait is exact. */
const FAST = { baseMs: 5, maxMs: 1_000, jitter: 0 };

describe("which failures are retried", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    it(`retries a ${status} by default`, async () => {
      const server = scripted([status, 200]);
      const api = createClient<Routes>({ fetch: server.fetch, retry: FAST });
      const result = await api.get("/thing", { undeclaredStatus: "result" });
      expect(result.status).toBe(200);
      expect(server.times.length).toBe(2);
    });
  }

  it("retries a network failure, and throws NetworkError when they run out", async () => {
    const recovers = scripted(["network", 200]);
    const ok = await createClient<Routes>({
      fetch: recovers.fetch,
      retry: FAST,
    }).get("/thing");
    expect(ok.status).toBe(200);
    expect(recovers.times.length).toBe(2);

    const down = scripted(["network"]);
    const error = await createClient<Routes>({ fetch: down.fetch, retry: FAST })
      .get("/thing")
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).cause).toBeInstanceOf(TypeError);
    expect(down.times.length).toBe(3); // the first try and the default two retries
  });

  it("does not retry a status outside `on`, nor a declared 4xx", async () => {
    for (const status of [400, 401, 404, 501]) {
      const server = scripted([status]);
      await createClient<Routes>({ fetch: server.fetch, retry: FAST }).get(
        "/thing",
        { undeclaredStatus: "result" },
      );
      expect({ status, attempts: server.times.length }).toEqual({
        status,
        attempts: 1,
      });
    }
  });

  it("returns the last failure when the attempts run out", async () => {
    const server = scripted([503]);
    const result = await createClient<Routes>({
      fetch: server.fetch,
      retry: { ...FAST, attempts: 3 },
    }).get("/thing");
    expect(result.status).toBe(503);
    expect(server.times.length).toBe(4);
  });

  it("retries the idempotent methods only, by default", async () => {
    const post = scripted([503, 201]);
    const posted = await createClient<Routes>({
      fetch: post.fetch,
      retry: FAST,
    }).post("/thing", {
      body: { n: 1 },
      undeclaredStatus: "result",
    });
    expect(posted.status).toBe(503);
    expect(post.times.length).toBe(1);

    const put = scripted([503, 200]);
    await createClient<Routes>({ fetch: put.fetch, retry: FAST }).put(
      "/thing",
      { body: { n: 1 } },
    );
    expect(put.times.length).toBe(2);

    const opted = scripted([503, 201]);
    const result = await createClient<Routes>({
      fetch: opted.fetch,
      retry: { ...FAST, methods: ["POST"] },
    }).post("/thing", { body: { n: 1 } });
    expect(result.status).toBe(201);
    expect(opted.methods).toEqual(["POST", "POST"]);
  });

  it("re-sends the body on each attempt", async () => {
    const bodies: string[] = [];
    let calls = 0;
    const api = createClient<Routes>({
      retry: FAST,
      fetch: async (request) => {
        bodies.push(await request.text());
        return Response.json({ n: 1 }, { status: ++calls === 1 ? 503 : 200 });
      },
    });
    await api.put("/thing", { body: { n: 7 } });
    expect(bodies).toEqual(['{"n":7}', '{"n":7}']);
  });

  it("never retries a streamed body, which can be sent once", async () => {
    const server = scripted([503, 200]);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x"));
        controller.close();
      },
    });
    await createClient<Routes>({ fetch: server.fetch, retry: FAST }).put(
      "/thing",
      {
        body: body as unknown as { n: number },
        undeclaredStatus: "result",
      },
    );
    expect(server.times.length).toBe(1);
  });
});

describe("Retry-After", () => {
  it("waits the seconds it asks for", async () => {
    const server = scripted([
      { status: 503, headers: { "retry-after": "1" } },
      200,
    ]);
    await createClient<Routes>({
      fetch: server.fetch,
      retry: { ...FAST, maxMs: 10_000 },
    }).get("/thing");
    expect(server.gaps()[0]).toBeGreaterThanOrEqual(990);
  });

  it("reads an HTTP date", async () => {
    const at = new Date(Date.now() + 2_000).toUTCString(); // second precision: 1–2 s away
    const server = scripted([
      { status: 429, headers: { "retry-after": at } },
      200,
    ]);
    await createClient<Routes>({
      fetch: server.fetch,
      retry: { ...FAST, maxMs: 300 },
    }).get("/thing");
    // Capped at maxMs, so the wait is the cap, not the date's 1–2 s.
    expect(server.gaps()[0]).toBeGreaterThanOrEqual(290);
    expect(server.gaps()[0]).toBeLessThan(900);
  });

  it("is capped at maxMs", async () => {
    const server = scripted([
      { status: 503, headers: { "retry-after": "120" } },
      200,
    ]);
    await createClient<Routes>({
      fetch: server.fetch,
      retry: { ...FAST, maxMs: 50 },
    }).get("/thing");
    expect(server.gaps()[0]).toBeGreaterThanOrEqual(45);
    expect(server.gaps()[0]).toBeLessThan(900);
  });

  it("is ignored under respectRetryAfter: false (the backoff runs instead)", async () => {
    const server = scripted([
      { status: 503, headers: { "retry-after": "120" } },
      200,
    ]);
    await createClient<Routes>({
      fetch: server.fetch,
      retry: { ...FAST, maxMs: 5_000, respectRetryAfter: false },
    }).get("/thing");
    expect(server.gaps()[0]).toBeLessThan(500);
  });

  it("an unreadable header falls back to the backoff", async () => {
    const server = scripted([
      { status: 503, headers: { "retry-after": "soon" } },
      200,
    ]);
    await createClient<Routes>({
      fetch: server.fetch,
      retry: { ...FAST, maxMs: 5_000 },
    }).get("/thing");
    expect(server.gaps()[0]).toBeLessThan(500);
  });
});

describe("the backoff between attempts", () => {
  it("doubles from baseMs, capped at maxMs", async () => {
    const server = scripted([503, 503, 503, 503, 200]);
    await createClient<Routes>({
      fetch: server.fetch,
      retry: { baseMs: 40, maxMs: 100, jitter: 0, attempts: 4 },
    }).get("/thing");
    const [first, second, third, fourth] = server.gaps();
    expect(first).toBeGreaterThanOrEqual(38);
    expect(second).toBeGreaterThanOrEqual(78);
    expect(third).toBeGreaterThanOrEqual(98); // 160, capped at 100
    expect(third).toBeLessThan(150);
    expect(fourth).toBeLessThan(150);
  });
});

describe("the levels of `retry` (§6.2)", () => {
  it("merges per key: client, then route, then call", async () => {
    const server = scripted([503]);
    const api = createClient<Routes>({
      fetch: server.fetch,
      retry: { ...FAST, attempts: 5 },
      routes: { "GET /thing": { retry: { attempts: 3 } } },
    });
    await api.get("/thing", { retry: { baseMs: 1 } });
    expect(server.times.length).toBe(4); // the route's 3, the client's other keys
  });

  it("false at any level turns retries off; a later object turns them back on", async () => {
    const off = scripted([503, 200]);
    await createClient<Routes>({ fetch: off.fetch, retry: false }).get(
      "/thing",
    );
    expect(off.times.length).toBe(1);

    const routeOff = scripted([503, 200]);
    await createClient<Routes>({
      fetch: routeOff.fetch,
      retry: FAST,
      routes: { "GET /thing": { retry: false } },
    }).get("/thing");
    expect(routeOff.times.length).toBe(1);

    const callOn = scripted([503, 200]);
    await createClient<Routes>({ fetch: callOn.fetch, retry: false }).get(
      "/thing",
      { retry: FAST },
    );
    expect(callOn.times.length).toBe(2);
  });

  it("logs each retry at debug level", async () => {
    const lines: string[] = [];
    const server = scripted([503, 200]);
    await createClient<Routes>({
      fetch: server.fetch,
      retry: FAST,
      logger: {
        debug: (line: string) => lines.push(line),
        warn: () => {},
        error: () => {},
      },
    }).get("/thing");
    expect(lines).toEqual([
      expect.stringMatching(/^GET \/thing: 503, retry 1 of 2 in \d+ ms$/),
    ]);
  });
});
