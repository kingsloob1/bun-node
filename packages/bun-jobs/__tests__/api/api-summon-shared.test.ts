import type {
  JobsApiAuthorize,
  JobsApiAuthorizeContext,
} from "../../lib/api/config";
import type { JobsApiServerMessage } from "../../lib/api/ws/protocol";
import type {
  SummonEventPayload,
  SummonPolicy,
  SummonRequest,
} from "../../lib/index";
import { join } from "node:path";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import { JOBS_API_ACTIONS } from "../../lib/api/contract/constants";
import { createJobsApi } from "../../lib/api/createJobsApi";
import {
  BunJobs,
  BunQueueWorker,
  defineSummoner,
  ProviderError,
} from "../../lib/index";
import { setReservedState } from "../../lib/queue/windows";
import { queueEvent } from "../../lib/shared/events";
import {
  chargeGroup,
  resolveSummonGroup,
  summonGroupRef,
  summonGroupStateName,
} from "../../lib/summon/group";
import { freshMarker, SUMMON_MARKER } from "../../lib/summon/marker";
import { makeTmpDir, testNamespace, waitFor } from "../helpers";
import { harness, openHarnesses } from "./fixtures";

/**
 * The management API over a shared summon unit that `BunJobs` built
 * (PR-B3b, Q11's minimum): `GET /summon` lists the unit once, under its first
 * queue, with its `queues` and `group`; `GET /queues/{member}/summon` answers
 * the unit's status with its `queues`; the group reset closes the unit's own
 * circuit; and a `summon` event's `eventId`, `queues` and `missing` reach the
 * socket's payload. Responses are validated against their schemas
 * (`validateResponses`), so the new fields are checked there too.
 *
 * Per member (the user's Q4 and Q5, 2026-10-11): a caller who may read only
 * some of a unit's queues sees only those — in `queues`, `queue`, a
 * `partial:` detail, the group's shares and a socket event's `queues` and
 * `missing` — and "summon now" or a reset on one member needs
 * `queues.summon` on every member.
 */

setDefaultTimeout(30_000);

const tmp = await makeTmpDir("bun-jobs-api-summon-shared");
afterAll(async () => {
  await tmp.cleanup();
});

/** Undo steps, run as each case ends, last first. */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const created of openHarnesses) {
    expect(created.mismatches()).toEqual([]);
  }
  openHarnesses.length = 0;
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

const MEDIA = ["renders", "thumbs", "previews"];

/** Every trigger off: only the test runs checks. */
const QUIET: Partial<SummonPolicy> = {
  triggers: { onAdd: false, events: false, poll: false },
  cooldown: 0,
  backoff: { initial: 1, max: 1 },
};

/**
 * A context on SQLite with a shared unit over `MEDIA` and a per-queue
 * controller for `emails`, both summoning through `summoner`.
 */
function context(
  summoner: SummonPolicy["summoner"] = defineSummoner({
    kind: "fake",
    invoke: async () => ({ status: "started", handles: [] }),
  }),
): BunJobs {
  const jobs = new BunJobs({
    namespace: testNamespace("api-summon-shared"),
    driver: { type: "sql", url: `sqlite://${join(tmp.path, "jobs.db")}` },
    logger: noopLogger,
    summon: [
      {
        queues: MEDIA,
        summoner,
        group: { name: "media", unit: "shared" },
        ...QUIET,
      },
      { emails: { summoner, ...QUIET } },
    ],
  });
  cleanups.push(async () => {
    await jobs.purge().catch(() => undefined);
    await jobs.close();
  });
  return jobs;
}

