import type {
  FakePlatform,
  FakePlatformState,
  FakeUnit,
} from "../../../lib/provider/testing/index";
import { afterEach, describe, expect, it } from "bun:test";
import { ConfigError } from "../../../lib/index";
import { fakeInternals } from "../../../lib/provider/testing/fake";
import { fakePlatform } from "../../../lib/provider/testing/index";

/**
 * `fakePlatform(routes)` (plugins §12.4): `Bun.serve` on port 0, the unit
 * bookkeeping, the token memory, fault injection and the request log the
 * kit reads.
 */

const platforms: FakePlatform[] = [];
afterEach(async () => {
  for (const platform of platforms.splice(0)) {
    await platform.close();
  }
});

/** A fake with one run route and one echo route, closed after the test. */
async function fake(
  options: Parameters<typeof fakePlatform>[1] = {},
): Promise<{ platform: FakePlatform; seen: FakePlatformState[] }> {
  const seen: FakePlatformState[] = [];
  const platform = await fakePlatform(
    {
      "POST /runs": async (request, state) => {
        seen.push(state);
        const body = (await request.json()) as {
          token?: string;
          args?: string[];
        };
        if (body.token !== undefined) {
          const earlier = state.recall(body.token);
          if (earlier !== undefined) {
            return Response.json({
              deduped: true,
              handles: earlier.map((unit) => unit.handle),
            });
          }
        }
        const unit = state.start({
          argv: body.args ?? [],
          ...(body.token === undefined ? {} : { token: body.token }),
        });
        return Response.json({ handles: [unit.handle] }, { status: 201 });
      },
      "/runs/:handle": (request) => {
        const { params } = request as Request & {
          params: { handle: string };
        };
        return Response.json({ method: request.method, handle: params.handle });
      },
    },
    options,
  );
  platforms.push(platform);
  return { platform, seen };
}

