/**
 * A fake of "Nimbus", the made-up compute platform `02-queues/custom-provider.ts`
 * writes a provider for: its control API as `fakePlatform()` routes, served on
 * port 0. Not meant to be run alone.
 *
 * What a provider author keeps beside the provider, for its own tests: the
 * routes answer the way the real platform would, and `fakePlatform` adds the
 * units, the dedupe-token memory and `inject()`. Where the platform's error
 * bodies matter, they are rendered here; every other fault gets the kit's
 * generic rendering.
 *
 * - `GET /v1/whoami`: the credentials check `validate()` makes.
 * - `POST /v1/runs`: starts `count` units with `args`, remembering `token`; a
 *   token seen before answers `deduped` with the units it started.
 * - `GET /v1/runs?handles=…`: the units' states.
 * - `POST /v1/runs/cancel`: stops units by handle.
 */
import type { FakePlatform } from "@kingsleyweb/bun-jobs/provider/testing";
import { fakePlatform } from "@kingsleyweb/bun-jobs/provider/testing";

/** What a provider sends to start units. */
export interface RunBody {
  /** The dedupe token: the request's `dedupeKey`. */
  token: string;
  /** The units' arguments: the request's `argv`. */
  args: string[];
  /** How many units to start. */
  count: number;
  /** The platform's cap on a unit's life, in seconds. */
  lifetimeSeconds: number;
}

/** A fake Nimbus, and every start request it was sent. */
export interface NimbusFake {
  /** The fake. */
  platform: FakePlatform;
  /** Every `POST /v1/runs` body that reached its route (a fault answers before it), in order. */
  runs: RunBody[];
}

/** Whether a request carries a bearer token. Any will do: the conformance kit sends a canary. */
function authorised(request: Request): boolean {
  return /^Bearer \S+$/.test(request.headers.get("authorization") ?? "");
}

/** A 401, Nimbus's way. */
function unauthorised(): Response {
  return Response.json(
    { error: { code: "Unauthorized", message: "no token" } },
    { status: 401 },
  );
}

/** Starts a fake Nimbus on port 0. Close it with `platform.close()`. */
export async function nimbusPlatform(): Promise<NimbusFake> {
  const runs: RunBody[] = [];
  const platform = await fakePlatform(
    {
      "GET /v1/whoami": (request) =>
        authorised(request)
          ? Response.json({ account: "nimbus-test" })
          : unauthorised(),
      "POST /v1/runs": async (request, state) => {
        if (!authorised(request)) {
          return unauthorised();
        }
        const body = (await request.json()) as RunBody;
        runs.push(body);
        const earlier = state.recall(body.token);
        if (earlier !== undefined) {
          return Response.json({
            deduped: true,
            handles: earlier.map((unit) => unit.handle),
          });
        }
        const handles = Array.from(
          { length: body.count },
          () => state.start({ argv: body.args, token: body.token }).handle,
        );
        return Response.json({ handles }, { status: 201 });
      },
      "GET /v1/runs": (request, state) => {
        const handles = (new URL(request.url).searchParams.get("handles") ?? "")
          .split(",")
          .filter((handle) => handle !== "");
        return Response.json({
          units: handles.map((handle) => ({
            handle,
            state: state.unit(handle)?.state ?? "unknown",
          })),
        });
      },
      "POST /v1/runs/cancel": async (request, state) => {
        const body = (await request.json()) as { handles: string[] };
        for (const handle of body.handles) {
          state.stop(handle);
        }
        return Response.json({ cancelled: body.handles.length });
      },
    },
    {
      limits: { tokenMaxLength: 64, maxDurationMs: 86_400_000 },
      faults: {
        // A region that does not exist: Nimbus names it with a code.
        misconfigured: () =>
          Response.json(
            {
              error: {
                code: "RegionNotFound",
                message: "no region eu-nowhere-1",
              },
            },
            { status: 404 },
          ),
        // A 502 from the gateway in front of Nimbus, which puts prose where
        // the platform puts a code.
        transient: () =>
          Response.json(
            {
              error: {
                code: "upstream connect error or disconnect/reset before headers",
              },
            },
            { status: 502 },
          ),
      },
    },
  );
  return { platform, runs };
}