describe("the API over a shared unit", () => {
  it("lists the unit once in GET /summon: under its first queue, with its queues and group", async () => {
    const jobs = context();
    // A per-queue marker a controller left on thumbs before the group was
    // switched to a shared unit: unused now, and not a summoning queue of
    // its own.
    await jobs.queue("thumbs").add("a", {});
    await setReservedState(
      jobs.driver,
      { ns: jobs.namespace, queue: "thumbs" },
      SUMMON_MARKER,
      freshMarker(Date.now()),
      null,
    );
    const h = harness({ jobs });
    const response = await h.call("GET", "/summon");
    expect(response.status).toBe(200);
    const items = response.body.controllers as Record<string, unknown>[];
    expect(items.map((item) => item.queue)).toEqual(["emails", "renders"]);
    const [emails, unit] = items;
    expect(unit).toMatchObject({
      queue: "renders",
      queues: MEDIA,
      group: "media",
      local: true,
      kind: "fake",
    });
    expect(Object.hasOwn(emails!, "queues")).toBe(false);
    expect(Object.hasOwn(emails!, "group")).toBe(false);
  });

  it("answers GET /queues/{member}/summon with the unit's status and its queues", async () => {
    const jobs = context();
    const h = harness({ jobs });
    for (const queue of MEDIA) {
      const response = await h.call("GET", `/queues/${queue}/summon`);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        queue: "renders",
        queues: MEDIA,
        local: true,
        group: { name: "media" },
      });
      expect(Object.hasOwn(response.body, "overlaps")).toBe(false);
    }
    const emails = await h.call("GET", "/queues/emails/summon");
    expect(emails.body.queue).toBe("emails");
    expect(Object.hasOwn(emails.body, "queues")).toBe(false);
  });

  it("closes the unit's own circuit with POST /summon/groups/{group}/reset", async () => {
    let rejecting = true;
    const calls: SummonRequest[] = [];
    const jobs = context(
      defineSummoner({
        kind: "fake",
        invoke: async (request) => {
          calls.push(request);
          if (rejecting) {
            throw new ProviderError("credentials rejected", "auth");
          }
          return { status: "started", handles: [] };
        },
      }),
    );
    await jobs.queue("thumbs").add("a", {});
    const unit = jobs.summonController("thumbs");
    // An `auth` error opens its circuit at once.
    expect(await unit.check()).toMatchObject({ outcome: "failed" });
    const h = harness({ jobs });
    const open = await h.call("GET", "/queues/thumbs/summon");
    expect(open.body.circuitOpenUntil).toBeGreaterThan(Date.now());

    const reset = await h.call("POST", "/summon/groups/media/reset", {
      circuit: true,
    });
    expect(reset.status).toBe(200);
    const closed = await h.call("GET", "/queues/thumbs/summon");
    expect(closed.body.failures).toBe(0);
    expect(Object.hasOwn(closed.body, "circuitOpenUntil")).toBe(false);
    rejecting = false;
    expect(await unit.check()).toMatchObject({ outcome: "started" });
    expect(calls).toHaveLength(2);
  });
});

/** An `authorize` refusing `action` on the queues in `denied`, and recording every call. */
function denying(
  denied: readonly string[],
  action: JobsApiAuthorizeContext["action"] = "queues.read",
): {
  authorize: (req: unknown, context: JobsApiAuthorizeContext) => boolean;
  calls: JobsApiAuthorizeContext[];
} {
  const calls: JobsApiAuthorizeContext[] = [];
  return {
    calls,
    authorize: (_req, context) => {
      calls.push(context);
      return !(
        context.action === action &&
        context.queue !== undefined &&
        denied.includes(context.queue)
      );
    },
  };
}

/** Writes `last` on the unit's state (the group's entry): what a partial registration leaves. */
async function setLast(jobs: BunJobs, detail: string): Promise<void> {
  await jobs.driver.connect();
  const ref = summonGroupRef(jobs.namespace);
  const name = summonGroupStateName("media");
  const stored = await jobs.driver.getQueueState!(ref, name);
  expect(stored).not.toBeNull();
  const value = stored!.value as Record<string, unknown>;
  expect(
    await setReservedState(
      jobs.driver,
      ref,
      name,
      {
        ...value,
        last: {
          id: "sm_partial",
          outcome: "registered",
          at: Date.now(),
          detail,
        },
      },
      stored!.version,
    ),
  ).not.toBeNull();
}