/** Posts a run. */
async function run(
  platform: FakePlatform,
  body: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<Response> {
  return await fetch(`${platform.url}/runs`, {
    method: "POST",
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
}

describe("fakePlatform", () => {
  it("serves its routes on a port of its own, with :params, and answers anything else 404", async () => {
    const { platform } = await fake();
    expect(platform.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(new URL(platform.url).port).not.toBe("0");
    expect(await (await fetch(`${platform.url}/runs/unit-7`)).json()).toEqual({
      method: "GET",
      handle: "unit-7",
    });
    const missing = await fetch(`${platform.url}/nowhere`);
    expect(missing.status).toBe(404);
    // A route with a method answers only that method.
    expect((await fetch(`${platform.url}/runs`)).status).toBe(404);
    const log = fakeInternals(platform).requests;
    expect(
      log.map((record) => [record.method, record.path, record.matched]),
    ).toEqual([
      ["GET", "/runs/unit-7", true],
      ["GET", "/nowhere", false],
      ["GET", "/runs", false],
    ]);
  });

  it("starts units, remembers tokens, and dedupes a remembered one", async () => {
    const { platform } = await fake();
    const first = await (
      await run(platform, { token: "t1", args: ["--a=1"] })
    ).json();
    const again = await (
      await run(platform, { token: "t1", args: ["--a=1"] })
    ).json();
    const other = await (await run(platform, { token: "t2" })).json();
    expect(first).toEqual({ handles: ["unit-1"] });
    expect(again).toEqual({ deduped: true, handles: ["unit-1"] });
    expect(other).toEqual({ handles: ["unit-2"] });
    const units = await platform.units();
    expect(units.map((unit) => [unit.handle, unit.argv, unit.state])).toEqual([
      ["unit-1", ["--a=1"], "pending"],
      ["unit-2", [], "pending"],
    ]);
    expect(fakeInternals(platform).tokens).toEqual([
      "t1",
      "t1",
      "t1",
      "t2",
      "t2",
    ]);
  });

  it("stops and scales units, and counts the live ones", async () => {
    const { platform, seen } = await fake();
    await run(platform);
    const state = seen[0]!;
    expect(state.url).toBe(platform.url);
    expect(state.count).toBe(1);
    expect(state.stop("unit-1")).toBe(true);
    expect(state.stop("unit-404")).toBe(false);
    expect(state.unit("unit-1")?.state).toBe("exited");
    expect(state.count).toBe(0);
    expect(
      state.scale(3, { argv: ["--x"] }).map((unit) => unit.handle),
    ).toEqual(["unit-2", "unit-3", "unit-4"]);
    expect(state.scale(3)).toHaveLength(3);
    expect(state.units).toHaveLength(4);
    expect(state.scale(1).map((unit) => unit.handle)).toEqual(["unit-2"]);
    expect(state.count).toBe(1);
    expect(state.scale(0)).toEqual([]);
  });

  it("hands each unit it starts to the onStart handler, and stops it through the kit", async () => {
    const { platform } = await fake();
    const started: FakeUnit[] = [];
    const stopped: string[] = [];
    platform.onStart((unit) => {
      started.push(unit);
      fakeInternals(platform).mark(unit.handle, "running");
      fakeInternals(platform).onStop(unit.handle, () => {
        stopped.push(unit.handle);
      });
    });
    await run(platform, { args: ["--bun-jobs-summon-id=sm_x"] });
    expect(started.map((unit) => unit.argv)).toEqual([
      ["--bun-jobs-summon-id=sm_x"],
    ]);
    expect((await platform.units())[0]?.state).toBe("running");
    platform.onStart(undefined);
    await run(platform);
    expect(started).toHaveLength(1);
    await platform.close();
    platforms.splice(platforms.indexOf(platform), 1);
    expect(stopped).toEqual(["unit-1"]);
    expect((await platform.units()).map((unit) => unit.state)).toEqual([
      "exited",
      "exited",
    ]);
  });

  it("answers injected faults generically, before the route, for as many calls as asked", async () => {
    const { platform } = await fake();
    const expected: [Parameters<FakePlatform["inject"]>[0], number, string][] =
      [
        ["transient", 503, "ServiceUnavailable"],
        ["throttled", 429, "Throttled"],
        ["quota", 403, "QuotaExceeded"],
        ["auth", 401, "Unauthorized"],
        ["misconfigured", 404, "NotFound"],
        ["conflict", 409, "Conflict"],
      ];
    for (const [fault, status, code] of expected) {
      platform.inject(fault, { retryAfterMs: 2_500 });
      const response = await run(platform);
      expect(response.status, fault).toBe(status);
      expect(
        ((await response.json()) as { error: { code: string } }).error.code,
      ).toBe(code);
      if (fault === "throttled") {
        expect(response.headers.get("retry-after")).toBe("3");
      }
    }
    platform.inject("capacity-200", { times: 2 });
    for (let index = 0; index < 2; index++) {
      const response = await run(platform);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        units: [],
        failures: [{ reason: "capacity" }],
      });
    }
    // Faults never reached a route: nothing started, and the next call does.
    expect(await platform.units()).toEqual([]);
    expect((await run(platform)).status).toBe(201);
    expect(
      fakeInternals(platform).requests.map((record) => record.fault),
    ).toEqual([
      "transient",
      "throttled",
      "quota",
      "auth",
      "misconfigured",
      "conflict",
      "capacity-200",
      "capacity-200",
      undefined,
    ]);
  });

  it("renders a fault the platform's way when given one", async () => {
    const { platform } = await fake({
      faults: {
        throttled: (_request, { retryAfterMs }) =>
          Response.json(
            { __type: "ThrottlingException", wait: retryAfterMs },
            { status: 400 },
          ),
      },
    });
    platform.inject("throttled", { retryAfterMs: 700 });
    const response = await run(platform);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      __type: "ThrottlingException",
      wait: 700,
    });
  });

  it("holds a slow response until the caller aborts, then starts nothing", async () => {
    const { platform } = await fake();
    platform.inject("slow");
    const abort = new AbortController();
    const started = Date.now();
    setTimeout(() => abort.abort(), 200);
    await expect(run(platform, {}, abort.signal)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
    await Bun.sleep(50);
    expect(await platform.units()).toEqual([]);
  });

  it("marks what came through the kit's routing tag", async () => {
    const { platform } = await fake();
    const { tag } = fakeInternals(platform);
    await fetch(`${platform.url}/runs/a`, {
      headers: { [tag.header]: tag.value },
    });
    await fetch(`${platform.url}/runs/b`, {
      headers: { [tag.header]: "forged" },
    });
    await fetch(`${platform.url}/runs/c`);
    const log = fakeInternals(platform).requests;
    expect(log.map((record) => record.routed)).toEqual([true, false, false]);
    // The tag never reaches what the purity check compares.
    expect(log.every((record) => !(tag.header in record.headers))).toBe(true);
  });

  it("keeps its limits, and refuses a malformed route or injection", async () => {
    const { platform } = await fake({ limits: { tokenMaxLength: 36 } });
    expect(platform.limits).toEqual({ tokenMaxLength: 36 });
    expect(() => platform.inject("auth", { times: 0 })).toThrow(ConfigError);
    await expect(
      fakePlatform({ "FETCH /x": () => new Response() }),
    ).rejects.toThrow(ConfigError);
    await expect(
      fakePlatform({ "no-slash": () => new Response() }),
    ).rejects.toThrow(ConfigError);
    await expect(
      fakePlatform({
        "/x": () => new Response(),
        "GET /x": () => new Response(),
      }),
    ).rejects.toThrow(ConfigError);
    expect(() => fakeInternals({} as FakePlatform)).toThrow(ConfigError);
  });
});
