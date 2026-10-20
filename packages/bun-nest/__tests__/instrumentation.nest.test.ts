/**
 * Instrumentation hooks against `@nestjs/platform-express`: the adapter's
 * `setOnRequestHook` / `setOnResponseHook` (G12 of the Nest 12 parity plan)
 * and Nest's `instrument.instanceDecorator` over `app.use()` middleware,
 * including a 4-argument error middleware, whose arity decides whether the
 * router treats it as an error handler.
 *
 * Each case boots the same application on Express's adapter and on
 * `BunHttpAdapter` and compares what comes back (status and body) and what
 * the hooks recorded: Express's answer is the expectation, measured.
 */
import type { NestApplicationOptions } from "@nestjs/common";
import type { Booted, Configure, Side } from "./expressCompat/app";
import {
  Body,
  Controller,
  Get,
  HttpException,
  Logger,
  Module,
  Param,
  Post,
} from "@nestjs/common";
import { ExpressAdapter } from "@nestjs/platform-express";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { bootBoth, observe } from "./expressCompat/app";

@Controller("i")
class InstrumentedController {
  @Get("missing")
  missing() {
    throw new HttpException("gone", 410);
  }

  @Post("echo")
  echo(@Body() body: unknown) {
    return { body };
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return { id };
  }
}

@Module({ controllers: [InstrumentedController] })
class InstrumentedModule {}

/** A middleware function, as `instrument.instanceDecorator` receives one. */
type Middleware = (...args: unknown[]) => unknown;

/** Any hook these tests register: each is called as its adapter calls it. */
type AnyHook = (...args: never[]) => unknown;

/** The adapter methods these tests call, on either side. */
interface HookedAdapter {
  setOnRequestHook: (hook: AnyHook) => void;
  setOnResponseHook: (hook: AnyHook) => void;
}

/** A request/response shape both adapters' objects satisfy. */
interface HookRes {
  statusCode: number;
  headersSent: boolean;
  setHeader: (name: string, value: string) => unknown;
  status: (code: number) => HookRes;
  json: (body: unknown) => unknown;
}

/**
 * Why the cases that need platform-express 12.1.3's hardened hooks are
 * skipped, if they are: before it, a request hook's rejection is unhandled
 * (the request hangs), `done` is not once-guarded, and a response hook's
 * error is not caught. bun-nest has 12.1.3's rules on every Nest. Read from
 * the reference's `runRequestHook`, which 12.1.3 added, never a version.
 */
const OLD_REFERENCE_HOOKS =
  "runRequestHook" in ExpressAdapter.prototype
    ? undefined
    : "platform-express before 12.1.3 does not guard its hooks";

let booted: Record<Side, Booted> | undefined;

afterEach(async () => {
  await booted?.express.app.close();
  await booted?.bun.app.close();
  booted = undefined;
});

/** Boots both sides with `configure` and returns them. */
async function boot(
  configure: Configure,
  options?: NestApplicationOptions,
): Promise<Record<Side, Booted>> {
  booted = await bootBoth(InstrumentedModule, configure, options);
  return booted;
}

/** `path` on both sides: `{ status, body }` each. */
async function both(path: string) {
  const out = {} as Record<Side, { status: number; body: string }>;
  for (const side of ["express", "bun"] as const) {
    const { status, body } = await observe(booted![side].base, path);
    out[side] = { status, body };
  }
  return out;
}

function hooks(app: Booted["app"]): HookedAdapter {
  return app.getHttpAdapter() as unknown as HookedAdapter;
}

