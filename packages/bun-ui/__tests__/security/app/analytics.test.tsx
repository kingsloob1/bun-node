/**
 * The analytics page (PR-U2): every panel for an operator who may read it
 * all, and none past a permission (its endpoint never called); the range in
 * the URL and the tier it asks for; accessible charts (an image with a
 * summary, a table one click away, no inline style); top offenders' links
 * into U3's forms and the account kinds only with events:read; rule hits
 * with false positives, sortable; a panel that fails or is not recorded
 * keeps to itself; the live feed, paused while hovered. Each with its
 * negative control.
 */
import type { MockCall } from "./mockApi";
import { describe, expect, it } from "bun:test";
import { segments } from "../../../app/security/analytics/api";
import { p95 } from "../../../app/security/analytics/latency";
import { expectAbsent } from "../../harness/assert";
import { fireEvent, LOADED, page, setupDom, waitFor, within } from "./dom";
import { analyticsRoutes, defaultRoutes, problem, T0 } from "./mockApi";
import { renderApp } from "./renderApp";

setupDom();

/** Every panel's test id, in page order. */
const PANELS = [
  "panel-headline",
  "panel-traffic",
  "panel-outcomes",
  "panel-offenders",
  "panel-feed",
  "panel-rules",
  "panel-services",
  "panel-geography",
  "panel-bans",
  "panel-login",
  "panel-patterns",
  "panel-agents",
  "panel-intel",
];

/** The analytics reads so far, by path. */
const reads = (calls: readonly MockCall[], path: string) =>
  calls.filter((call) => call.path === path);

