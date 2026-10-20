/**
 * `BunHttpAdapter.addBeforeWriteHook`: a hook that sees each response before
 * anything of it is written — its final status, its headers as they will be
 * written, its body by kind — and may refuse it (bun-validate's response
 * checks need it for redirects, `StreamableFile`, plain `@Res()` and the
 * headers the adapter adds, which an interceptor's `map()` cannot see).
 *
 * Covered: what the context shows for each kind of response (pass), a
 * refusal through Nest's exception layer and what it drops, an async hold
 * and its timeout, the error phase, `HEAD`, the order of several hooks, and
 * that with no hook registered the response path is the same code.
 */
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type { INestApplication } from "@nestjs/common";
import type {
  BunBeforeWriteBody,
  BunBeforeWriteContext,
  BunBeforeWriteHook,
} from "../lib/BunHttpAdapter";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  FETCH_STUB_SERVER,
  isRequestTimeoutError,
} from "@kingsleyweb/bun-common";
import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  Logger,
  Module,
  Param,
  Redirect,
  Res,
  StreamableFile,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { PUBLIC } from "./expressCompat/app";

/** Tags of the `StreamableFile` sources that closed. */
const closed = new Set<string>();

/** A response object as the routes below use it. */
interface RouteRes {
  status: (code: number) => RouteRes;
  json: (body: unknown) => unknown;
  cookie: (name: string, value: string) => unknown;
  write: (chunk: string) => unknown;
  end: (chunk?: string) => unknown;
  sendFile: (path: string) => unknown;
}

@Controller("bw")
class BeforeWriteController {
  @Get("json")
  json() {
    return { a: 1 };
  }

  @Get("code")
  @HttpCode(202)
  @Header("x-a", "1")
  code() {
    return "accepted";
  }

  @Get("redirect")
  @Redirect("/target", 301)
  redirect() {}

  @Get("file/:tag")
  file(@Param("tag") tag: string) {
    const source = new Readable({
      read() {
        setTimeout(() => this.push("chunk"), 20);
      },
    });
    source.once("close", () => closed.add(tag));
    return new StreamableFile(source, { type: "application/x-test" });
  }

  @Get("raw")
  raw(@Res() res: RouteRes) {
    res.status(206).json({ raw: true });
  }

  @Get("cookie")
  cookie(@Res({ passthrough: true }) res: RouteRes) {
    res.cookie("sid", "secret");
    return { c: 1 };
  }

  @Get("sendfile")
  sendFile(@Res() res: RouteRes) {
    res.sendFile(join(PUBLIC, "a.txt"));
  }

  @Get("stream")
  stream(@Res() res: RouteRes) {
    res.write("a");
    setTimeout(() => res.end("b"), 10);
  }

  @Get("stuck")
  stuck() {
    return new Promise(() => undefined);
  }
}

@Module({ controllers: [BeforeWriteController] })
class BeforeWriteModule {}

/** What one check recorded. */
interface Seen {
  phase: BunBeforeWriteContext["phase"];
  status: number;
  headers: Record<string, string>;
  body: BunBeforeWriteBody;
  hasResponse: boolean;
}

/** Records what `context` shows, reading every field. */
function record(context: BunBeforeWriteContext): Seen {
  return {
    phase: context.phase,
    status: context.status,
    headers: Object.fromEntries(context.headers),
    body: context.body,
    hasResponse: context.response !== undefined,
  };
}

/** An application on a fresh adapter, initialised (driven through `fetch`). */
async function start(
  adapter: BunHttpAdapter,
): Promise<{ adapter: BunHttpAdapter; app: INestApplication }> {
  const app = await NestFactory.create(BeforeWriteModule, adapter, {
    logger: false,
  });
  await app.init();
  return { adapter, app };
}

