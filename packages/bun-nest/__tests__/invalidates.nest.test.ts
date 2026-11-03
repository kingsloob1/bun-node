/**
 * `@Invalidates` (typed-client plan `nest-typed-routes.md` §4.3, §9.1,
 * PR-N4) over a real Nest app on `BunHttpAdapter` (port 0), with
 * bun-common's `liveInvalidation()` mounted on the adapter first:
 *
 * - **End to end**: bun-client's `live()` refetches an observed query when
 *   another client's call to an `@Invalidates` route succeeds (control:
 *   another user's query is not refetched);
 * - published after success only: a handler that throws publishes nothing,
 *   even when an exception filter answers `200` (control: the same route
 *   with `@Describe({ cache: { invalidates } })` alone is published by the
 *   route source on that `200` — the status rule);
 * - once per success, beside the route source (which leaves the route to
 *   the interceptor);
 * - the templates resolve from the params (a missing param's template
 *   skipped); `@Invalidates()` takes `@Describe`'s; a function of the
 *   `ExecutionContext`; one that throws is logged and publishes nothing;
 * - the document's `x-bun-cache.invalidates` is `@Invalidates`' templates,
 *   beside `@Describe`'s other cache fields, whatever the decorator order;
 * - misuse throws at decoration.
 *
 * `reflect-metadata` is imported last per the import-sort rule.
 */
import type {
  ArgumentsHost,
  ExceptionFilter,
  INestApplication,
} from "@nestjs/common";
import type { RouteManifest } from "@kingsleyweb/bun-client";
import {
  BadRequestException,
  Body,
  Catch,
  Controller,
  Get,
  Module,
  Param,
  Patch,
  Post,
  UseFilters,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { QueryClient } from "@tanstack/query-core";
import { afterEach, describe, expect, it } from "bun:test";
import { createClient } from "@kingsleyweb/bun-client";
import { live, observe, queries } from "@kingsleyweb/bun-client/query";
import { generateOpenApi } from "@kingsleyweb/bun-common/lib/docs";
import { liveContract, liveInvalidation } from "@kingsleyweb/bun-common/live";
import { BunHttpAdapter, Describe, Invalidates } from "../lib";
import "reflect-metadata";

/** Polls `predicate` until true, or fails after `timeoutMs`. */
async function until(predicate: () => boolean, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

interface User {
  id: string;
  name: string;
}

/** The users, and how often each `GET` was served. */
const users = new Map<string, User>();
const hits = new Map<string, number>();

/** Answers any error with `200`, as an app's filter might: what must not publish. */
@Catch()
class OkFilter implements ExceptionFilter {
  catch(_error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<{
      status: (code: number) => { json: (body: unknown) => void };
    }>();
    res.status(200).json({ recovered: true });
  }
}

@Controller("users")
class UsersController {
  @Get(":id")
  @Describe({ cache: { tags: ["user:{id}"] } })
  one(@Param("id") id: string) {
    hits.set(id, (hits.get(id) ?? 0) + 1);
    return users.get(id) ?? { id, name: "?" };
  }

  @Patch(":id")
  @Invalidates("user:{id}", "org:{org}")
  update(@Param("id") id: string, @Body() body: { name: string }) {
    const user = { id, name: body.name };
    users.set(id, user);
    return user;
  }

  @Patch(":id/fail")
  @UseFilters(OkFilter)
  @Invalidates("user:{id}")
  fail() {
    throw new BadRequestException("no");
  }

  @Patch(":id/described-fail")
  @UseFilters(OkFilter)
  @Describe({ cache: { invalidates: ["user:{id}"] } })
  describedFail() {
    throw new BadRequestException("no");
  }

  @Patch(":id/from-doc")
  @Describe({ cache: { tags: ["kept"], invalidates: ["user:{id}"] } })
  @Invalidates()
  fromDoc(@Param("id") id: string) {
    return { id };
  }

  @Post("by-function")
  @Invalidates((context) => [
    `user:${context.switchToHttp().getRequest<{ body: { id: string } }>().body.id}`,
  ])
  byFunction(@Body() body: { id: string }) {
    return body;
  }

  @Post("throwing-function")
  @Invalidates(() => {
    throw new Error("tags unavailable");
  })
  throwingFunction() {
    return { ok: true };
  }

  @Patch(":id/ordered")
  @Describe({ summary: "Ordered", cache: { tags: ["t"], invalidates: ["x"] } })
  @Invalidates("user:{id}")
  ordered(@Param("id") id: string) {
    return { id };
  }
}

@Module({ controllers: [UsersController] })
class AppModule {}

const apps: INestApplication[] = [];
const stops: (() => void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const app of apps.splice(0)) await app.close();
});

