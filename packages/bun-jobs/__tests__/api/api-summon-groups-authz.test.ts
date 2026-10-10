import type { JobsApiConfig } from "../../lib/api/config";
import type { JobsApiAuthorizeContext } from "../../lib/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import {
  BunJobs,
  createDriver,
  defineSummoner,
  ProviderError,
} from "../../lib/index";
import { setReservedState } from "../../lib/queue/windows";
import { chargeGroup, resolveSummonGroup } from "../../lib/summon/group";
import { freshMarker, SUMMON_MARKER } from "../../lib/summon/marker";
import { makeTmpDir, testNamespace } from "../helpers";
import { harness } from "./fixtures";

/**
 * The summon group routes and authorization (review of #314): nothing about
 * a queue reaches a caller `authorize` refuses `queues.read` on — not its
 * share of the group's attempts, not the attempt that opened the group's
 * circuit — whether the group is read from `GET /summon/groups`,
 * `GET /summon/groups/{group}` or embedded in another member's
 * `GET /queues/{queue}/summon`. A group reset needs `queues.summon` on every
 * member. Both hold under a deny-list and under a per-queue allow-list, and
 * an allow-list can read and reset a group whose members it covers.
 *
 * Also the `GET /summon` rows read from storage that cannot show a budget: a
 * newer bun-jobs' marker (inert, no budget), an unreadable one (left out of
 * the list; inert, `unreadable-marker`, on its own route),
 * and one written before limits were persisted (`limitsUnknown`).
 */

setDefaultTimeout(60_000);

const perTest: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of perTest.splice(0)) {
    await cleanup().catch(() => {});
  }
});

/** Triggers off and no cooldown: every check is one the test asked for. */
const QUIET = {
  triggers: { onAdd: false, events: false, poll: false as const },
  cooldown: 0,
};

/** The platform code `thumbs`' failure carries: it must never reach a caller refused `thumbs`. */
const SECRET = "InvalidToken-SECRET";

const okSummoner = defineSummoner({
  kind: "ok-kind",
  invoke: async () => ({ status: "started", handles: [] }),
});
const brokenSummoner = defineSummoner({
  kind: "broken-kind",
  invoke: async () => {
    throw new ProviderError("credentials rejected", "auth", {
      platformCode: SECRET,
    });
  },
});

type Authorize = NonNullable<JobsApiConfig["authorize"]>;

/** Refuses `queues.read` and `queues.summon` on the queues named, allows the rest. */
function denyList(...refused: string[]): Authorize {
  return (_req, ctx) =>
    !(
      (ctx.action === "queues.read" || ctx.action === "queues.summon") &&
      ctx.queue !== undefined &&
      refused.includes(ctx.queue)
    );
}

/** Allows `queues.read` and `queues.summon` only on the queues named, every other action anywhere. */
function allowList(...allowed: string[]): Authorize {
  return (_req, ctx) =>
    (ctx.action !== "queues.read" && ctx.action !== "queues.summon") ||
    (ctx.queue !== undefined && allowed.includes(ctx.queue));
}

/**
 * A writer process's state on one file root: `renders` (kind `ok-kind`) and
 * `thumbs` (kind `broken-kind`, its credentials rejected with
 * {@link SECRET}) in group `media` with a shared circuit, and `lonely`
 * alone in group `solo`. The API's context runs a controller of its own on
 * `local`, in `media`, when `local` is set.
 */
