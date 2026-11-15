import type { SummonStatusDto } from "@kingsleyweb/bun-jobs/api/contract";
import type { MockReply } from "../mockFetch";
import { describe, expect, it } from "bun:test";
import { createApiClient } from "../../../../app/jobs/api/client";
import { isApiError } from "../../../../app/jobs/api/errors";
import { getSummonStatus } from "../../../../app/jobs/api/summon";
import { expectAbsent } from "../../../harness/assert";
import { problem } from "../fixtures";
import { mockFetch } from "../mockFetch";

/**
 * `getSummonStatus`, the read the queue screen decides the Summon tab with:
 * what it makes of each answer `GET /queues/:queue/summon` can give, from
 * this API and from an older one (issue #786).
 *
 * The API answers a queue with no summoning 200 `{ queue, configured: false
 * }`; bun-jobs 3.2 and earlier answered it 409 `SUMMON_NOT_CONFIGURED` and
 * sent no `configured` on a status. Both read as `null` (no tab), a status
 * from either reads as itself, and every other failure still throws.
 */

/**
 * A status with the fields every answer carries: what the read checks
 * before it hands one to the panel. DOM-free, unlike the panel's fixture.
 */
const STATUS: SummonStatusDto = {
  configured: true,
  queue: "emails",
  local: true,
  inert: false,
  pending: [],
  failures: 0,
};

/** Reads `emails`' summon status over an API whose read answers `reply`. */
async function readWith(reply: MockReply): Promise<unknown> {
  const mock = mockFetch({ "GET /queues/emails/summon": reply });
  const api = createApiClient(
    { apiBase: "/jobs-api", csrfHeader: null },
    { fetch: mock.fetch },
  );
  const status = await getSummonStatus(api, "emails");
  expect(mock.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
    "GET /queues/emails/summon",
  ]);
  return status;
}

/** Awaits a rejection and returns its status and code. */
async function failure(
  promise: Promise<unknown>,
): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (error) {
    if (isApiError(error)) {
      return { status: error.status, code: error.code };
    }
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("getSummonStatus", () => {
  it("reads configured: false as no summoning (null)", async () => {
    expectAbsent(
      await readWith({ body: { queue: "emails", configured: false } }),
      "the status",
    );
  });

  it("reads an older API's 409 SUMMON_NOT_CONFIGURED as no summoning too", async () => {
    expectAbsent(
      await readWith({
        status: 409,
        body: problem(
          409,
          "SUMMON_NOT_CONFIGURED",
          "No summon controller runs here",
        ),
      }),
      "the status",
    );
  });

  it("reads a server without the summon routes (404) as no summoning", async () => {
    expectAbsent(
      await readWith({
        status: 404,
        body: problem(404, "ROUTE_NOT_FOUND", "Route not found"),
      }),
      "the status",
    );
  });

  it("answers a status as itself, with configured: true or, from an older API, without it", async () => {
    expect(await readWith({ body: STATUS })).toEqual(STATUS);
    const { configured: _configured, ...older } = STATUS;
    expect(await readWith({ body: older })).toEqual(older);
  });

  it("still throws every other failure: another 409, a 503, and a body that is no status", async () => {
    // The control: a 409 that is not SUMMON_NOT_CONFIGURED is not "none".
    expect(
      await failure(
        readWith({
          status: 409,
          body: problem(
            409,
            "SUMMON_MARKER_CONTENDED",
            "Other controllers won every write",
          ),
        }),
      ),
    ).toEqual({ status: 409, code: "SUMMON_MARKER_CONTENDED" });
    expect(
      await failure(
        readWith({
          status: 503,
          body: problem(503, "DRIVER_ERROR", "The backend refused"),
        }),
      ),
    ).toEqual({ status: 503, code: "DRIVER_ERROR" });
    // `configured: true` alone is not a status: the screen's error view,
    // never a panel drawn from nothing.
    expect(
      await failure(readWith({ body: { queue: "emails", configured: true } })),
    ).toEqual({ status: 200, code: "UNEXPECTED_RESPONSE" });
  });
});
