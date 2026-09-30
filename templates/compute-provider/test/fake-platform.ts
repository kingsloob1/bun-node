import type {
  FakePlatform,
  FakePlatformState,
  FakeUnit,
} from "@kingsleyweb/bun-jobs/provider/testing";
import { fakePlatform } from "@kingsleyweb/bun-jobs/provider/testing";

/**
 * A fake of Acme Compute's API, for the conformance kit: the routes the
 * provider calls, and each failure rendered the way Acme renders it, so the
 * provider's error table is tested against Acme's real shapes. `fakePlatform`
 * does the bookkeeping: units, the token memory, fault injection and the
 * request log the kit reads.
 *
 * A fake proves the provider against the fake, never against Acme: keep its
 * status codes and bodies faithful to the platform's documentation.
 */

/** A request to a route with `:name` segments: `fakePlatform` serves with `Bun.serve`'s routes. */
type Routed = Request & {
  /** The path's `:name` segments. */
  params: { pool: string };
};

/** The pools the fake knows. Any other answers 404 `PoolNotFound`. */
export const FAKE_POOLS: readonly string[] = ["workers"];

/** Acme's error body. */
function acmeError(
  status: number,
  code: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error: { code, message: `fake Acme: ${code}` } },
    { status, headers },
  );
}

/** Acme's run states, from the fake's. */
const STATES: Record<FakeUnit["state"], string> = {
  pending: "QUEUED",
  running: "RUNNING",
  exited: "STOPPED",
};

/** What `POST /runs` takes. */
interface RunsBody {
  /** The client token: Acme's dedupe. */
  clientToken: string;
  /** How many runs. */
  count: number;
  /** The runs' arguments. */
  args: string[];
  /** The runs' environment. */
  env?: Record<string, string>;
  /** Acme's per-run cap. */
  maxRuntimeSeconds: number;
}

/** Starts the fake on a free port. Close it after the test. */
export async function acmeFake(): Promise<FakePlatform> {
  /** Each token's request body, to refuse a reuse with different parameters (strict). */
  const bodies = new Map<string, string>();

  /** The route's answer when the request may not proceed: no token, or an unknown pool. */
  const refuse = (request: Request): Response | undefined => {
    if (!/^Bearer \S+$/.test(request.headers.get("authorization") ?? "")) {
      return acmeError(401, "InvalidToken");
    }
    const { pool } = (request as Routed).params;
    return FAKE_POOLS.includes(pool)
      ? undefined
      : acmeError(404, "PoolNotFound");
  };

  const runs = async (
    request: Request,
    state: FakePlatformState,
  ): Promise<Response> => {
    const refused = refuse(request);
    if (refused !== undefined) {
      return refused;
    }
    const text = await request.text();
    const body = JSON.parse(text) as RunsBody;
    if (
      !/^[A-Z0-9-]{1,64}$/i.test(body.clientToken) ||
      !(body.count >= 1 && body.count <= 10) ||
      !(body.maxRuntimeSeconds >= 1 && body.maxRuntimeSeconds <= 86_400)
    ) {
      return acmeError(400, "InvalidParameter");
    }
    const earlier = state.recall(body.clientToken);
    if (earlier !== undefined) {
      return bodies.get(body.clientToken) === text
        ? Response.json({ runs: earlier.map((unit) => ({ id: unit.handle })) })
        : acmeError(409, "TokenReused");
    }
    bodies.set(body.clientToken, text);
    const started = Array.from(
      { length: body.count },
      () =>
        state.start({
          argv: body.args,
          env: body.env ?? {},
          token: body.clientToken,
        }).handle,
    );
    return Response.json(
      { runs: started.map((id) => ({ id })) },
      { status: 201 },
    );
  };

  return await fakePlatform(
    {
      "GET /v1/pools/:pool": (request) =>
        refuse(request) ??
        Response.json({ name: "workers", region: "eu-west" }),
      "POST /v1/pools/:pool/runs": runs,
      "GET /v1/pools/:pool/runs": (request, state) => {
        const ids = (new URL(request.url).searchParams.get("ids") ?? "")
          .split(",")
          .filter((id) => id !== "");
        return (
          refuse(request) ??
          Response.json({
            runs: ids.flatMap((id) => {
              const unit = state.unit(id);
              return unit === undefined
                ? []
                : [{ id, state: STATES[unit.state] }];
            }),
          })
        );
      },
      "POST /v1/pools/:pool/runs/stop": async (request, state) => {
        const refused = refuse(request);
        if (refused !== undefined) {
          return refused;
        }
        const { ids } = (await request.json()) as {
          /** The runs to stop. */
          ids: string[];
        };
        return Response.json({ stopped: ids.filter((id) => state.stop(id)) });
      },
    },
    {
      limits: { tokenMaxLength: 64, maxDurationMs: 86_400_000 },
      // Each failure the kit injects, as Acme sends it.
      faults: {
        transient: () => acmeError(503, "ServiceUnavailable"),
        throttled: (_request, { retryAfterMs }) =>
          acmeError(429, "RateLimited", {
            "retry-after": String(Math.ceil(retryAfterMs / 1_000)),
          }),
        quota: (_request, { retryAfterMs }) =>
          acmeError(429, "QuotaExceeded", {
            "retry-after": String(Math.ceil(retryAfterMs / 1_000)),
          }),
        auth: () => acmeError(401, "InvalidToken"),
        misconfigured: () => acmeError(404, "PoolNotFound"),
        conflict: () => acmeError(409, "TokenReused"),
        "capacity-200": () =>
          Response.json({
            runs: [],
            failures: [{ reason: "InsufficientCapacity" }],
          }),
      },
    },
  );
}