async function setup(options: { local: boolean; authorize: Authorize }) {
  const dir = await makeTmpDir("bun-jobs-api-summon-groups-authz");
  const namespace = testNamespace("api-summon-groups-authz");
  const writerDriver = createDriver({
    type: "file",
    root: join(dir.path, "d"),
  });
  const apiDriver = createDriver({ type: "file", root: join(dir.path, "d") });
  const media = { name: "media", circuit: true };
  const writer = new BunJobs({
    driver: writerDriver,
    namespace,
    logger: noopLogger,
    summon: {
      renders: { summoner: okSummoner, ...QUIET, group: media },
      thumbs: { summoner: brokenSummoner, ...QUIET, group: media },
      lonely: { summoner: okSummoner, ...QUIET, group: { name: "solo" } },
    },
  });
  const jobs = new BunJobs({
    driver: apiDriver,
    namespace,
    logger: noopLogger,
    ...(options.local
      ? { summon: { local: { summoner: okSummoner, ...QUIET, group: media } } }
      : {}),
  });
  perTest.push(async () => {
    await writer.close();
    await jobs.close();
    await apiDriver.purge(namespace).catch(() => {});
    await apiDriver.close();
    await writerDriver.close();
    await dir.cleanup();
  });
  for (const queue of ["renders", "thumbs", "lonely", "local"]) {
    await writer.queue(queue).add("a", {});
  }
  for (const queue of ["renders", "thumbs", "lonely"]) {
    await writer.summonController(queue).check();
  }
  const thumbsId = (await writer.summonController("thumbs").status()).last!.id;
  expect(thumbsId).not.toBe("");
  const seen: JobsApiAuthorizeContext[] = [];
  const h = harness({
    jobs,
    authorize: (req, ctx) => {
      seen.push(ctx);
      return options.authorize(req, ctx);
    },
  });
  return { h, seen, thumbsId, namespace, jobs };
}

/** What must never reach a caller refused `thumbs`. */
function expectNoThumbs(text: string, thumbsId: string): void {
  expect(text).not.toContain("thumbs");
  expect(text).not.toContain(thumbsId);
  expect(text).not.toContain(SECRET);
}