describe("the API over a shared unit, per member (Q4, Q5)", () => {
  it("lists the unit under the first queue the caller may read, naming only those, with the detail rebuilt", async () => {
    const jobs = context();
    await jobs.queue("thumbs").add("a", {});
    await jobs.summonController("thumbs").check();
    await setLast(jobs, "partial:renders,previews");
    const { authorize, calls } = denying(["renders"]);
    const h = harness({ jobs, authorize });
    const response = await h.call("GET", "/summon");
    expect(response.status).toBe(200);
    const unit = (response.body.controllers as Record<string, any>[]).find(
      (item) => item.group === "media",
    )!;
    expect(unit).toMatchObject({
      queue: "thumbs",
      queues: ["thumbs", "previews"],
      last: { detail: "partial:previews" },
    });
    // Every member was asked about, once.
    const asked = calls
      .filter((one) => one.action === "queues.read")
      .map((one) => one.queue)
      .sort();
    expect(asked).toEqual(["emails", "previews", "renders", "thumbs"]);
  });

  it("rebuilds a partial detail naming no readable queue as bare partial", async () => {
    const jobs = context();
    await jobs.queue("thumbs").add("a", {});
    await jobs.summonController("thumbs").check();
    await setLast(jobs, "partial:renders");
    const h = harness({ jobs, authorize: denying(["renders"]).authorize });
    const response = await h.call("GET", "/queues/thumbs/summon");
    expect(response.body.last.detail).toBe("partial");
  });

  it("leaves the unit out when the caller may read none of its queues", async () => {
    const jobs = context();
    const h = harness({ jobs, authorize: denying(MEDIA).authorize });
    const response = await h.call("GET", "/summon");
    expect(
      (response.body.controllers as Record<string, unknown>[]).map(
        (item) => item.queue,
      ),
    ).toEqual(["emails"]);
  });

  it("answers GET /queues/thumbs/summon with no share or name of a queue the caller may not read", async () => {
    const jobs = context();
    await jobs.queue("thumbs").add("a", {});
    // A claim counts a share for every member.
    await jobs.summonController("thumbs").check();
    const h = harness({ jobs, authorize: denying(["renders"]).authorize });
    const response = await h.call("GET", "/queues/thumbs/summon");
    expect(response.status).toBe(200);
    expect(response.body.queue).toBe("thumbs");
    expect(response.body.queues).toEqual(["thumbs", "previews"]);
    expect(Object.keys(response.body.group.queues).sort()).toEqual([
      "previews",
      "thumbs",
    ]);
    // The reset's answer is redacted the same way.
    const reset = await h.call("POST", "/queues/thumbs/summon/reset", {});
    expect(reset.status).toBe(200);
    expect(reset.body.queues).toEqual(["thumbs", "previews"]);
    expect(Object.hasOwn(reset.body.group.queues, "renders")).toBe(false);
  });

  it("answers a member's route with queue the first member the caller may read, not always the one asked about", async () => {
    const jobs = context();
    const all = harness({ jobs });
    const asked = await all.call("GET", "/queues/previews/summon");
    expect(asked.body).toMatchObject({ queue: "renders", queues: MEDIA });
    const some = harness({ jobs, authorize: denying(["renders"]).authorize });
    const answered = await some.call("GET", "/queues/previews/summon");
    expect(answered.body).toMatchObject({
      queue: "thumbs",
      queues: ["thumbs", "previews"],
    });
    // Through an API configured with previews alone, the others are not
    // reachable there, whatever authorize says.
    const configured = harness({ jobs, queues: ["previews"] });
    const one = await configured.call("GET", "/queues/previews/summon");
    expect(one.body).toMatchObject({ queue: "previews", queues: ["previews"] });
  });

  it("lists the unit through an API configured with one of its queues, as that queue", async () => {
    const jobs = context();
    const h = harness({ jobs, queues: ["thumbs"] });
    const response = await h.call("GET", "/summon");
    expect(response.status).toBe(200);
    expect(response.body.controllers).toEqual([
      expect.objectContaining({
        queue: "thumbs",
        queues: ["thumbs"],
        group: "media",
      }),
    ]);
  });

  it("shows GET /summon/groups/media to a caller who may read only thumbs, before any share", async () => {
    const jobs = context();
    // The group's entry exists (a reset writes nothing to clear), but no
    // claim has counted a share: its members are its controller's queues.
    await jobs.driver.connect();
    await setReservedState(
      jobs.driver,
      summonGroupRef(jobs.namespace),
      summonGroupStateName("media"),
      {
        v: 1,
        epoch: "e".repeat(32),
        budget: { hourStart: 0, hour: 0, dayStart: 0, day: 0 },
      },
      null,
    );
    const h = harness({
      jobs,
      authorize: denying(["renders", "previews", "emails"]).authorize,
    });
    const response = await h.call("GET", "/summon/groups/media");
    expect(response.status).toBe(200);
    expect(response.body.name).toBe("media");
  });

  for (const route of [
    "/queues/thumbs/summon",
    "/queues/thumbs/summon/reset",
  ]) {
    it(`refuses POST ${route} when queues.summon is refused on another member, before anything runs (Q5)`, async () => {
      const calls: SummonRequest[] = [];
      const jobs = context(
        defineSummoner({
          kind: "fake",
          invoke: async (request) => {
            calls.push(request);
            return { status: "started", handles: [] };
          },
        }),
      );
      await jobs.queue("thumbs").add("a", {});
      // previews, the first other member in code-point order, refuses.
      const denied = denying(["previews"], "queues.summon");
      const refusing = harness({ jobs, authorize: denied.authorize });
      const refused = await refusing.call("POST", route, {});
      // As POST /summon/groups/{group}/reset answers a refused member: 403
      // FORBIDDEN, naming no queue.
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe("FORBIDDEN");
      expect(refused.text).not.toContain("renders");
      expect(refused.text).not.toContain("previews");
      expect(calls).toHaveLength(0);
      // The route's own queue first, then every other member in code-point
      // order, each asked even after previews' refusal.
      expect(
        denied.calls
          .filter((one) => one.action === "queues.summon")
          .map((one) => one.queue),
      ).toEqual(["thumbs", "previews", "renders"]);
      const allowing = harness({ jobs });
      expect((await allowing.call("POST", route, {})).status).toBe(200);
    });
  }

  it("answers the first refusal in code-point order: 403 for previews before renders' 401", async () => {
    const jobs = context();
    const authorize: JobsApiAuthorize = (_req, context) => {
      if (context.action === "queues.summon" && context.queue === "renders") {
        return { allow: false, status: 401 };
      }
      if (context.action === "queues.summon" && context.queue === "previews") {
        return { allow: false, status: 403 };
      }
      return true;
    };
    const h = harness({ jobs, authorize });
    for (const route of [
      "/queues/thumbs/summon",
      "/queues/thumbs/summon/reset",
    ]) {
      const answer = await h.call("POST", route, {});
      expect([answer.status, answer.body.code]).toEqual([403, "FORBIDDEN"]);
    }
  });

  it("leaves the unit's state as it was after a refused reset", async () => {
    let failing = true;
    const jobs = context(
      defineSummoner({
        kind: "fake",
        invoke: async () => {
          if (failing) {
            throw new Error("down");
          }
          return { status: "started", handles: [] };
        },
      }),
    );
    await jobs.queue("thumbs").add("a", {});
    const unit = jobs.summonController("thumbs");
    expect(await unit.check()).toMatchObject({ outcome: "failed" });
    const before = await unit.status();
    expect(before.failures).toBe(1);
    expect(before.budget?.hour).toBe(1);
    const refusing = harness({
      jobs,
      authorize: denying(["renders"], "queues.summon").authorize,
    });
    const refused = await refusing.call("POST", "/queues/thumbs/summon/reset", {
      budget: true,
    });
    expect(refused.status).toBe(403);
    // The failure and the counts are kept. (The backoff is 1 ms here, so it
    // may simply have run out between the two reads: not compared.)
    const after = await unit.status();
    expect([after.failures, after.budget?.hour, after.budget?.day]).toEqual([
      before.failures,
      before.budget?.hour,
      before.budget?.day,
    ]);
    failing = false;
    const allowed = await harness({ jobs }).call(
      "POST",
      "/queues/thumbs/summon/reset",
      { budget: true },
    );
    expect([allowed.status, allowed.body.failures]).toEqual([200, 0]);
  });

  it("shows only the overlapping groups seen on queues the caller may read", async () => {
    const jobs = context();
    await jobs.driver.connect();
    // Another group's unit on renders, and a third group's on thumbs.
    for (const [queue, group] of [
      ["renders", "secretgrp"],
      ["thumbs", "visiblegrp"],
    ] as const) {
      const worker = new BunQueueWorker(queue, async () => null, {
        namespace: jobs.namespace,
        driver: jobs.driver,
        logger: noopLogger,
        summon: { id: `sm_${group}`, group },
      });
      cleanups.push(async () => await worker.close());
      void worker.run();
      await waitFor(
        async () =>
          (
            await jobs.driver.listWorkers!(
              { ns: jobs.namespace, queue },
              Date.now(),
            )
          ).some((record) => record.id === worker.id),
        { timeout: 5_000 },
      );
    }
    await jobs.summonController("thumbs").check();
    expect((await jobs.summonController("thumbs").status()).overlaps).toEqual([
      "secretgrp",
      "visiblegrp",
    ]);
    const all = harness({ jobs });
    expect(
      (await all.call("GET", "/queues/thumbs/summon")).body.overlaps,
    ).toEqual(["secretgrp", "visiblegrp"]);
    const some = harness({ jobs, authorize: denying(["renders"]).authorize });
    const read = await some.call("GET", "/queues/thumbs/summon");
    expect(read.body.overlaps).toEqual(["visiblegrp"]);
    expect(read.text).not.toContain("secretgrp");
    for (const body of [{}, { budget: true }]) {
      const reset = await some.call(
        "POST",
        "/queues/thumbs/summon/reset",
        body,
      );
      expect(reset.status).toBe(200);
      expect(reset.body.overlaps).toEqual(["visiblegrp"]);
      expect(reset.text).not.toContain("secretgrp");
    }
    // Only renders' group seen, and renders unreadable: no overlaps at all.
    const none = harness({
      jobs,
      authorize: denying(["renders", "thumbs"]).authorize,
    });
    const previews = await none.call("GET", "/queues/previews/summon");
    expect(Object.hasOwn(previews.body, "overlaps")).toBe(false);
  });

  it("labels summon now's demand with the starved queue, and leaves it out for a caller who may not read that queue", async () => {
    // Only previews has work: the reading the check decides on is its.
    const jobs = context();
    await jobs.queue("previews").add("a", {});
    const all = harness({ jobs });
    const shown = await all.call("POST", "/queues/thumbs/summon", {});
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({
      action: "summoned",
      demand: { queue: "previews", waiting: 1 },
    });
    // previews refused `queues.read`, though `queues.summon` on it is
    // allowed: the check runs, and previews' backlog is not shown.
    await jobs.summonController("thumbs").reset();
    const denied = denying(["previews"]);
    const hidden = harness({ jobs, authorize: denied.authorize });
    const answer = await hidden.call("POST", "/queues/thumbs/summon", {
      force: true,
    });
    expect(answer.status).toBe(200);
    expect(answer.body.action).toBeString();
    expect(Object.hasOwn(answer.body, "demand")).toBe(false);
    expect(answer.text).not.toContain("previews");
  });

  /** A partial registration's event, as the unit publishes it on thumbs. */
  const PARTIAL_EVENT: SummonEventPayload = {
    id: "sm_partial",
    outcome: "registered",
    kind: "fake",
    detail: "partial:renders,previews",
    group: "media",
    queues: MEDIA,
    missing: ["renders", "previews"],
    eventId: "0199c0de-0000-7000-8000-000000000001",
  };

  /**
   * The payload a socket subscribed to queue/thumbs receives for
   * {@link PARTIAL_EVENT}, under `authorize`.
   */
  async function socketPayload(
    authorize: (req: unknown, context: JobsApiAuthorizeContext) => boolean,
    channels: readonly string[] = ["queue/thumbs"],
  ): Promise<unknown> {
    const jobs = context();
    const api = createJobsApi({
      jobs,
      basePath: "/admin/jobs",
      logger: noopLogger,
      actions: [...JOBS_API_ACTIONS],
      authorize,
    });
    const adapter = new BunHttpAdapter(0, { logger: noopLogger });
    adapter.use(api.basePath, api.router);
    api.websocket!.attach(adapter);
    const server = await adapter.listen(0);
    cleanups.push(async () => {
      await api.close();
      await adapter.close();
    });
    const frames: JobsApiServerMessage[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/admin/jobs/ws`);
    ws.onmessage = (message) =>
      frames.push(JSON.parse(String(message.data)) as JobsApiServerMessage);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("the upgrade was refused"));
    });
    cleanups.push(async () => ws.close());
    ws.send(JSON.stringify({ op: "subscribe", id: "1", channels }));
    await waitFor(() => frames.some((frame) => frame.type === "ack"), {
      timeout: 5000,
    });
    await jobs.driver.connect();
    await jobs.driver.publish(
      queueEvent(
        {
          ns: jobs.namespace,
          target: "thumbs",
          type: "summon",
          origin: "another-process",
        },
        PARTIAL_EVENT,
      ),
    );
    await waitFor(
      () =>
        frames.some(
          (frame) => frame.type === "event" && frame.event.type === "summon",
        ),
      { timeout: 10_000, message: () => JSON.stringify(frames) },
    );
    const frame = frames.find(
      (one) => one.type === "event" && one.event.type === "summon",
    );
    if (frame?.type !== "event") {
      throw new Error("unreachable");
    }
    return frame.event.payload;
  }

  it("sends a socket event naming only the queues the connection may see", async () => {
    expect(
      await socketPayload(denying(["renders"], "events.subscribe").authorize),
    ).toEqual({
      ...PARTIAL_EVENT,
      detail: "partial:previews",
      queues: ["thumbs", "previews"],
      missing: ["previews"],
    });
  });

  it("drops missing, and bares the detail, when the connection may see none of the missing queues", async () => {
    expect(
      await socketPayload(
        denying(["renders", "previews"], "events.subscribe").authorize,
      ),
    ).toEqual({
      id: "sm_partial",
      outcome: "registered",
      kind: "fake",
      detail: "partial",
      group: "media",
      queues: ["thumbs"],
      eventId: PARTIAL_EVENT.eventId,
    });
  });

  it("shows a queue only when every channel the frame is sent for may see it", async () => {
    // previews is allowed on the broad `queues` channel but not on
    // `queue/thumbs`; the event matches both and goes out as one frame.
    const payload = await socketPayload(
      (_req, context) =>
        context.action !== "events.subscribe" ||
        context.queue === undefined ||
        context.queue === "thumbs" ||
        (context.queue === "previews" && context.channel === "queues"),
      ["queues", "queue/thumbs"],
    );
    expect(payload).toMatchObject({ queues: ["thumbs"], detail: "partial" });
    expect(Object.hasOwn(payload as object, "missing")).toBe(false);
  });

  it("sends the whole event to a connection that may see every queue", async () => {
    expect(await socketPayload(() => true)).toEqual(PARTIAL_EVENT);
  });
});

/** Writes `last` on the unit's state as it is, with any field: the partial a B4 controller leaves. */
async function setLastOutcome(
  jobs: BunJobs,
  last: Record<string, unknown>,
): Promise<void> {
  const ref = summonGroupRef(jobs.namespace);
  const name = summonGroupStateName("media");
  const stored = await jobs.driver.getQueueState!(ref, name);
  expect(stored).not.toBeNull();
  expect(
    await setReservedState(
      jobs.driver,
      ref,
      name,
      { ...(stored!.value as Record<string, unknown>), last },
      stored!.version,
    ),
  ).not.toBeNull();
}

describe("coverage, missing and unit over the API (B4)", () => {
  /** A unit with one attempt in flight and a partial outcome stored. */
  async function partialUnit(): Promise<BunJobs> {
    const jobs = context();
    await jobs.queue("thumbs").add("a", {});
    expect(await jobs.summonController("thumbs").check()).toMatchObject({
      action: "summoned",
    });
    await setLastOutcome(jobs, {
      id: "sm_partial",
      outcome: "registered",
      at: Date.now(),
      detail: "partial:renders,previews",
      missing: ["renders", "previews"],
    });
    return jobs;
  }

  it("serves each pending attempt's coverage and the last outcome's missing", async () => {
    const jobs = await partialUnit();
    const h = harness({ jobs });
    for (const queue of MEDIA) {
      const response = await h.call("GET", `/queues/${queue}/summon`);
      expect(response.status).toBe(200);
      expect(response.body.pending).toHaveLength(1);
      expect(response.body.pending[0].coverage).toEqual({
        renders: "pending",
        thumbs: "pending",
        previews: "pending",
      });
      expect(response.body.last).toMatchObject({
        detail: "partial:renders,previews",
        missing: ["renders", "previews"],
      });
    }
    const list = await h.call("GET", "/summon");
    const unit = (list.body.controllers as Record<string, any>[]).find(
      (item) => item.group === "media",
    )!;
    expect(unit.last.missing).toEqual(["renders", "previews"]);
    // A controller of one queue has neither.
    await jobs.queue("emails").add("a", {});
    await jobs.summonController("emails").check();
    const emails = await h.call("GET", "/queues/emails/summon");
    expect(emails.body.pending).toHaveLength(1);
    expect(Object.hasOwn(emails.body.pending[0], "coverage")).toBe(false);
  });

  it("names no queue the caller may not read in coverage, missing or the detail", async () => {
    const jobs = await partialUnit();
    const h = harness({ jobs, authorize: denying(["renders"]).authorize });
    const response = await h.call("GET", "/queues/thumbs/summon");
    expect(response.body.pending[0].coverage).toEqual({
      thumbs: "pending",
      previews: "pending",
    });
    expect(response.body.last).toMatchObject({
      detail: "partial:previews",
      missing: ["previews"],
    });
    expect(response.text).not.toContain("renders");
    const list = await h.call("GET", "/summon");
    const unit = (list.body.controllers as Record<string, any>[]).find(
      (item) => item.group === "media",
    )!;
    expect(unit.last).toMatchObject({
      detail: "partial:previews",
      missing: ["previews"],
    });
    // The reset's answer too.
    const reset = await h.call("POST", "/queues/thumbs/summon/reset", {});
    expect(reset.status).toBe(200);
    expect(reset.text).not.toContain("renders");
    // Every missing queue unreadable: no missing at all, a bare detail.
    const none = harness({
      jobs,
      authorize: denying(["renders", "previews"]).authorize,
    });
    await setLastOutcome(jobs, {
      id: "sm_partial",
      outcome: "registered",
      at: Date.now(),
      detail: "partial:renders,previews",
      missing: ["renders", "previews"],
    });
    const bare = await none.call("GET", "/queues/thumbs/summon");
    expect(bare.body.last.detail).toBe("partial");
    expect(Object.hasOwn(bare.body.last, "missing")).toBe(false);
  });

  it("says unit: shared on the shared unit's group, and nothing on a per-queue group", async () => {
    const jobs = context();
    await jobs.queue("thumbs").add("a", {});
    await jobs.summonController("thumbs").check();
    // A group of per-queue controllers, charged once.
    expect(
      (
        await chargeGroup(
          jobs.driver,
          jobs.namespace,
          resolveSummonGroup({ name: "mail" })!,
          { queue: "emails" },
        )
      ).outcome,
    ).toBe("charged");
    const h = harness({ jobs });
    const media = await h.call("GET", "/summon/groups/media");
    expect(media.body.unit).toBe("shared");
    const mail = await h.call("GET", "/summon/groups/mail");
    expect(mail.status).toBe(200);
    expect(Object.hasOwn(mail.body, "unit")).toBe(false);
    const list = await h.call("GET", "/summon/groups");
    expect(
      (list.body.groups as Record<string, unknown>[]).map((group) => [
        group.name,
        group.unit ?? null,
      ]),
    ).toEqual([
      ["mail", null],
      ["media", "shared"],
    ]);
    // And on the unit's own status.
    const status = await h.call("GET", "/queues/renders/summon");
    expect(status.body.group.unit).toBe("shared");
  });
});

describe("coverage is best effort, and the list never reads it (review round)", () => {
  /** Counts claim reads on `jobs`' driver, failing them while `failing()` says so. */
  function claimReads(
    jobs: BunJobs,
    failing: () => boolean,
  ): { count: () => number; restore: () => void } {
    const driver = jobs.driver as unknown as {
      getQueueState: (ref: unknown, name: string) => Promise<unknown>;
    };
    const original = driver.getQueueState.bind(driver);
    let reads = 0;
    driver.getQueueState = async (ref, name) => {
      if (name.includes("summon-claim")) {
        reads++;
        if (failing()) {
          throw new Error("claim read failed");
        }
      }
      return await original(ref, name);
    };
    cleanups.push(async () => {
      driver.getQueueState = original;
    });
    return {
      count: () => reads,
      restore: () => {
        driver.getQueueState = original;
      },
    };
  }

  it("answers status(), the route and the list without coverage when a claim read fails", async () => {
    const jobs = context();
    await jobs.queue("thumbs").add("a", {});
    await jobs.summonController("thumbs").check();
    const reads = claimReads(jobs, () => true);
    const status = await jobs.summonController("thumbs").status();
    expect(status.pending).toHaveLength(1);
    expect(Object.hasOwn(status.pending[0]!, "coverage")).toBe(false);
    expect(reads.count()).toBeGreaterThan(0);
    const h = harness({ jobs });
    const one = await h.call("GET", "/queues/thumbs/summon");
    expect(one.status).toBe(200);
    expect(Object.hasOwn(one.body.pending[0], "coverage")).toBe(false);
    expect((await h.call("GET", "/summon")).status).toBe(200);
    // Once the reads work again, coverage is back.
    reads.restore();
    expect(
      (await jobs.summonController("thumbs").status()).pending[0]!.coverage,
    ).toBeDefined();
  });

  it("reads no claim for GET /summon", async () => {
    const jobs = context();
    await jobs.queue("thumbs").add("a", {});
    await jobs.summonController("thumbs").check();
    const reads = claimReads(jobs, () => false);
    const h = harness({ jobs });
    expect((await h.call("GET", "/summon")).status).toBe(200);
    expect(reads.count()).toBe(0);
    // The route does read them, for its coverage.
    await h.call("GET", "/queues/thumbs/summon");
    expect(reads.count()).toBeGreaterThan(0);
  });
});