describe("setOnRequestHook, against platform-express", () => {
  it("runs once per request, before the route, and done() continues it", async () => {
    const calls: Record<Side, string[]> = { express: [], bun: [] };
    await boot((app, side) => {
      hooks(app).setOnRequestHook(
        (req: { url: string }, _res: unknown, done: () => void) => {
          calls[side].push(req.url);
          done();
        },
      );
    });
    const answers = await both("/i/7");
    expect(answers.bun).toEqual(answers.express);
    expect(answers.bun).toEqual({ status: 200, body: '{"id":"7"}' });
    expect(calls.bun).toEqual(calls.express);
    expect(calls.bun).toEqual(["/i/7"]);
  });

  it("done(error) sends the error to Nest's exception layer", async () => {
    await boot((app) => {
      hooks(app).setOnRequestHook(
        (_req: unknown, _res: unknown, done: (e?: unknown) => void) => {
          done(new HttpException("hook refused", 403));
        },
      );
    });
    const answers = await both("/i/7");
    expect(answers.bun).toEqual(answers.express);
    expect(answers.bun.status).toBe(403);
  });

  it.skipIf(OLD_REFERENCE_HOOKS !== undefined)(
    "a throw or a rejection before done() is done(error)",
    async () => {
      await boot((app) => {
        hooks(app).setOnRequestHook(async () => {
          throw new HttpException("async refusal", 429);
        });
      });
      const rejected = await both("/i/7");
      expect(rejected.bun).toEqual(rejected.express);
      expect(rejected.bun.status).toBe(429);
    },
  );

  it.skipIf(OLD_REFERENCE_HOOKS !== undefined)(
    "a sync throw before done() is done(error)",
    async () => {
      await boot((app) => {
        hooks(app).setOnRequestHook(() => {
          throw new HttpException("sync refusal", 418);
        });
      });
      const thrown = await both("/i/7");
      expect(thrown.bun).toEqual(thrown.express);
      expect(thrown.bun.status).toBe(418);
    },
  );

  it.skipIf(OLD_REFERENCE_HOOKS !== undefined)(
    "only the first completion counts; a later error is logged",
    async () => {
      const logged = spyOn(Logger.prototype, "error").mockImplementation(
        () => undefined,
      );
      try {
        await boot((app) => {
          hooks(app).setOnRequestHook(
            (_req: unknown, _res: unknown, done: (e?: unknown) => void) => {
              done();
              done(new Error("too late"));
            },
          );
        });
        const answers = await both("/i/7");
        expect(answers.bun).toEqual(answers.express);
        expect(answers.bun.status).toBe(200);
        // Each side logged its late error once.
        expect(logged.mock.calls.length).toBe(2);
      } finally {
        logged.mockRestore();
      }
    },
  );

  it("a hook that answers without done() ends the request", async () => {
    await boot((app) => {
      hooks(app).setOnRequestHook((_req: unknown, res: HookRes) => {
        res.status(401).json({ hook: "answered" });
      });
    });
    const answers = await both("/i/7");
    expect(answers.bun).toEqual(answers.express);
    expect(answers.bun).toEqual({ status: 401, body: '{"hook":"answered"}' });
  });

  it("runs before app.use() middleware", async () => {
    const order: Record<Side, string[]> = { express: [], bun: [] };
    await boot((app, side) => {
      app.use((_req: unknown, _res: unknown, next: () => void) => {
        order[side].push("middleware");
        next();
      });
      hooks(app).setOnRequestHook(
        (_req: unknown, _res: unknown, done: () => void) => {
          order[side].push("hook");
          done();
        },
      );
    });
    await both("/i/1");
    expect(order.bun).toEqual(order.express);
    expect(order.bun).toEqual(["hook", "middleware"]);
  });
});