for (const local of [false, true]) {
  const where = local
    ? "with a local controller"
    : "without a local controller";
  describe(`summon group routes and authorization, ${where}`, () => {
    it("shows everything to a caller allowed every queue (the control)", async () => {
      const { h, thumbsId } = await setup({ local, authorize: () => true });
      const one = await h.call("GET", "/summon/groups/media");
      expect(one.status).toBe(200);
      expect(one.text).toContain("thumbs");
      expect(one.text).toContain(thumbsId);
      expect(one.text).toContain(SECRET);
      expect(one.body.circuits["broken-kind"].openedBy).toEqual({
        queue: "thumbs",
        id: thumbsId,
        detail: SECRET,
      });
      expect(h.mismatches()).toEqual([]);
    });

    for (const [policy, authorize] of [
      ["a deny-list refusing thumbs", denyList("thumbs")],
      ["an allow-list of renders and local", allowList("renders", "local")],
    ] as const) {
      it(`never shows a queue the caller may not read, under ${policy}`, async () => {
        const { h, thumbsId } = await setup({ local, authorize });

        const list = await h.call("GET", "/summon/groups");
        expect(list.status).toBe(200);
        expectNoThumbs(list.text, thumbsId);
        const media = list.body.groups.find(
          (group: { name: string }) => group.name === "media",
        );
        // The group-wide aggregates stay: they govern `renders` too.
        expect(media).toMatchObject({
          name: "media",
          budget: { hour: 2, day: 2 },
          queues: { renders: { day: 1 } },
          circuits: {
            "broken-kind": {
              failures: expect.any(Number),
              openUntil: expect.any(Number),
            },
          },
        });
        expect(media.circuits["broken-kind"]).not.toHaveProperty("openedBy");

        // Finding 3: an allow-list reads the group through its members.
        const one = await h.call("GET", "/summon/groups/media");
        expect(one.status).toBe(200);
        expectNoThumbs(one.text, thumbsId);
        expect(one.body).toEqual(media);

        // The leak under a queue the caller CAN read.
        const renders = await h.call("GET", "/queues/renders/summon");
        expect(renders.status).toBe(200);
        expectNoThumbs(renders.text, thumbsId);
        expect(renders.body.group).toMatchObject({
          name: "media",
          budget: { hour: 2, day: 2 },
          queues: { renders: { day: 1 } },
        });
        expect(renders.body.group.circuits["broken-kind"]).not.toHaveProperty(
          "openedBy",
        );
        expect(h.mismatches()).toEqual([]);
      });
    }

    it("answers a group none of whose members the caller may read as it answers an unknown one", async () => {
      // A deny-list: the untargeted question is allowed, so both are 409.
      const { h } = await setup({
        local,
        authorize: denyList("thumbs", "lonely"),
      });
      const hidden = await h.call("GET", "/summon/groups/solo");
      const unknown = await h.call("GET", "/summon/groups/nowhere");
      expect(hidden.status).toBe(409);
      expect(unknown.status).toBe(409);
      // The same answer, but for the name.
      expect(hidden.text).toBe(unknown.text.replaceAll("nowhere", "solo"));
      const list = await h.call("GET", "/summon/groups");
      expect(
        list.body.groups.map((group: { name: string }) => group.name),
      ).toEqual(["media"]);

      // An allow-list: the untargeted question is refused, so both are 403.
      const { h: allow } = await setup({
        local,
        authorize: allowList("renders", "local"),
      });
      const hiddenAllow = await allow.call("GET", "/summon/groups/solo");
      const unknownAllow = await allow.call("GET", "/summon/groups/nowhere");
      expect(hiddenAllow.status).toBe(403);
      expect(unknownAllow.status).toBe(403);
      expect(hiddenAllow.text).toBe(
        unknownAllow.text.replaceAll("nowhere", "solo"),
      );
      // The reserved name: 400 only to a caller the untargeted question allows.
      const reserved = await h.call("GET", "/summon/groups/__bunjobs");
      expect(reserved.status).toBe(400);
      expect(reserved.body.code).toBe("INVALID_NAME");
      expect((await allow.call("GET", "/summon/groups/__bunjobs")).status).toBe(
        403,
      );
      expect(
        (await allow.call("POST", "/summon/groups/__bunjobs/reset", {})).status,
      ).toBe(403);
      // A name the params schema refuses: the same rule, from the gate.
      const invalid = await h.call("GET", "/summon/groups/bad%20name");
      expect(invalid.status).toBe(400);
      expect(
        (await allow.call("GET", "/summon/groups/bad%20name")).status,
      ).toBe(403);
      expect(
        (await allow.call("POST", "/summon/groups/bad%20name/reset", {}))
          .status,
      ).toBe(403);
      expect(h.mismatches()).toEqual([]);
      expect(allow.mismatches()).toEqual([]);
    });

    it("needs queues.summon on every member to reset a group", async () => {
      const members = local
        ? ["local", "renders", "thumbs"]
        : ["renders", "thumbs"];
      for (const authorize of [
        denyList("thumbs"),
        allowList("renders", "local"),
      ]) {
        const { h, seen, thumbsId } = await setup({ local, authorize });
        seen.length = 0;
        const reset = await h.call("POST", "/summon/groups/media/reset", {
          budget: true,
          circuit: true,
        });
        expect(reset.status).toBe(403);
        expectNoThumbs(reset.text, thumbsId);
        // Asked about each member, by name.
        expect(
          seen
            .filter((ctx) => ctx.action === "queues.summon")
            .map((ctx) => ctx.queue)
            .sort(),
        ).toEqual(members);
        // Nothing was cleared.
        const after = await h.call("GET", "/summon/groups/media");
        expect(after.body).toMatchObject({ budget: { hour: 2, day: 2 } });
        expect(after.body.circuits["broken-kind"].openUntil).toBeNumber();
      }

      // An allow-list covering every member.
      const { h } = await setup({
        local,
        authorize: allowList(...members),
      });
      const reset = await h.call("POST", "/summon/groups/media/reset", {
        budget: true,
        circuit: true,
      });
      if (local) {
        expect(reset.status).toBe(200);
        expect(reset.body).toMatchObject({
          name: "media",
          budget: { hour: 0, day: 0 },
          queues: {},
        });
        expect(reset.body).not.toHaveProperty("circuits");
      } else {
        // Allowed, but no controller in the group runs here (finding 6).
        expect(reset.status).toBe(409);
        expect(reset.body.code).toBe("SUMMON_NOT_CONFIGURED");
        expect(reset.body.detail).not.toContain("no shared state");
        expect(reset.body.detail).toContain("reset");
        expect(reset.body.title).not.toContain("this queue");
      }
      expect(h.mismatches()).toEqual([]);
    });
  });
}