/** An open SSE response and the function writing events to it. */
function eventStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    send: (event: string, data: unknown, id?: string) =>
      controller.enqueue(
        encoder.encode(
          `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
        ),
      ),
    end: () => controller.close(),
  };
}

describe("the panels an operator sees", () => {
  it("an owner sees every panel, each having read its data", async () => {
    const { api } = renderApp();
    for (const id of PANELS) await page().findByTestId(id, {}, LOADED);
    expect(
      (await page().findByTestId("headline-refused", {}, LOADED)).textContent,
    ).toBe("3");
    expect(page().getByTestId("headline-refused-addresses").textContent).toBe(
      "3",
    );
    expect(page().getByTestId("headline-active-bans").textContent).toBe("2");
    expect(reads(api.calls, "/analytics/bans").length).toBeGreaterThan(0);
    expect(reads(api.calls, "/agents").length).toBeGreaterThan(0);
  });

  it("an analytics reader alone sees no ban, agent or intel panel, and their endpoints are never called", async () => {
    const { api } = renderApp({
      routes: defaultRoutes({
        permissions: {
          global: { "policy:read": true, "analytics:read": true },
        },
      }),
    });
    await page().findByTestId("panel-traffic", {}, LOADED);
    await page().findByTestId("panel-offenders", {}, LOADED);
    for (const id of ["panel-bans", "panel-agents", "panel-intel"])
      expectAbsent(page().queryByTestId(id), id);
    expectAbsent(
      page().queryByTestId("headline-active-bans"),
      "the active bans tile",
    );
    expect(reads(api.calls, "/analytics/bans")).toEqual([]);
    expect(reads(api.calls, "/agents")).toEqual([]);
    expect(reads(api.calls, "/bans")).toEqual([]);
  });

  it("without analytics:read the page is No access, and no analytics read is made", async () => {
    const { api } = renderApp({
      routes: defaultRoutes({
        permissions: { global: { "policy:read": true } },
      }),
    });
    expect(
      (await page().findByTestId("no-access", {}, LOADED)).textContent,
    ).toContain("analytics:read");
    expect(
      api.calls.filter((call) => call.path.startsWith("/analytics")),
    ).toEqual([]);
  });
});

describe("the range", () => {
  it("is 24 hours by default (the hour tier); a preset goes into the URL and reads at its tier", async () => {
    const { api } = renderApp();
    await page().findByTestId("panel-traffic", {}, LOADED);
    await waitFor(() =>
      expect(reads(api.calls, "/analytics/series").length).toBeGreaterThan(0),
    );
    expect(reads(api.calls, "/analytics/series")[0]!.query.get("tier")).toBe(
      "hour",
    );
    const picker = within(
      page().getByRole("group", { name: "Analytics range" }),
    );
    fireEvent.change(picker.getByRole("combobox"), {
      target: { value: "900" },
    });
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get("range")).toBe(
        "900s",
      ),
    );
    await waitFor(() =>
      expect(
        reads(api.calls, "/analytics/series").some(
          (call) => call.query.get("tier") === "minute",
        ),
      ).toBe(true),
    );
  });

  it("a custom range from the URL is read as given, at the day tier past 14 days", async () => {
    const from = T0 - 30 * 86_400_000;
    const { api } = renderApp({ path: `/?range=${from}-${T0}` });
    await page().findByTestId("panel-traffic", {}, LOADED);
    await waitFor(() =>
      expect(reads(api.calls, "/analytics/series").length).toBeGreaterThan(0),
    );
    const requests = reads(api.calls, "/analytics/series").filter(
      (call) => call.query.get("metric") === "requests",
    );
    // Its closed days at the day tier; what reaches into today at finer ones, ending at the range's end.
    expect([
      requests[0]!.query.get("from"),
      requests[0]!.query.get("tier"),
    ]).toEqual([String(from), "day"]);
    expect(requests.some((call) => call.query.get("to") === String(T0))).toBe(
      true,
    );
    expect(new URLSearchParams(window.location.search).get("range")).toBe(
      `${from}-${T0}`,
    );
  });
});

describe("accessible charts", () => {
  it("an image with a summary, its data one click away as a table; no inline style anywhere", async () => {
    renderApp();
    const chart = await page().findByTestId("traffic-chart", {}, LOADED);
    const image = within(chart).getByRole("img");
    expect(image.getAttribute("aria-labelledby")).not.toBeNull();
    expect(chart.textContent).toContain("15 requests: 12 allowed");
    expect(chart.textContent).toContain("3 blocked");
    fireEvent.click(within(chart).getByRole("button", { name: "Table" }));
    const table = await within(chart).findByRole("table", {}, LOADED);
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(table.textContent).toContain("Blocked");
    // The control: the image is gone while the table shows.
    expectAbsent(within(chart).queryByRole("img"), "the chart image");
    // No inline style anywhere (the CSP's style-src 'self').
    const styled = [...document.querySelectorAll("[style]")].map(
      (node) => node.tagName,
    );
    expect(styled).toEqual([]);
  });
});

describe("top offenders", () => {
  const offenders = analyticsRoutes({
    top: {
      "top.refused": [
        { dims: { kind: "ip", subject: "203.0.113.7" }, value: 40 },
      ],
    },
  });

  it("an owner gets ban and allow links into U3's forms, pre-filled, and every subject kind", async () => {
    renderApp({ path: "/?scope=group:payments", routes: offenders });
    const panel = await page().findByTestId("panel-offenders", {}, LOADED);
    await within(panel).findByText("203.0.113.7", {}, LOADED);
    expect(
      within(panel).getByRole("link", { name: "Ban" }).getAttribute("href"),
    ).toBe("/security/bans/new?scope=group%3Apayments&ip=203.0.113.7");
    expect(
      within(panel).getByRole("link", { name: "Allow" }).getAttribute("href"),
    ).toBe(
      "/security/lists/new?scope=group%3Apayments&ip=203.0.113.7&action=allow",
    );
    // 203.0.113.7 is banned (the fixture's /bans).
    expect(within(panel).getByText("Banned")).toBeTruthy();
    const kinds = within(panel).getByRole("combobox", {
      name: "Subject kind",
    }) as HTMLSelectElement;
    expect([...kinds.options].map((option) => option.value)).toEqual([
      "ip",
      "user",
      "username",
      "apiKey",
    ]);
  });

  it("following Ban opens U3's ban form, pre-filled with the subject and scope", async () => {
    renderApp({ path: "/?scope=group:payments", routes: offenders });
    const panel = await page().findByTestId("panel-offenders", {}, LOADED);
    await within(panel).findByText("203.0.113.7", {}, LOADED);
    fireEvent.click(within(panel).getByRole("link", { name: "Ban" }));
    const value = (await page().findByTestId(
      "ban-value",
      {},
      LOADED,
    )) as HTMLInputElement;
    expect(value.value).toBe("203.0.113.7");
    expect(window.location.pathname).toBe("/security/bans/new");
    expect(new URLSearchParams(window.location.search).get("scope")).toBe(
      "group:payments",
    );
    // The control: the analytics page is gone.
    expectAbsent(page().queryByTestId("analytics"), "the analytics page");
  });

  it("an analytics reader alone gets addresses only and no link", async () => {
    renderApp({
      routes: {
        ...defaultRoutes({
          permissions: {
            global: { "policy:read": true, "analytics:read": true },
          },
        }),
        ...offenders,
      },
    });
    const panel = await page().findByTestId("panel-offenders", {}, LOADED);
    await within(panel).findByText("203.0.113.7", {}, LOADED);
    expectAbsent(
      within(panel).queryByRole("combobox", { name: "Subject kind" }),
      "the kind picker",
    );
    expectAbsent(
      within(panel).queryByRole("link", { name: "Ban" }),
      "the ban link",
    );
    expectAbsent(
      within(panel).queryByRole("link", { name: "Allow" }),
      "the allow link",
    );
  });
});

describe("rule hits", () => {
  it("counts hits, blocks, dry-run would-blocks and false positives, and sorts by a column", async () => {
    renderApp({
      routes: analyticsRoutes({
        series: {
          requests: [],
          rules: [
            {
              at: T0,
              dims: { rule: "rule:a", action: "block", dryRun: "false" },
              value: 2,
            },
            {
              at: T0,
              dims: { rule: "rule:b", action: "block", dryRun: "true" },
              value: 9,
            },
          ],
        },
        top: {
          "rules.false-positive": [{ dims: { rule: "rule:a" }, value: 1 }],
        },
      }),
    });
    const panel = await page().findByTestId("panel-rules", {}, LOADED);
    await within(panel).findByText("rule:a", {}, LOADED);
    expect(page().getByTestId("fp-rule:a").textContent).toBe("1");
    const order = () =>
      within(panel)
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.querySelector("td")?.textContent);
    expect(order()).toEqual(["rule:b", "rule:a"]);
    fireEvent.click(
      within(panel).getByRole("button", { name: "False positives" }),
    );
    await waitFor(() => expect(order()).toEqual(["rule:a", "rule:b"]));
  });
});

describe("a panel's read keeps to itself", () => {
  it("one that fails says so; one not recorded says that; the rest still show", async () => {
    renderApp({
      routes: {
        "GET /analytics/scores": problem(500, "internal"),
        "GET /analytics/bans": problem(404, "not_found"),
      },
    });
    const bans = await page().findByTestId("panel-bans", {}, LOADED);
    await within(bans).findByText(
      "Not recorded by this deployment.",
      {},
      LOADED,
    );
    const offenders = await page().findByTestId("panel-offenders", {}, LOADED);
    await within(offenders).findByText(/could not be read/, {}, LOADED);
    expect(
      (await page().findByTestId("headline-refused", {}, LOADED)).textContent,
    ).toBe("3");
  });
});

describe("reading the current hour", () => {
  it("a range into the current hour reads it at the minute tier, the closed hours (and days) at theirs", () => {
    const H = 3_600_000;
    const now = 10 * 24 * H + 5 * H + 1_234;
    const hour = 10 * 24 * H + 5 * H;
    expect(segments(now - 24 * H, now, "hour", now)).toEqual([
      { from: now - 24 * H, to: hour, tier: "hour" },
      { from: hour, to: now, tier: "minute" },
    ]);
    expect(segments(now - 30 * 24 * H, now, "day", now)).toEqual([
      { from: now - 30 * 24 * H, to: 10 * 24 * H, tier: "day" },
      { from: 10 * 24 * H, to: hour, tier: "hour" },
      { from: hour, to: now, tier: "minute" },
    ]);
    // The controls: a range ending before this hour is read whole at its tier; a minute range as it is.
    expect(segments(0, 2 * H, "hour", now)).toEqual([
      { from: 0, to: 2 * H, tier: "hour" },
    ]);
    expect(segments(now - H, now, "minute", now)).toEqual([
      { from: now - H, to: now, tier: "minute" },
    ]);
  });
});

describe("services", () => {
  it("p95 reads the latency histogram's edge holding 95% of decisions", () => {
    expect(
      p95(
        new Map([
          ["1", 90],
          ["5", 6],
          ["+Inf", 4],
        ]),
      ),
    ).toBe("≤ 5 ms");
    expect(
      p95(
        new Map([
          ["1", 50],
          ["+Inf", 50],
        ]),
      ),
    ).toBe("over the last edge");
    expect(p95(new Map())).toBe("—");
  });
});

describe("the activity feed", () => {
  it("shows streamed decisions as they come; holds them while hovered, then shows them", async () => {
    let stream = eventStream();
    renderApp({
      live: true,
      routes: {
        "GET /live": () => {
          stream = eventStream();
          return stream.response;
        },
      },
    });
    const panel = await page().findByTestId("panel-feed", {}, LOADED);
    await page().findByText("Live", {}, LOADED);
    const event = (id: string, ip: string) => ({
      topic: "events:global",
      epoch: "e",
      seq: 1,
      event: {
        id,
        at: T0,
        service: "checkout",
        action: "block",
        rule: "rule:x",
        route: "GET /x",
        subjects: { ip },
      },
    });
    await waitFor(() => {
      stream.send("event", event("ev1", "203.0.113.1"));
      expect(within(panel).queryAllByTestId("feed-row").length).toBeGreaterThan(
        0,
      );
    }, LOADED);
    const feed = panel.querySelector(".feed")!;
    fireEvent.mouseEnter(feed);
    stream.send("event", event("ev2", "203.0.113.2"));
    await within(panel).findByRole("button", { name: "1 new" }, LOADED);
    // Held: not listed yet.
    expectAbsent(within(panel).queryByText("203.0.113.2"), "the held event");
    fireEvent.mouseLeave(feed);
    await within(panel).findByText("203.0.113.2", {}, LOADED);
    expect(
      within(panel)
        .getAllByTestId("feed-row")[0]!
        .querySelector("a")
        ?.getAttribute("href"),
    ).toBe("/security/events/ev2");
  });
});
