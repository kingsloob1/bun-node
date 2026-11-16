/**
 * `addBeforeWriteHook` with bun-common's contract (bun-node#801): a hook
 * changes headers in place or returns a replacement `Response`, holds or
 * refuses, and does so in phase `"error"` too, which covers the answers the
 * adapter's error handling writes on a response of its own: a middleware's
 * error, a body that cannot be parsed, a phase-`"response"` refusal's
 * fresh answer and the payload guard's `413`. A refusal in phase `"error"`
 * is logged and the answer goes out as the hooks before it left it. The
 * pass and refuse cases the hook always had are `beforeWriteHook.nest.test.ts`'s.
 *
 * `reflect-metadata` is imported last per the import-sort rule. No top-level
 * `await`: it perturbs decorator metadata in other gateway test files.
 */
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type { INestApplication, MiddlewareConsumer } from "@nestjs/common";
import type {
  BunBeforeWriteContext,
  BunBeforeWriteHook,
} from "../lib/BunHttpAdapter";
import { FETCH_STUB_SERVER } from "@kingsleyweb/bun-common";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Module,
  Post,
  Redirect,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import "reflect-metadata";

@Controller("bc")
class ChangeController {
  @Get("json")
  json() {
    return { a: 1 };
  }

  @Get("redirect")
  @Redirect("/target", 302)
  redirect() {}

  @Post("echo")
  @HttpCode(200)
  echo(@Body() body: unknown) {
    return { body };
  }

  @Get("mw/boom")
  boom() {
    return { reached: true };
  }
}

/** A middleware that throws for `/bc/mw/boom`: an error outside Nest's exception zone. */
function throwing(_req: unknown, _res: unknown, _next: () => void): void {
  throw new Error("middleware failed");
}

@Module({ controllers: [ChangeController] })
class ChangeModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(throwing).forRoutes("bc/mw/*path");
  }
}

/** The header every answer gets from the test's hook. */
const MARK = "x-before-write";

/** What the hooks saw, one line per check. */
const seen: string[] = [];

/** What the second hook does to a response; replaced per test. */
let act: (
  context: BunBeforeWriteContext,
) => ReturnType<BunBeforeWriteHook> = () => undefined;

let adapter: BunHttpAdapter;
let app: INestApplication;

beforeAll(async () => {
  adapter = new BunHttpAdapter(0, {
    request: { parseBody: { maxContentLength: 64 } },
  });
  app = await NestFactory.create(ChangeModule, adapter, { logger: false });
  // Middleware on the adapter itself, outside Nest: its error is answered by
  // the adapter's error handling, on a response of its own.
  adapter.use("/bc/raw", () => {
    throw new Error("adapter middleware failed");
  });
  await app.init();
  // First: mark every answer in place, and record what it saw.
  adapter.addBeforeWriteHook((context) => {
    seen.push(`${context.phase} ${context.status}`);
    context.headers.set(MARK, context.phase);
  });
  // Second: whatever the test asks.
  adapter.addBeforeWriteHook((context) => act(context));
});

afterAll(async () => {
  await app.close();
});

/** Fetches with `act` set to `with`, then resets it; the response, its text and what the hooks saw. */
async function fetchWith(
  path: string,
  using: typeof act,
  init?: RequestInit,
): Promise<{ res: Response; text: string; seen: string[] }> {
  act = using;
  seen.length = 0;
  try {
    const res = await adapter.fetch(path, init);
    const text = await res.text();
    return { res, text, seen: [...seen] };
  } finally {
    act = () => undefined;
  }
}

describe("changing headers in place", () => {
  it("a header set in phase response is written", async () => {
    const {
      res,
      text,
      seen: checks,
    } = await fetchWith("/bc/json", () => undefined);
    expect([res.status, res.headers.get(MARK), text]).toEqual([
      200,
      "response",
      '{"a":1}',
    ]);
    expect(checks).toEqual(["response 200"]);
  });

  it("on a redirect too, its Location kept", async () => {
    const { res } = await fetchWith("/bc/redirect", () => undefined, {
      redirect: "manual",
    });
    expect([
      res.status,
      res.headers.get("location"),
      res.headers.get(MARK),
    ]).toEqual([302, "/target", "response"]);
  });
});