describe("a member queue named __proto__", () => {
  it("is shown as an own share to a caller who may read it, and filtered out for one who may not", async () => {
    const { h, namespace, jobs } = await setup({
      local: true,
      authorize: allowList("renders", "local", "__proto__"),
    });
    const charge = await chargeGroup(
      jobs.driver,
      namespace,
      resolveSummonGroup({ name: "media", circuit: true })!,
      { queue: "__proto__" },
    );
    expect(charge.outcome).toBe("charged");
    for (const path of ["/summon/groups/media", "/queues/renders/summon"]) {
      const response = await h.call("GET", path);
      expect(response.status).toBe(200);
      const group = path.startsWith("/queues")
        ? response.body.group
        : response.body;
      expect(Object.hasOwn(group.queues, "__proto__")).toBe(true);
      expect(
        Object.getOwnPropertyDescriptor(group.queues, "__proto__")?.value,
      ).toMatchObject({ day: 1 });
      expect(group.budget).toMatchObject({ hour: 3, day: 3 });
      expect(response.text).not.toContain("thumbs");
    }

    // Refused `__proto__`: its share is filtered out like any member's.
    const {
      h: denied,
      namespace: other,
      jobs: otherJobs,
    } = await setup({
      local: true,
      authorize: denyList("thumbs", "__proto__"),
    });
    await chargeGroup(
      otherJobs.driver,
      other,
      resolveSummonGroup({ name: "media", circuit: true })!,
      { queue: "__proto__" },
    );
    const hidden = await denied.call("GET", "/summon/groups/media");
    expect(hidden.status).toBe(200);
    expect(hidden.text).not.toContain("__proto__");
    expect(hidden.body.budget).toMatchObject({ hour: 3, day: 3 });
    expect(h.mismatches()).toEqual([]);
    expect(denied.mismatches()).toEqual([]);
  });
});

describe("the authorize calls each summon route makes", () => {
  it("asks about each member queue once, in code-point order, with the status route's context", async () => {
    const { h, seen } = await setup({ local: true, authorize: () => true });
    const calls = async (method: string, path: string, body?: unknown) => {
      seen.length = 0;
      const response = await h.call(method, path, body);
      expect(response.status).toBe(200);
      return seen.map((ctx) => [
        ctx.action,
        ctx.queue ?? null,
        `${ctx.route?.method} ${ctx.route?.path}`,
      ]);
    };
    const read = (queue: string) => [
      "queues.read",
      queue,
      "GET /queues/:queue/summon",
    ];
    expect(await calls("GET", "/summon")).toEqual([
      ["queues.list", null, "GET /summon"],
      ...["local", "lonely", "renders", "thumbs"].map(read),
    ]);
    // `media`'s members (local, renders, thumbs) and `solo`'s (lonely),
    // asked together, each once.
    expect(await calls("GET", "/summon/groups")).toEqual([
      ["queues.list", null, "GET /summon/groups"],
      ...["local", "lonely", "renders", "thumbs"].map(read),
    ]);
    expect(await calls("GET", "/summon/groups/media")).toEqual(
      ["local", "renders", "thumbs"].map(read),
    );
    // The route's own queue, then the group's other queues it names (its
    // shares and `openedBy`; a local controller with no share names none).
    expect(await calls("GET", "/queues/renders/summon")).toEqual(
      ["renders", "thumbs"].map(read),
    );
    // `queues.summon` on every member first, then what the answer shows.
    expect(await calls("POST", "/summon/groups/media/reset", {})).toEqual([
      ...["local", "renders", "thumbs"].map((queue) => [
        "queues.summon",
        queue,
        "POST /summon/groups/:group/reset",
      ]),
      ...["renders", "thumbs"].map(read),
    ]);
    expect(h.mismatches()).toEqual([]);
  });
});