/** The app, with `liveInvalidation()` mounted on the adapter before the controllers. */
async function serve() {
  const adapter = new BunHttpAdapter(0);
  const app = await NestFactory.create(AppModule, adapter, { logger: false });
  apps.push(app);
  app.use(
    liveInvalidation(adapter.getInstance(), {
      authorize: (_req, _res, next) => next(),
    }),
  );
  await app.listen(0, "127.0.0.1");
  const port = adapter.getBunServer()?.port ?? 0;
  return {
    adapter,
    http: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}${liveContract.meta.path}`,
  };
}

/** A frame as a raw live client sees it. */
interface Frame {
  type: string;
  id?: string;
  data?: { tags?: string[]; seq?: number };
}

/** A raw live client subscribed to `tags`: its `invalidate` frames' tags, by seq. */
async function subscriber(url: string, tags: string[]) {
  const ws = new WebSocket(url);
  const frames: Frame[] = [];
  ws.onmessage = (event) =>
    void frames.push(JSON.parse(String(event.data)) as Frame);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`${url} did not open`));
  });
  stops.push(() => ws.close());
  ws.send(JSON.stringify({ type: "subscribe", id: "s1", data: { tags } }));
  await until(() => frames.some((frame) => frame.id === "s1"));
  /** The invalidations so far: their seqs, each once, and the tags they named. */
  const invalidations = () => {
    const seen = new Map<number, string[]>();
    for (const frame of frames) {
      if (frame.type !== "invalidate") continue;
      const seq = frame.data?.seq ?? -1;
      seen.set(seq, [...(seen.get(seq) ?? []), ...(frame.data?.tags ?? [])]);
    }
    return [...seen.entries()].map(([seq, hit]) => ({ seq, tags: hit.sort() }));
  };
  return { invalidations };
}

/** A unique id, so the process's shared live hub never mixes two tests' tags. */
let count = 0;
const fresh = () => `${process.pid}-${++count}-${Date.now()}`;

const json = (body: unknown) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("@Invalidates: end to end with bun-client's live()", () => {
  it("refetches an observed query when another client's call succeeds (control: another user's query is not refetched)", async () => {
    const app = await serve();
    const [a, b] = [fresh(), fresh()];
    users.set(a, { id: a, name: "Ada" });
    users.set(b, { id: b, name: "Grace" });

    interface Routes {
      "GET /users/:id": {
        params: { id: string };
        responses: { 200: User };
      };
    }
    const manifest = {
      "GET /users/:id": { statuses: [200], cache: { tags: ["user:{id}"] } },
    } as const satisfies RouteManifest<Routes>;
    const api = createClient<Routes>({ baseUrl: app.http, manifest });
    const q = queries(api, { manifest });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    stops.push(live(api, queryClient));
    stops.push(() => queryClient.clear());
    const one = observe(
      queryClient,
      q.query("/users/:id", { params: { id: a } }) as never,
    );
    const other = observe(
      queryClient,
      q.query("/users/:id", { params: { id: b } }) as never,
    );
    stops.push(
      one.subscribe(() => {}),
      other.subscribe(() => {}),
    );
    await until(() => hits.get(a) === 1 && hits.get(b) === 1);
    await until(
      () =>
        app.adapter
          .getBunServer()
          ?.subscriberCount(`bun-common/live:user:${a}`) === 1,
    );

    // Another client's mutation, outside the query layer.
    const response = await fetch(`${app.http}/users/${a}`, {
      method: "PATCH",
      ...json({ name: "Ada L." }),
    });
    expect(response.status).toBe(200);
    await until(() => hits.get(a) === 2);
    await until(
      () => (one.getSnapshot() as { data?: User }).data?.name === "Ada L.",
    );
    await Bun.sleep(60);
    expect(hits.get(b)).toBe(1);
  });
});

describe("@Invalidates: when it publishes", () => {
  it("publishes once per success, with the params filled in, beside the route source (a template naming a missing param skipped)", async () => {
    const app = await serve();
    const id = fresh();
    const live = await subscriber(app.ws, [`user:${id}`, "org:{org}", "org:"]);
    const response = await fetch(`${app.http}/users/${id}`, {
      method: "PATCH",
      ...json({ name: "x" }),
    });
    expect(response.status).toBe(200);
    await until(() => live.invalidations().length === 1);
    await Bun.sleep(60);
    expect(live.invalidations()).toEqual([
      { seq: live.invalidations()[0]?.seq, tags: [`user:${id}`] },
    ]);
  });

  it("publishes nothing when the handler throws, even when a filter answers 200 (control: @Describe alone is published on that 200)", async () => {
    const app = await serve();
    const id = fresh();
    const live = await subscriber(app.ws, [`user:${id}`]);
    const failed = await fetch(`${app.http}/users/${id}/fail`, {
      method: "PATCH",
    });
    expect(failed.status).toBe(200);
    expect(await failed.json()).toEqual({ recovered: true });
    // Control: the status rule publishes the same recovery.
    const described = await fetch(`${app.http}/users/${id}/described-fail`, {
      method: "PATCH",
    });
    expect(described.status).toBe(200);
    await until(() => live.invalidations().length === 1);
    await Bun.sleep(60);
    expect(live.invalidations().length).toBe(1);
  });

  it("@Invalidates() takes @Describe's templates; a function computes the tags; a throwing function publishes nothing", async () => {
    const app = await serve();
    const [a, b, c] = [fresh(), fresh(), fresh()];
    const live = await subscriber(app.ws, [
      `user:${a}`,
      `user:${b}`,
      `user:${c}`,
    ]);
    await fetch(`${app.http}/users/${a}/from-doc`, { method: "PATCH" });
    await until(() => live.invalidations().length === 1);
    expect(live.invalidations()[0]?.tags).toEqual([`user:${a}`]);

    await fetch(`${app.http}/users/by-function`, {
      method: "POST",
      ...json({ id: b }),
    });
    await until(() => live.invalidations().length === 2);
    expect(live.invalidations()[1]?.tags).toEqual([`user:${b}`]);

    const thrown = await fetch(`${app.http}/users/throwing-function`, {
      method: "POST",
    });
    // The call itself succeeds; only the publish is skipped.
    expect(thrown.status).toBe(201);
    await Bun.sleep(60);
    expect(live.invalidations().length).toBe(2);
  });
});

describe("@Invalidates: the document", () => {
  it("documents the templates as x-bun-cache.invalidates, beside @Describe's other cache fields, whatever the order", async () => {
    const app = await serve();
    const { document } = generateOpenApi(app.adapter.getInstance(), {
      title: "t",
      version: "1",
    });
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    expect(paths["/users/{id}"]?.patch?.["x-bun-cache"]).toEqual({
      invalidates: ["user:{id}", "org:{org}"],
    });
    // @Describe above @Invalidates (applied after it): the templates still win.
    expect(paths["/users/{id}/ordered"]?.patch).toMatchObject({
      summary: "Ordered",
      "x-bun-cache": { tags: ["t"], invalidates: ["user:{id}"] },
    });
    expect(paths["/users/{id}/from-doc"]?.patch?.["x-bun-cache"]).toEqual({
      tags: ["kept"],
      invalidates: ["user:{id}"],
    });
    // The function form documents nothing.
    expect(paths["/users/by-function"]?.post?.["x-bun-cache"]).toBeUndefined();
  });
});

describe("@Invalidates: misuse", () => {
  it("refuses an empty or non-string template, two functions, and an accessor", () => {
    expect(() => Invalidates("")).toThrow(TypeError);
    expect(() => Invalidates("a", 1 as never)).toThrow(TypeError);
    expect(() =>
      (Invalidates as (...tags: unknown[]) => MethodDecorator)(
        () => [],
        () => [],
      ),
    ).toThrow(TypeError);
    expect(() => Invalidates("a")({}, "field", { get: () => 1 })).toThrow(
      /only methods are routes/,
    );
  });
});