describe("setOnResponseHook, against platform-express", () => {
  /** Waits until `list` has `n` entries, for at most a second. */
  async function settle(list: unknown[], n: number) {
    for (let i = 0; i < 100 && list.length < n; i++) {
      await Bun.sleep(10);
    }
  }

  it("runs after the response is sent, with its final status", async () => {
    const seen: Record<Side, { status: number; sent: boolean }[]> = {
      express: [],
      bun: [],
    };
    await boot((app, side) => {
      hooks(app).setOnResponseHook((_req: unknown, res: HookRes) => {
        seen[side].push({ status: res.statusCode, sent: res.headersSent });
      });
    });
    const answers = await both("/i/3");
    const failed = await both("/i/missing");
    await settle(seen.express, 2);
    await settle(seen.bun, 2);
    expect(answers.bun).toEqual(answers.express);
    expect(failed.bun).toEqual(failed.express);
    expect(seen.bun).toEqual(seen.express);
    expect(seen.bun).toEqual([
      { status: 200, sent: true },
      { status: 410, sent: true },
    ]);
  });

  it("sees the responses the error handling answers: middleware errors and bad bodies", async () => {
    const seen: Record<Side, number[]> = { express: [], bun: [] };
    await boot((app, side) => {
      app.use(
        (req: { url: string }, _res: unknown, next: (e?: unknown) => void) => {
          next(
            req.url.endsWith("/mw-fails")
              ? new HttpException("middleware refused", 418)
              : undefined,
          );
        },
      );
      hooks(app).setOnResponseHook((_req: unknown, res: HookRes) => {
        seen[side].push(res.statusCode);
      });
    });
    const failedMiddleware = await both("/i/mw-fails");
    const badBody: Record<Side, number> = { express: 0, bun: 0 };
    for (const side of ["express", "bun"] as const) {
      const res = await fetch(`${booted![side].base}/i/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      badBody[side] = res.status;
      await res.text();
    }
    await settle(seen.express, 2);
    await settle(seen.bun, 2);
    expect(failedMiddleware.bun).toEqual(failedMiddleware.express);
    expect(failedMiddleware.bun.status).toBe(418);
    expect(badBody).toEqual({ express: 400, bun: 400 });
    expect(seen.bun).toEqual(seen.express);
    expect(seen.bun).toEqual([418, 400]);
  });

  it.skipIf(OLD_REFERENCE_HOOKS !== undefined)(
    "cannot change the response, and its errors are only logged",
    async () => {
      const logged = spyOn(Logger.prototype, "error").mockImplementation(
        () => undefined,
      );
      const ran: Side[] = [];
      try {
        await boot((app, side) => {
          hooks(app).setOnResponseHook((_req: unknown, res: HookRes) => {
            ran.push(side);
            try {
              res.setHeader("x-too-late", "1");
            } catch {
              // Express throws ERR_HTTP_HEADERS_SENT: either way nothing changes.
            }
            throw new Error("response hook failed");
          });
        });
        const headers: Record<Side, string | null> = {
          express: null,
          bun: null,
        };
        for (const side of ["express", "bun"] as const) {
          const res = await fetch(`${booted![side].base}/i/5`);
          headers[side] = res.headers.get("x-too-late");
          expect(res.status).toBe(200);
          await res.text();
        }
        await settle(ran, 2);
        expect(headers).toEqual({ express: null, bun: null });
        expect(ran.sort()).toEqual(["bun", "express"]);
        for (let i = 0; i < 100 && logged.mock.calls.length < 2; i++) {
          await Bun.sleep(10);
        }
        expect(logged.mock.calls.length).toBe(2);
      } finally {
        logged.mockRestore();
      }
    },
  );
});

describe("instrument.instanceDecorator over app.use(), against platform-express", () => {
  /** Calls each side's decorated middleware made. */
  const calls: Record<Side, string[]> = { express: [], bun: [] };

  /**
   * Boots both sides with a middleware that fails the request and a
   * 4-argument error middleware that answers it, both through `app.use()`,
   * decorated by `decorate`.
   */
  async function bootWith(
    decorate: (fn: Middleware, side: Side) => Middleware,
  ): Promise<void> {
    calls.express = [];
    calls.bun = [];
    let side: Side = "express";
    await boot(
      (app, s) => {
        side = s;
        app.use(
          (
            req: { url: string },
            _res: unknown,
            next: (e?: unknown) => void,
          ) => {
            next(req.url.endsWith("/boom") ? new Error("boom") : undefined);
          },
        );
        app.use(
          (
            err: Error,
            _req: unknown,
            res: HookRes,
            _next: (e?: unknown) => void,
          ) => {
            res.status(418).json({ caught: err.message });
          },
        );
      },
      {
        instrument: {
          instanceDecorator: (instance: unknown) =>
            typeof instance === "function"
              ? decorate(instance as Middleware, side)
              : instance,
        },
      },
    );
  }

  it("a wrapper that keeps the arity keeps an error middleware an error middleware", async () => {
    await bootWith((fn, side) => {
      const wrapped = function (this: unknown, ...args: unknown[]) {
        calls[side].push(`len${fn.length}`);
        return fn.apply(this, args);
      };
      Object.defineProperty(wrapped, "length", { value: fn.length });
      return wrapped;
    });
    const answers = await both("/i/boom");
    expect(answers.bun).toEqual(answers.express);
    expect(answers.bun).toEqual({ status: 418, body: '{"caught":"boom"}' });
    expect(calls.bun).toEqual(calls.express);
    expect(calls.bun).toEqual(["len3", "len4"]);
  });

  it("a wrapper that drops the arity turns it into plain middleware, as on Express", async () => {
    await bootWith((fn, side) => {
      return (...args: unknown[]) => {
        calls[side].push(`len${fn.length}`);
        return fn(...args);
      };
    });
    const failed = await both("/i/boom");
    expect(failed.bun).toEqual(failed.express);
    // The error skips the 0-arity wrapper and reaches Nest's handler.
    expect(failed.bun.status).toBe(500);
    expect(calls.bun).toEqual(calls.express);
    const fine = await both("/i/2");
    expect(fine.bun).toEqual(fine.express);
  });
});