describe("GET /summon rows read from storage that cannot show a budget", () => {
  it("sends a newer marker's row inert with no budget, leaves an unreadable one out, and marks limits it cannot know", async () => {
    const { h, jobs, namespace } = await setup({
      local: true,
      authorize: () => true,
    });
    const driver = jobs.driver;
    const write = async (queue: string, value: unknown) => {
      await jobs.queue(queue).add("a", {});
      await setReservedState(
        driver,
        { ns: namespace, queue },
        SUMMON_MARKER,
        value,
        null,
      );
    };
    await write("newer", { v: 9 });
    await write("garbage", { v: 1, nonsense: true });
    // A marker from before limits were persisted: real counts, no limits.
    const old = freshMarker(Date.now());
    old.budget.hour = 2;
    old.budget.day = 3;
    await write("old", old);

    const list = await h.call("GET", "/summon");
    expect(list.status).toBe(200);
    const rows = Object.fromEntries(
      list.body.controllers.map((row: { queue: string }) => [row.queue, row]),
    );
    expect(Object.keys(rows)).not.toContain("garbage");
    expect(rows.newer).toEqual({
      namespace,
      queue: "newer",
      local: false,
      kind: "",
      inert: true,
      inertReason: "newer-marker",
    });
    expect(rows.old).toMatchObject({
      local: false,
      inert: false,
      budget: { hour: 2, day: 3, limitsUnknown: true },
    });
    expect(rows.old.budget).not.toHaveProperty("perHour");
    expect(rows.old.budget).not.toHaveProperty("perDay");
    expect(rows.old.budget).not.toHaveProperty("off");
    // A remote row whose claim persisted its limits, and a local one: known.
    expect(rows.renders.budget).not.toHaveProperty("limitsUnknown");
    expect(rows.renders).toMatchObject({ local: false, inert: false });
    expect(rows.local).toMatchObject({ local: true });
    expect(rows.local.budget).not.toHaveProperty("limitsUnknown");
    expect(list.text).not.toMatch(/ResetsAt":0[,}]/);

    const status = await h.call("GET", "/queues/old/summon");
    expect(status.body.budget).toMatchObject({
      hour: 2,
      day: 3,
      limitsUnknown: true,
      hourResetsAt: expect.any(Number),
      dayResetsAt: expect.any(Number),
    });
    expect(status.body.budget).not.toHaveProperty("perHour");
    expect(status.body.budget).not.toHaveProperty("off");
    const local = await h.call("GET", "/queues/local/summon");
    expect(local.body.budget).not.toHaveProperty("limitsUnknown");

    // The single-queue route answers for an unreadable marker rather than
    // leave it out, and says it is inert and why: never a healthy idle queue
    // (`inert: false`, nothing pending, no failures) with no budget.
    const garbage = await h.call("GET", "/queues/garbage/summon");
    expect(garbage.status).toBe(200);
    expect(garbage.body).toEqual({
      queue: "garbage",
      local: false,
      inert: true,
      inertReason: "unreadable-marker",
      pending: [],
      failures: 0,
    });
    // A newer marker's, alike (the control): inert, its own reason.
    const newer = await h.call("GET", "/queues/newer/summon");
    expect(newer.body).toMatchObject({
      inert: true,
      inertReason: "newer-marker",
    });
    expect(newer.body).not.toHaveProperty("budget");
    expect(h.mismatches()).toEqual([]);
  });
});
