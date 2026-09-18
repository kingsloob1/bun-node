import { describe, expect, it } from "bun:test";
import { serializeQuery } from "../../../app/api/client";
import { queryKeys } from "../../../app/api/queryKeys";
import {
  jobListQuery,
  jobPath,
  mutationInvalidations,
  queueKeys,
} from "../../../app/api/queues";
import { POLL_INTERVAL_MS } from "../../../app/queryClient";
import {
  formatMs,
  parseWindow,
  toMs,
} from "../../../app/screens/queues/duration";
import {
  readJobFilters,
  truncate,
} from "../../../app/screens/queues/jobFilters";
import { refreshInterval } from "../../../app/screens/queues/live";
import {
  draftFromLimits,
  limitsBodyFromDraft,
} from "../../../app/screens/queues/panels/limitsDraft";
import { parseWindowParam } from "../../../app/screens/queues/panels/throughput";
import {
  describeSchedule,
  listIds,
} from "../../../app/screens/queues/queueFormat";
import {
  clampLimit,
  intParam,
  splitList,
} from "../../../app/screens/queues/urlState";
import { repeatablesFixture } from "./fixtures";

const LIMITS = { defaultPageSize: 20, maxPageSize: 100 };

describe("the queue screens' pure helpers", () => {
  it("builds a jobs query of only non-defaults, names as repeated keys, never include", () => {
    const filters = readJobFilters(new URLSearchParams(""), "all", LIMITS);
    expect(serializeQuery(jobListQuery(filters))).toBe("?limit=20");
    const full = readJobFilters(
      new URLSearchParams(
        "offset=40&limit=500&order=desc&name=a,b,a&search=x&total=1",
      ),
      "failed",
      LIMITS,
    );
    expect(full).toEqual({
      state: "failed",
      offset: 40,
      limit: 100,
      order: "desc",
      names: ["a", "b"],
      search: "x",
      total: true,
    });
    expect(serializeQuery(jobListQuery(full))).toBe(
      "?state=failed&offset=40&limit=100&order=desc&name=a&name=b&search=x&total=true",
    );
  });

  it("ignores malformed URL numbers", () => {
    const params = new URLSearchParams("offset=-3&limit=abc");
    expect(intParam(params, "offset", 0)).toBe(0);
    expect(intParam(params, "limit", 20)).toBe(20);
    expect(clampLimit(0, 50)).toBe(1);
    expect(clampLimit(80, 50)).toBe(50);
    expect(splitList(" a, ,b,a ")).toEqual(["a", "b"]);
  });

  it("keeps every queue key under [queue, q] and invalidates queue, queues and overview", () => {
    const prefix = queryKeys.queue("emails");
    for (const key of [
      queueKeys.detail("emails"),
      queueKeys.counts("emails"),
      queueKeys.workers("emails"),
      queueKeys.repeatables("emails"),
      queueKeys.throughput("emails", 60),
      queueKeys.jobsAll("emails"),
    ]) {
      expect(key.slice(0, 2)).toEqual([...prefix]);
    }
    expect(queueKeys.page({ search: "", offset: 0, limit: 20 })[0]).toBe(
      "queues",
    );
    expect(mutationInvalidations("emails")).toEqual([
      ["queue", "emails"],
      ["queues"],
      ["overview"],
    ]);
  });

  it("percent-encodes both segments of a job path", () => {
    expect(jobPath("e.mails", "a/b c?")).toBe(
      "/queues/e.mails/jobs/a%2Fb%20c%3F",
    );
  });

  it("converts and formats durations", () => {
    expect(toMs(2, "hours")).toBe(7_200_000);
    expect(toMs(1.5, "minutes")).toBe(90_000);
    expect(toMs(undefined, "days")).toBeUndefined();
    expect(toMs(-1, "days")).toBeUndefined();
    expect(formatMs(90_000)).toBe("1m 30s");
    expect(formatMs(86_400_000)).toBe("1d");
    expect(formatMs(250)).toBe("250ms");
    expect(parseWindow(" 60000 ")).toBe(60_000);
    expect(parseWindow("1 minute")).toBe("1 minute");
    expect(parseWindow("  ")).toBeUndefined();
  });

  it("round-trips limits between the stored shape and the PUT body", () => {
    const stored = {
      rate: { max: 5, duration: 1000 },
      names: { send: { concurrency: 2 } },
    };
    const draft = draftFromLimits(stored);
    expect(limitsBodyFromDraft(draft)).toEqual(stored);
    expect(limitsBodyFromDraft(draftFromLimits(null))).toEqual({});
    // A nameless row is dropped; half a rate goes to the API to refuse.
    draft.names.push({
      key: 9,
      name: " ",
      rateMax: 1,
      rateDuration: "",
      concurrency: undefined,
    });
    draft.queue.rateDuration = "";
    expect(limitsBodyFromDraft(draft)).toEqual({
      rate: { max: 5, duration: 0 },
      names: { send: { concurrency: 2 } },
    });
  });

  it("formats schedules, id lists, windows and truncation", () => {
    const series = repeatablesFixture.items[0]!;
    expect(describeSchedule(series)).toBe("0 9 * * * (Europe/London)");
    expect(
      describeSchedule({
        ...series,
        cron: undefined,
        tz: undefined,
        every: 300_000,
      }),
    ).toBe("every 5m");
    expect(listIds(["a", "b"])).toBe("a, b");
    expect(listIds(Array.from({ length: 12 }, (_, i) => `i${i}`))).toBe(
      "i0, i1, i2, i3, i4, i5, i6, i7, i8, i9 and 2 more",
    );
    expect(parseWindowParam("1440")).toBe(1440);
    expect(parseWindowParam("7")).toBe(60);
    expect(parseWindowParam(null)).toBe(60);
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 4)).toBe("abc");
  });

  it("polls counts and the jobs page at the app's interval, from one module", () => {
    expect(refreshInterval("counts")).toBe(POLL_INTERVAL_MS);
    expect(refreshInterval("jobs")).toBe(POLL_INTERVAL_MS);
  });
});