describe("replacing the response", () => {
  it("a returned Response is written, and a later hook sees it", async () => {
    const later: string[] = [];
    const remove = adapter.addBeforeWriteHook((context) => {
      later.push(
        `${context.status} ${context.body.kind} ${context.native.headers.get("x-replaced")}`,
      );
    });
    try {
      const { res, text } = await fetchWith("/bc/json", (context) =>
        context.phase === "response"
          ? new Response("replaced", {
              status: 203,
              headers: { "x-replaced": "yes" },
            })
          : undefined,
      );
      expect([res.status, text, res.headers.get("x-replaced")]).toEqual([
        203,
        "replaced",
        "yes",
      ]);
      // The replacement is new, so the first hook's mark is not on it.
      expect(res.headers.get(MARK)).toBeNull();
      expect(later).toEqual(["203 response yes"]);
    } finally {
      remove();
    }
  });

  it("a promise of a Response holds the answer, then replaces it", async () => {
    const { res, text } = await fetchWith("/bc/json", async (context) => {
      if (context.phase !== "response") return undefined;
      await Bun.sleep(10);
      return new Response(context.native.body, {
        status: context.status,
        headers: { "content-type": "application/json", "x-held": "1" },
      });
    });
    // The replacement reused the produced body: it was not cancelled.
    expect([res.status, text, res.headers.get("x-held")]).toEqual([
      200,
      '{"a":1}',
      "1",
    ]);
  });

  it("a refusal after a replacement discards both, and the 500 goes through phase error", async () => {
    let cancelled = false;
    const remove = adapter.addBeforeWriteHook((context) => {
      if (context.phase === "response") throw new Error("refused late");
    });
    try {
      const { res, seen: checks } = await fetchWith("/bc/json", (context) =>
        context.phase === "response"
          ? new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true;
                },
              }),
            )
          : undefined,
      );
      expect([res.status, res.headers.get(MARK)]).toEqual([500, "error"]);
      expect(checks).toEqual(["response 200", "error 500"]);
      expect(cancelled).toBe(true);
    } finally {
      remove();
    }
  });

  it("anything but a Response or nothing is a refusal with a TypeError, as in bun-common", async () => {
    const { res } = await fetchWith(
      "/bc/json",
      () => true as unknown as undefined,
    );
    expect(res.status).toBe(500);
    // Held, the same: a promise of a non-Response refuses too.
    const held = await fetchWith(
      "/bc/json",
      () => Promise.resolve(7) as unknown as Promise<undefined>,
    );
    expect(held.res.status).toBe(500);
    // Control: returning nothing passes.
    const passed = await fetchWith("/bc/json", () => undefined);
    expect([passed.res.status, passed.text]).toEqual([200, '{"a":1}']);
  });
});

describe('phase "error": the answers the error handling writes', () => {
  it("a header set by a hook reaches the answer to an error in adapter middleware", async () => {
    const { res, seen: checks } = await fetchWith("/bc/raw", () => undefined);
    expect([res.status, res.headers.get(MARK)]).toEqual([500, "error"]);
    expect(checks).toEqual(["error 500"]);
  });

  it("and to an error in Nest middleware, which Nest's exception layer answers on the request's response", async () => {
    const { res, seen: checks } = await fetchWith(
      "/bc/mw/boom",
      () => undefined,
    );
    expect([res.status, res.headers.get(MARK)]).toEqual([500, "response"]);
    expect(checks).toEqual(["response 500"]);
  });

  it("and a body that cannot be parsed's answer", async () => {
    const { res, seen: checks } = await fetchWith("/bc/echo", () => undefined, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a":',
    });
    expect([res.status, res.headers.get(MARK)]).toEqual([400, "error"]);
    expect(checks).toEqual(["error 400"]);
  });

  it("and the payload guard's 413", async () => {
    const { res, seen: checks } = await fetchWith(
      "/bc/echo",
      (context) => {
        // The request is there to read, as in every phase-error check.
        expect(context.request.path).toBe("/bc/echo");
        return undefined;
      },
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pad: "x".repeat(200) }),
      },
    );
    expect([res.status, res.headers.get(MARK)]).toEqual([413, "error"]);
    expect(checks).toEqual(["error 413"]);
  });

  it("and a phase-response refusal's fresh answer", async () => {
    const { res, seen: checks } = await fetchWith("/bc/json", (context) => {
      if (context.phase === "response") throw new Error("no");
    });
    expect([res.status, res.headers.get(MARK)]).toEqual([500, "error"]);
    expect(checks).toEqual(["response 200", "error 500"]);
  });

  it("a replacement there is written: a scrubbed body", async () => {
    const { res, text } = await fetchWith("/bc/raw", (context) =>
      context.phase === "error" && context.status >= 500
        ? new Response("scrubbed", {
            status: context.status,
            headers: context.headers,
          })
        : undefined,
    );
    expect([res.status, text, res.headers.get(MARK)]).toEqual([
      500,
      "scrubbed",
      "error",
    ]);
  });

  it("a refusal there is logged, and the answer sent as the hooks before it left it", async () => {
    const logged = spyOn(Logger.prototype, "error").mockImplementation(
      () => undefined,
    );
    try {
      const { res } = await fetchWith("/bc/raw", (context) => {
        if (context.phase === "error") throw new Error("still no");
      });
      // The first hook's mark stays; the refusal changes nothing else.
      expect([res.status, res.headers.get(MARK)]).toEqual([500, "error"]);
      expect(
        logged.mock.calls.some((call) =>
          String(call[0]).includes("refused an error response"),
        ),
      ).toBe(true);
    } finally {
      logged.mockRestore();
    }
  });
});

describe("the synchronous path", () => {
  /** An adapter whose `serveNativeRequest` the test can call. */
  class Exposed extends BunHttpAdapter {
    serve(request: Request) {
      return this.serveNativeRequest(request, FETCH_STUB_SERVER);
    }
  }

  it("a sync hook that sets a header or replaces keeps the answer synchronous", () => {
    const exposed = new Exposed();
    exposed.get("/sync", (_req: BunRequest, res: BunResponse) => {
      res.send("x");
    });
    exposed.addBeforeWriteHook(({ headers }) => {
      headers.set(MARK, "sync");
    });
    const marked = exposed.serve(new Request("http://localhost/sync"));
    expect(marked instanceof Response).toBe(true);
    expect((marked as Response).headers.get(MARK)).toBe("sync");
    const replacement = new Response("other");
    exposed.addBeforeWriteHook(() => replacement);
    expect(exposed.serve(new Request("http://localhost/sync"))).toBe(
      replacement,
    );
  });
});
