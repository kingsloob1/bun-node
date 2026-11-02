/**
 * Timeout against abort (plan §6.1): the call's `timeout` rejects with the
 * client's `TimeoutError`; the caller's own `signal` rejects with its reason,
 * the platform's `AbortError` by default, never a `TimeoutError`. The
 * timeout covers retries and their waits, and the response body's read.
 */
import { describe, expect, it } from "bun:test";
import { ClientError, createClient, TimeoutError } from "../lib/index";

interface Routes {
  "GET /slow": { responses: { 200: { ok: boolean } } };
}

/** A fetch that answers after `ms`, or rejects with the signal's reason when aborted first. */
function slowFetch(ms: number) {
  const signals: AbortSignal[] = [];
  const fetch = (request: Request) =>
    new Promise<Response>((resolve, reject) => {
      signals.push(request.signal);
      if (request.signal.aborted) {
        reject(request.signal.reason as Error);
        return;
      }
      const timer = setTimeout(() => resolve(Response.json({ ok: true })), ms);
      request.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(request.signal.reason as Error);
      });
    });
  return { fetch, signals };
}

describe("timeout", () => {
  it("rejects with TimeoutError, a ClientError carrying the timeout and route key", async () => {
    const server = slowFetch(5_000);
    const started = performance.now();
    const error = await createClient<Routes>({
      fetch: server.fetch,
      timeout: 50,
    })
      .get("/slow")
      .catch((thrown: unknown) => thrown);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toBeInstanceOf(ClientError);
    expect((error as TimeoutError).timeout).toBe(50);
    expect((error as TimeoutError).key).toBe("GET /slow");
    // The request in flight was aborted, not left running.
    expect(server.signals[0].aborted).toBe(true);
  });

  it("is merged call → route → client, and false turns it off", async () => {
    const server = slowFetch(80);
    const api = createClient<Routes>({
      fetch: server.fetch,
      timeout: 20,
      routes: { "GET /slow": { timeout: 30 } },
    });
    await expect(api.get("/slow")).rejects.toMatchObject({
      name: "TimeoutError",
      timeout: 30,
    });
    await expect(api.get("/slow", { timeout: 40 })).rejects.toMatchObject({
      timeout: 40,
    });
    const result = await api.get("/slow", { timeout: false });
    expect(result.ok).toBe(true);
  });

  it("covers retries and the waits between them", async () => {
    let calls = 0;
    const api = createClient<Routes>({
      timeout: 120,
      retry: { baseMs: 1_000, jitter: 0, attempts: 5 },
      fetch: async () => {
        calls++;
        return new Response(null, { status: 503 });
      },
    });
    const started = performance.now();
    await expect(api.get("/slow")).rejects.toBeInstanceOf(TimeoutError);
    await api.get("/slow").catch(() => undefined);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(calls).toBeLessThanOrEqual(2);
  });

  it("covers reading the body", async () => {
    const api = createClient<Routes>({
      timeout: 50,
      fetch: async (request) => {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"ok":'));
            request.signal.addEventListener("abort", () =>
              controller.error(request.signal.reason),
            );
          },
        });
        return new Response(body, {
          headers: { "content-type": "application/json" },
        });
      },
    });
    await expect(api.get("/slow")).rejects.toBeInstanceOf(TimeoutError);
  });

  it("is cleared after the call, so it fires nothing later", async () => {
    const server = slowFetch(1);
    const api = createClient<Routes>({ fetch: server.fetch, timeout: 30 });
    await api.get("/slow");
    await Bun.sleep(60);
    expect(server.signals[0].aborted).toBe(false);
  });
});

describe("abort", () => {
  it("rejects with the platform's AbortError, not a TimeoutError", async () => {
    const server = slowFetch(5_000);
    const controller = new AbortController();
    const call = createClient<Routes>({
      fetch: server.fetch,
      timeout: 2_000,
    }).get("/slow", {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    const error = await call.catch((thrown: unknown) => thrown);
    expect(error).not.toBeInstanceOf(TimeoutError);
    expect(error).not.toBeInstanceOf(ClientError);
    expect((error as DOMException).name).toBe("AbortError");
    expect(error).toBe(controller.signal.reason);
  });

  it("rejects with the caller's own reason when it gives one", async () => {
    const server = slowFetch(5_000);
    const controller = new AbortController();
    const reason = new Error("user left the page");
    const call = createClient<Routes>({ fetch: server.fetch }).get("/slow", {
      signal: controller.signal,
    });
    controller.abort(reason);
    await expect(call).rejects.toBe(reason);
  });

  it("rejects at once for a signal already aborted, sending nothing", async () => {
    let sent = 0;
    const signal = AbortSignal.abort();
    const error = await createClient<Routes>({
      fetch: async () => {
        sent++;
        return Response.json({ ok: true });
      },
    })
      .get("/slow", { signal })
      .catch((thrown: unknown) => thrown);
    expect((error as DOMException).name).toBe("AbortError");
    expect(sent).toBe(0);
  });

  it("stops a retry wait", async () => {
    const controller = new AbortController();
    const api = createClient<Routes>({
      retry: { baseMs: 5_000, jitter: 0 },
      fetch: async () => new Response(null, { status: 503 }),
    });
    const started = performance.now();
    const call = api.get("/slow", { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const error = await call.catch((thrown: unknown) => thrown);
    expect((error as DOMException).name).toBe("AbortError");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("whichever aborted first wins, when both have by the time the call notices", async () => {
    // A middleware that ignores the signal holds the call past both.
    const slow =
      (ms: number) => async (_ctx: unknown, next: () => Promise<Response>) => {
        await Bun.sleep(ms);
        return next();
      };
    const api = createClient<Routes>({
      fetch: async () => Response.json({ ok: true }),
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const callerFirst = await api
      .get("/slow", {
        signal: controller.signal,
        timeout: 30,
        middleware: [slow(80)],
      })
      .catch((thrown: unknown) => thrown);
    expect((callerFirst as DOMException).name).toBe("AbortError");

    const late = new AbortController();
    setTimeout(() => late.abort(), 30);
    const timeoutFirst = await api
      .get("/slow", { signal: late.signal, timeout: 5, middleware: [slow(80)] })
      .catch((thrown: unknown) => thrown);
    expect(timeoutFirst).toBeInstanceOf(TimeoutError);
  });

  it("ends the call even when a custom fetch never looks at the signal", async () => {
    // Settled against a timer, not with `expect(call).rejects`: a call left
    // pending forever (the bug this guards against) hangs `.rejects` and the
    // whole run on Bun 1.4.4-canary instead of failing (oven-sh/bun#45714).
    const within = (call: Promise<unknown>) =>
      Promise.race([
        call.then(
          () => "resolved",
          (thrown: unknown) => thrown,
        ),
        Bun.sleep(1_000).then(() => "still pending"),
      ]);
    const never = () => new Promise<Response>(() => {});

    const timedOut = await within(
      createClient<Routes>({ timeout: 30, fetch: never }).get("/slow"),
    );
    expect(timedOut).toBeInstanceOf(TimeoutError);

    const controller = new AbortController();
    const call = createClient<Routes>({ fetch: never }).get("/slow", {
      signal: controller.signal,
    });
    controller.abort();
    expect(await within(call)).toMatchObject({ name: "AbortError" });
  });
});