describe("addBeforeWriteHook: what a passing hook sees", () => {
  let adapter: BunHttpAdapter;
  let app: INestApplication;
  const seen: Seen[] = [];
  const hook: BunBeforeWriteHook = (context) => {
    seen.push(record(context));
  };

  beforeAll(async () => {
    ({ adapter, app } = await start(new BunHttpAdapter(0, { etag: true })));
    adapter.addBeforeWriteHook(hook);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Fetches `path` and returns the one check it caused, and the response. */
  async function check(path: string, init?: RequestInit) {
    seen.length = 0;
    const res = await adapter.fetch(path, init);
    const text = await res.text();
    expect(seen.length).toBe(1);
    return { seen: seen[0], res, text };
  }

  it("a returned object: status, headers, and the raw value as json", async () => {
    const { seen: s, res, text } = await check("/bw/json");
    expect(res.status).toBe(200);
    expect(text).toBe('{"a":1}');
    expect(s.phase).toBe("response");
    expect(s.hasResponse).toBe(true);
    expect(s.status).toBe(200);
    expect(s.headers["content-type"]).toContain("application/json");
    expect(s.body).toEqual({ kind: "json", value: { a: 1 } });
  });

  it("@HttpCode and @Header: the final status and the header", async () => {
    const { seen: s } = await check("/bw/code");
    expect(s.status).toBe(202);
    expect(s.headers["x-a"]).toBe("1");
    expect(s.body).toEqual({ kind: "text", value: "accepted" });
  });

  it("@Redirect: the 3xx, its Location, and the generated text", async () => {
    const { seen: s, res } = await check("/bw/redirect", {
      headers: { accept: "text/plain" },
    });
    expect(res.status).toBe(301);
    expect(s.status).toBe(301);
    expect(s.headers.location).toBe("/target");
    expect(s.body).toEqual({
      kind: "text",
      value: "Moved Permanently. Redirecting to /target",
    });
  });

  it("a StreamableFile: its headers, and the file, unread", async () => {
    seen.length = 0;
    const res = await adapter.fetch("/bw/file/pass");
    expect(seen.length).toBe(1);
    expect(seen[0].status).toBe(200);
    expect(seen[0].headers["content-type"]).toBe("application/x-test");
    expect(seen[0].body.kind).toBe("streamable-file");
    expect(
      (seen[0].body as { file: unknown }).file instanceof StreamableFile,
    ).toBe(true);
    await res.body?.cancel();
  });

  it("plain @Res(): the status and body the handler sent", async () => {
    const { seen: s, res } = await check("/bw/raw");
    expect(res.status).toBe(206);
    expect(s.status).toBe(206);
    expect(s.body).toEqual({ kind: "json", value: { raw: true } });
  });

  it("res.sendFile(): the file as a blob", async () => {
    const { seen: s, text } = await check("/bw/sendfile");
    expect(s.status).toBe(200);
    expect(s.body.kind).toBe("blob");
    const blob = (s.body as { value: Blob }).value;
    // Read again from the blob: what was sent is untouched.
    expect(await blob.text()).toBe(text);
  });

  it("a write() stream: checked as it opens, kind stream", async () => {
    const { seen: s, text } = await check("/bw/stream");
    expect(text).toBe("ab");
    expect(s.status).toBe(200);
    expect(s.body).toEqual({ kind: "stream" });
  });

  it("a freshness 304: empty, with status 304", async () => {
    const first = await check("/bw/json");
    const etag = first.res.headers.get("etag")!;
    expect(etag).toBeTruthy();
    const { seen: s, res } = await check("/bw/json", {
      headers: { "if-none-match": etag },
    });
    expect(res.status).toBe(304);
    expect(s.status).toBe(304);
    expect(s.body).toEqual({ kind: "empty" });
  });

  it("HEAD: checked as the GET it reuses", async () => {
    const { seen: s, res, text } = await check("/bw/json", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(text).toBe("");
    expect(s.status).toBe(200);
    expect(s.headers["content-type"]).toContain("application/json");
    expect(s.body).toEqual({ kind: "json", value: { a: 1 } });
  });

  it("an unknown route: Nest's 404, as the request's own response", async () => {
    const { seen: s, res } = await check("/bw/nope");
    expect(res.status).toBe(404);
    expect(s.phase).toBe("response");
    expect(s.status).toBe(404);
    expect(s.body.kind).toBe("json");
  });
});

describe("addBeforeWriteHook: refusing", () => {
  let adapter: BunHttpAdapter;
  let app: INestApplication;
  let refuse: (context: BunBeforeWriteContext) => void | Promise<void> = () =>
    undefined;
  const phases: string[] = [];

  beforeAll(async () => {
    ({ adapter, app } = await start(new BunHttpAdapter()));
    adapter.addBeforeWriteHook((context) => {
      phases.push(`${context.phase}:${context.status}`);
      return context.phase === "response" ? refuse(context) : undefined;
    });
  });

  afterAll(async () => {
    await app.close();
  });

  /** Fetches `path` with `refuse` set to `with`; the response and phases. */
  async function refused(
    path: string,
    by: (context: BunBeforeWriteContext) => void | Promise<void>,
  ) {
    refuse = by;
    phases.length = 0;
    const res = await adapter.fetch(path);
    const body = await res.text();
    refuse = () => undefined;
    return { res, body, phases: [...phases] };
  }

  it("a throw replaces the response with Nest's 500", async () => {
    const {
      res,
      body,
      phases: p,
    } = await refused("/bw/json", () => {
      throw new Error("does not match its schema");
    });
    expect(res.status).toBe(500);
    expect(JSON.parse(body)).toEqual({
      statusCode: 500,
      message: "Internal server error",
    });
    // The 500 is seen too, in phase "error".
    expect(p).toEqual(["response:200", "error:500"]);
  });

  it("an HttpException is answered with its own status", async () => {
    const { res, body } = await refused("/bw/json", () => {
      throw new HttpException("conflicting", 409);
    });
    expect(res.status).toBe(409);
    expect(JSON.parse(body)).toEqual({
      statusCode: 409,
      message: "conflicting",
    });
  });

  it("a rejected promise refuses as a throw does", async () => {
    const { res } = await refused("/bw/json", async () => {
      await Bun.sleep(1);
      throw new Error("async mismatch");
    });
    expect(res.status).toBe(500);
  });

  it("a refused redirect loses its Location", async () => {
    const { res } = await refused("/bw/redirect", (context) => {
      if (context.status === 301) {
        throw new Error("undeclared redirect");
      }
    });
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("a refused response loses the cookie it set", async () => {
    const { res } = await refused("/bw/cookie", (context) => {
      expect(context.headers.getSetCookie().length).toBe(1);
      throw new Error("cookie without HttpOnly");
    });
    expect(res.status).toBe(500);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("a refused StreamableFile has its source destroyed", async () => {
    const { res } = await refused("/bw/file/refused", () => {
      throw new Error("wrong media type");
    });
    expect(res.status).toBe(500);
    for (let i = 0; i < 100 && !closed.has("refused"); i++) {
      await Bun.sleep(10);
    }
    expect(closed.has("refused")).toBe(true);
  });

  it("a refused write() stream is a clean 500, before any byte", async () => {
    const { res, body } = await refused("/bw/stream", () => {
      throw new Error("bad stream headers");
    });
    expect(res.status).toBe(500);
    expect(JSON.parse(body)).toEqual({
      statusCode: 500,
      message: "Internal server error",
    });
  });

  it("a refusal in phase error is logged, and the response sent", async () => {
    const logged = spyOn(Logger.prototype, "error").mockImplementation(
      () => undefined,
    );
    const remove = adapter.addBeforeWriteHook((context) => {
      if (context.phase === "error") {
        throw new Error("the 500 does not match either");
      }
    });
    try {
      const { res } = await refused("/bw/json", () => {
        throw new Error("mismatch");
      });
      expect(res.status).toBe(500);
      expect(
        logged.mock.calls.some((call) =>
          String(call[0]).includes("refused an error response"),
        ),
      ).toBe(true);
    } finally {
      remove();
      logged.mockRestore();
    }
  });
});

describe("addBeforeWriteHook: a refusal keeps the request-wide headers", () => {
  it("CORS reaches the 500; the refused response's own headers do not", async () => {
    const adapter = new BunHttpAdapter();
    const app = await NestFactory.create(BeforeWriteModule, adapter, {
      logger: false,
      cors: { origin: "https://a.test" },
    });
    await app.init();
    try {
      adapter.addBeforeWriteHook((context) => {
        if (context.phase === "response") {
          throw new Error("refused");
        }
      });
      const res = await adapter.fetch("/bw/redirect", {
        headers: { origin: "https://a.test" },
      });
      expect(res.status).toBe(500);
      expect(res.headers.get("access-control-allow-origin")).toBe(
        "https://a.test",
      );
      expect(res.headers.get("location")).toBeNull();
    } finally {
      await app.close();
    }
  });
});

describe("addBeforeWriteHook: holding for an async check", () => {
  it("holds the response, unwritten, until the check settles", async () => {
    const { adapter, app } = await start(new BunHttpAdapter());
    try {
      const release = Promise.withResolvers<void>();
      adapter.addBeforeWriteHook(() => release.promise);
      let answered = false;
      const pending = adapter.fetch("/bw/json").then((res) => {
        answered = true;
        return res;
      });
      await Bun.sleep(50);
      expect(answered).toBe(false);
      release.resolve();
      const res = await pending;
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"a":1}');
    } finally {
      await app.close();
    }
  });

  it("a hold past requestTimeout is refused as a stuck handler is answered", async () => {
    const { adapter, app } = await start(new BunHttpAdapter(100));
    try {
      const stuckHandler = await adapter.fetch("/bw/stuck");
      const remove = adapter.addBeforeWriteHook(
        () => new Promise<void>(() => undefined),
      );
      const started = Date.now();
      const stuckHook = await adapter.fetch("/bw/json");
      remove();
      expect(Date.now() - started).toBeGreaterThanOrEqual(90);
      expect(stuckHandler.status).toBe(500);
      expect(stuckHook.status).toBe(stuckHandler.status);
      expect(await stuckHook.text()).toBe(await stuckHandler.text());
    } finally {
      await app.close();
    }
  });
});

describe("addBeforeWriteHook: the hold's timeout error", () => {
  /** An adapter recording each error its final error handling is given. */
  class Recording extends BunHttpAdapter {
    readonly errors: unknown[] = [];

    protected override async handleRequestError(
      error: unknown,
    ): Promise<Response> {
      this.errors.push(error);
      return super.handleRequestError(error);
    }
  }

  it("is bun-common's request timeout, which isRequestTimeoutError recognises", async () => {
    const adapter = new Recording(50);
    const { app } = await start(adapter);
    try {
      adapter.addBeforeWriteHook(() => new Promise<void>(() => undefined));
      const res = await adapter.fetch("/bw/json");
      expect(res.status).toBe(500);
      expect(adapter.errors.length).toBe(1);
      const holdTimeoutError = adapter.errors[0];
      expect(isRequestTimeoutError(holdTimeoutError)).toBe(true);
      expect((holdTimeoutError as Error).message).toBe("Request Timedout");
    } finally {
      await app.close();
    }
  });
});

describe("addBeforeWriteHook: several hooks", () => {
  it("run in registration order; the first refusal wins; a remover removes", async () => {
    const { adapter, app } = await start(new BunHttpAdapter());
    try {
      const order: string[] = [];
      const removeA = adapter.addBeforeWriteHook((c) => {
        if (c.phase === "response") order.push("a");
      });
      adapter.addBeforeWriteHook(async (c) => {
        if (c.phase === "response") {
          order.push("b");
          await Bun.sleep(1);
          throw new HttpException("b refuses", 422);
        }
      });
      adapter.addBeforeWriteHook((c) => {
        if (c.phase === "response") order.push("c");
      });
      const res = await adapter.fetch("/bw/json");
      expect(res.status).toBe(422);
      expect(order).toEqual(["a", "b"]);

      order.length = 0;
      removeA();
      removeA();
      await adapter.fetch("/bw/json");
      expect(order).toEqual(["b"]);
    } finally {
      await app.close();
    }
  });
});

describe("addBeforeWriteHook: no hook registered leaves the path unchanged", () => {
  /** An adapter whose `serveNativeRequest` the test can call. */
  class Exposed extends BunHttpAdapter {
    serve(request: Request) {
      return this.serveNativeRequest(request, FETCH_STUB_SERVER);
    }
  }

  function setup() {
    const adapter = new Exposed();
    let sent: BunResponse | undefined;
    adapter.get("/sync", (_req: BunRequest, res: BunResponse) => {
      sent = res;
      res.send("x");
    });
    return { adapter, sent: () => sent };
  }

  it("never registered: the same Response, synchronously", () => {
    const { adapter, sent } = setup();
    const result = adapter.serve(new Request("http://localhost/sync"));
    expect(result instanceof Response).toBe(true);
    expect(result).toBe(sent()!.settledResponse);
  });

  it("registered then removed: the same Response, synchronously", () => {
    const { adapter, sent } = setup();
    adapter.addBeforeWriteHook(() => undefined)();
    const result = adapter.serve(new Request("http://localhost/sync"));
    expect(result instanceof Response).toBe(true);
    expect(result).toBe(sent()!.settledResponse);
  });

  it("a passing sync hook keeps it synchronous too", () => {
    const { adapter, sent } = setup();
    let checks = 0;
    adapter.addBeforeWriteHook(() => {
      checks++;
    });
    const result = adapter.serve(new Request("http://localhost/sync"));
    expect(result instanceof Response).toBe(true);
    expect(result).toBe(sent()!.settledResponse);
    expect(checks).toBe(1);
  });
});
