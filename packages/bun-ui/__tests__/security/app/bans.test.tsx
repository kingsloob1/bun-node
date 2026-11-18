/**
 * The bans screens (PR-U3, ui.md §4.2): the list's filters in the URL and
 * the request, the sources that exist, the live "N new" chip that never
 * reshuffles the page, the bulk lift (a dry-run count, a step-up retried
 * once, an approval), the manual ban form (the pre-fill contract, the
 * operator's own address, the typed id shown once) and a ban's detail
 * (history, events, hits, other scopes, its actions on its own scope's
 * permissions, the ladder slot).
 */
import type { MockCall } from "./mockApi";
import { describe, expect, it } from "bun:test";
import { expectAbsent } from "../../harness/assert";
import { act, fireEvent, LOADED, page, setupDom, waitFor } from "./dom";
import { defaultRoutes, problem } from "./mockApi";
import { renderApp } from "./renderApp";

setupDom();

const KEY = "0123456789abcdef0123456789abcdef";

/** A ban as the API returns it. */
function ban(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    scope: "global",
    subject: { type: "ip", value: "198.51.100.7" },
    action: "ban",
    reason: "scanner",
    source: "manual",
    createdAt: 1_000,
    expiresAt: 2_000_000_000_000,
    count: 1,
    liftedAt: null,
    active: true,
    revision: 1,
    ...over,
  };
}

/** The `GET /bans` calls so far (the list's and the source probe's). */
const listCalls = (calls: readonly MockCall[]) =>
  calls.filter(
    (call) =>
      call.method === "GET" &&
      call.path === "/bans" &&
      call.query.get("source") !== "auto",
  );

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
    send: (event: string, data: unknown) =>
      controller.enqueue(
        encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
      ),
    end: () => controller.close(),
  };
}

/** The bans routes: a list of `items` (auto ones answering the source probe). */
function bansRoutes(items: unknown[], extra: Record<string, unknown> = {}) {
  return {
    "GET /bans": (call: MockCall) => {
      if (call.query.get("source") === "auto") {
        return {
          body: {
            items: items.filter((b: any) => b.source === "auto").slice(0, 1),
          },
        };
      }
      return {
        body: {
          items,
          ...(call.query.get("cursor") === null ? { next: "c-2" } : {}),
        },
      };
    },
    ...extra,
  };
}

describe("the bans list", () => {
  it("lists the bans, and a filter goes into the URL and the request, the page reset", async () => {
    const { api } = renderApp({
      path: "/bans",
      routes: bansRoutes([
        ban("b1"),
        ban("b2", { subject: { type: "user", value: KEY } }),
      ]),
    });
    expect(await page().findAllByTestId("ban-row", {}, LOADED)).toHaveLength(2);
    expect(page().getByText(KEY)).toBeTruthy();
    const first = listCalls(api.calls)[0]!;
    expect(first.query.get("active")).toBe("true");
    expect(first.query.get("sort")).toBe("created");
    expect(first.query.get("direction")).toBe("desc");
    fireEvent.change(page().getByTestId("filter-kind"), {
      target: { value: "cidr" },
    });
    await waitFor(() =>
      expect(listCalls(api.calls).at(-1)!.query.get("kind")).toBe("cidr"),
    );
    expect(new URLSearchParams(window.location.search).get("kind")).toBe(
      "cidr",
    );
    fireEvent.change(page().getByTestId("filter-state"), {
      target: { value: "all" },
    });
    await waitFor(() =>
      expect(listCalls(api.calls).at(-1)!.query.has("active")).toBe(false),
    );
    const search = page().getByTestId("filter-search");
    fireEvent.change(search, { target: { value: "198.51.100.7" } });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() =>
      expect(listCalls(api.calls).at(-1)!.query.get("search")).toBe(
        "198.51.100.7",
      ),
    );
  });

  it("offers the automatic source only once such bans exist", async () => {
    renderApp({ path: "/bans", routes: bansRoutes([ban("b1")]) });
    await page().findAllByTestId("ban-row", {}, LOADED);
    const options = () =>
      [
        ...(page().getByTestId("filter-source") as HTMLSelectElement).options,
      ].map((o) => o.value);
    await waitFor(() => expect(options()).toEqual(["", "manual"]));
  });

  it("an automatic ban an agent reported shows its rule and ladder step", async () => {
    renderApp({
      path: "/bans",
      routes: bansRoutes([
        ban("b8", {
          source: "auto",
          rule: "ladder",
          step: 2,
          service: "checkout",
        }),
      ]),
    });
    const row = (await page().findAllByTestId("ban-row", {}, LOADED))[0]!;
    expect(row.textContent).toContain("auto (ladder, step 2)");
  });

  it("negative control: an automatic ban makes the source offer it", async () => {
    renderApp({
      path: "/bans",
      routes: bansRoutes([
        ban("b1"),
        ban("b3", { source: "auto", rule: "counted:login" }),
      ]),
    });
    await page().findAllByTestId("ban-row", {}, LOADED);
    const options = () =>
      [
        ...(page().getByTestId("filter-source") as HTMLSelectElement).options,
      ].map((o) => o.value);
    await waitFor(() => expect(options()).toEqual(["", "manual", "auto"]));
  });

  it("walks the pages through the URL", async () => {
    const { api } = renderApp({
      path: "/bans",
      routes: bansRoutes([ban("b1")]),
    });
    await page().findAllByTestId("ban-row", {}, LOADED);
    fireEvent.click(page().getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(listCalls(api.calls).at(-1)!.query.get("cursor")).toBe("c-2"),
    );
    expect(new URLSearchParams(window.location.search).get("page")).toBe(
      JSON.stringify(["c-2"]),
    );
  });

  it("counts a new ban live in a chip, and reads the list again only when it is clicked", async () => {
    const stream = eventStream();
    const { api } = renderApp({
      path: "/bans",
      live: true,
      routes: {
        ...bansRoutes([ban("b1")]),
        "GET /live": () => stream.response,
      },
    });
    await page().findAllByTestId("ban-row", {}, LOADED);
    await page().findByText("Live", {}, LOADED);
    const before = listCalls(api.calls).length;
    stream.send("ban", {
      topic: "bans:global",
      epoch: "e",
      seq: 1,
      ban: ban("b9", { createdAt: 5_000 }),
    });
    // An old ban changing is not new.
    stream.send("ban", {
      topic: "bans:global",
      epoch: "e",
      seq: 2,
      ban: ban("b1", { revision: 2 }),
    });
    expect(
      (await page().findByTestId("new-bans", {}, LOADED)).textContent,
    ).toBe("1 new — show");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(listCalls(api.calls).length).toBe(before);
    fireEvent.click(page().getByTestId("new-bans"));
    await waitFor(() => expect(listCalls(api.calls).length).toBe(before + 1));
    await waitFor(() =>
      expectAbsent(page().queryByTestId("new-bans"), "the chip"),
    );
    stream.end();
  });

  it("offers no new ban and no bulk lift without bans:write", async () => {
    renderApp({
      path: "/bans",
      routes: {
        ...defaultRoutes({
          permissions: { global: { "bans:read": true, "policy:read": true } },
        }),
        ...bansRoutes([ban("b1")]),
      },
    });
    await page().findAllByTestId("ban-row", {}, LOADED);
    expectAbsent(page().queryByTestId("new-ban"), "the new-ban link");
    expectAbsent(page().queryByTestId("bulk-lift-open"), "the bulk lift");
  });
});

describe("the bulk lift", () => {
  it("counts first, then lifts on confirm with the same filter", async () => {
    const bodies: unknown[] = [];
    const { api } = renderApp({
      path: "/bans?rule=counted%3Alogin",
      routes: bansRoutes([ban("b1")], {
        "POST /bans/lift": (call: MockCall) => {
          bodies.push(call.body);
          const dry = (call.body as { dryRun?: boolean }).dryRun === true;
          return {
            body: { dryRun: dry, matched: 1204, lifted: dry ? 0 : 1204 },
          };
        },
      }),
    });
    await page().findAllByTestId("ban-row", {}, LOADED);
    fireEvent.click(page().getByTestId("bulk-lift-open"));
    expect(
      (await page().findByTestId("bulk-lift-count", {}, LOADED)).textContent,
    ).toContain("1,204 active bans");
    expect(bodies[0]).toEqual({
      scope: "global",
      rule: "counted:login",
      dryRun: true,
    });
    fireEvent.click(page().getByRole("button", { name: "Lift 1,204 bans" }));
    expect(
      (await page().findByTestId("bulk-lift-outcome", {}, LOADED)).textContent,
    ).toBe("Lifted 1,204 bans.");
    expect(bodies[1]).toEqual({ scope: "global", rule: "counted:login" });
    expect(
      api.calls
        .find((c) => c.method === "POST" && c.path === "/bans/lift")!
        .headers.get("x-bun-security-csrf"),
    ).toBe("1");
  });

  it("a step-up opens the host's page and the lift is retried once when it signals ok", async () => {
    let lifts = 0;
    let stepped = false;
    const popup = { closed: false };
    const opened: string[] = [];
    // Restored by property descriptor: `open` is a method of the window.
    const original = Object.getOwnPropertyDescriptor(window, "open");
    window.open = ((url: string) => {
      opened.push(url);
      return popup;
    }) as typeof window.open;
    try {
      renderApp({
        path: "/bans",
        routes: bansRoutes([ban("b1")], {
          "POST /bans/lift": (call: MockCall) => {
            if ((call.body as { dryRun?: boolean }).dryRun === true)
              return { body: { dryRun: true, matched: 1, lifted: 0 } };
            lifts++;
            return stepped
              ? { body: { dryRun: false, matched: 1, lifted: 1 } }
              : problem(401, "step_up_required", {
                  stepUpUrl: "/auth/step-up",
                });
          },
        }),
      });
      await page().findAllByTestId("ban-row", {}, LOADED);
      fireEvent.click(page().getByTestId("bulk-lift-open"));
      await page().findByTestId("bulk-lift-count", {}, LOADED);
      fireEvent.click(page().getByRole("button", { name: "Lift 1 bans" }));
      await waitFor(() =>
        expect(opened).toEqual(["http://localhost/auth/step-up"]),
      );
      stepped = true;
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: "http://localhost",
            data: { type: "bun-security:step-up", ok: true },
          }),
        );
      });
      expect(
        (await page().findByTestId("bulk-lift-outcome", {}, LOADED))
          .textContent,
      ).toBe("Lifted 1 bans.");
      expect(lifts).toBe(2);
    } finally {
      if (original === undefined) Reflect.deleteProperty(window, "open");
      else Object.defineProperty(window, "open", original);
    }
  });

  it("under two-person approvals, says an approval was opened", async () => {
    renderApp({
      path: "/bans",
      routes: bansRoutes([ban("b1")], {
        "POST /bans/lift": (call: MockCall) =>
          (call.body as { dryRun?: boolean }).dryRun === true
            ? { body: { dryRun: true, matched: 1, lifted: 0 } }
            : {
                status: 202,
                body: {
                  id: "ap1",
                  action: "bans.lift",
                  scope: "global",
                  status: "pending",
                  revision: 1,
                },
              },
      }),
    });
    await page().findAllByTestId("ban-row", {}, LOADED);
    fireEvent.click(page().getByTestId("bulk-lift-open"));
    await page().findByTestId("bulk-lift-count", {}, LOADED);
    fireEvent.click(page().getByRole("button", { name: "Lift 1 bans" }));
    expect(
      (await page().findByTestId("bulk-lift-outcome", {}, LOADED)).textContent,
    ).toContain("an approval was opened");
  });
});

describe("the manual ban form", () => {
  it("is pre-filled from the URL contract, and sends exactly what it shows", async () => {
    const { api } = renderApp({
      path: "/bans/new?scope=service:checkout&ip=203.0.113.9&action=challenge&duration=7d&reason=scanning",
      routes: {
        "POST /bans": (call: MockCall) => ({
          status: 201,
          body: ban("b5", { scope: (call.body as any).scope }),
        }),
      },
    });
    const value = (await page().findByTestId(
      "ban-value",
      {},
      LOADED,
    )) as HTMLInputElement;
    expect(value.value).toBe("203.0.113.9");
    expect((page().getByTestId("ban-action") as HTMLSelectElement).value).toBe(
      "challenge",
    );
    expect(
      (page().getByTestId("ban-duration") as HTMLSelectElement).value,
    ).toBe("7d");
    fireEvent.click(page().getByTestId("ban-submit"));
    await page().findByTestId("ban-created", {}, LOADED);
    const sent = api.calls.find(
      (c) => c.method === "POST" && c.path === "/bans",
    )!;
    expect(sent.body).toEqual({
      scope: "service:checkout",
      ip: "203.0.113.9",
      action: "challenge",
      reason: "scanning",
      duration: "7d",
    });
  });

  it("takes a key from the URL, and flags a bad value, sending nothing", async () => {
    renderApp({ path: `/bans/new?userHash=${KEY}` });
    expect(
      (
        (await page().findByTestId(
          "ban-field",
          {},
          LOADED,
        )) as HTMLSelectElement
      ).value,
    ).toBe("userHash");
    expect((page().getByTestId("ban-value") as HTMLInputElement).value).toBe(
      KEY,
    );
  });

  it("negative control: a malformed key opens the form empty and flagged", async () => {
    const { api } = renderApp({ path: "/bans/new?userHash=alice" });
    expect(
      (await page().findByTestId("ban-error", {}, LOADED)).textContent,
    ).toContain("not valid");
    expect((page().getByTestId("ban-value") as HTMLInputElement).value).toBe(
      "",
    );
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("warns when the subject covers the operator's own address", async () => {
    renderApp({
      path: "/bans/new?ip=198.51.100.0/24",
      routes: defaultRoutes({ address: "198.51.100.42" }),
    });
    expect(
      (await page().findByTestId("ban-own-address", {}, LOADED)).textContent,
    ).toContain("198.51.100.42");
  });

  it("negative control: no warning for a range that does not hold it", async () => {
    renderApp({
      path: "/bans/new?ip=203.0.113.0/24",
      routes: defaultRoutes({ address: "198.51.100.42" }),
    });
    await page().findByTestId("ban-form", {}, LOADED);
    expectAbsent(page().queryByTestId("ban-own-address"), "the warning");
  });

  it("shows a typed account id once, and only its key after", async () => {
    renderApp({
      path: "/bans/new",
      routes: {
        "POST /bans": {
          status: 201,
          body: ban("b6", {
            subject: { type: "user", value: KEY },
            entered: { user: "u-42" },
          }),
        },
        "GET /bans/:id": {
          body: {
            ban: ban("b6", { subject: { type: "user", value: KEY } }),
            history: [],
            historyTruncated: false,
            otherBans: [],
          },
        },
      },
    });
    fireEvent.change(await page().findByTestId("ban-field", {}, LOADED), {
      target: { value: "user" },
    });
    fireEvent.change(page().getByTestId("ban-value"), {
      target: { value: "u-42" },
    });
    fireEvent.change(page().getByTestId("ban-reason"), {
      target: { value: "fraud" },
    });
    fireEvent.click(page().getByTestId("ban-submit"));
    expect(
      (await page().findByTestId("ban-entered", {}, LOADED)).textContent,
    ).toContain("u-42");
    fireEvent.click(page().getByText("Open the ban"));
    await page().findByTestId("ban-detail", {}, LOADED);
    expect(document.body.textContent).not.toContain("u-42");
  });

  it("is No access without bans:write", async () => {
    renderApp({
      path: "/bans/new",
      routes: defaultRoutes({ permissions: { global: { "bans:read": true } } }),
    });
    await page().findByTestId("no-access", {}, LOADED);
  });
});

describe("a ban's detail", () => {
  /** A detail answer. */
  const detail = (over: Record<string, unknown> = {}) => ({
    ban: ban("b1", { scope: "service:checkout", country: "NG", asn: 64500 }),
    history: [
      {
        n: 2,
        at: 2_000,
        actor: "alice",
        action: "ban.extend",
        phase: "intent",
        status: "done",
        scope: "service:checkout",
        hash: "h",
        prevHash: "p",
        entry: {},
      },
      {
        n: 1,
        at: 1_000,
        actor: "alice",
        action: "ban.create",
        phase: "intent",
        status: "done",
        scope: "service:checkout",
        hash: "p",
        prevHash: "g",
        entry: {},
      },
    ],
    historyTruncated: false,
    events: [
      {
        id: "e1",
        at: 900,
        service: "checkout",
        action: "block",
        route: "POST /login",
      },
    ],
    hitsSince: 1000,
    hitsSinceCapped: true,
    otherBans: [ban("b2", { scope: "service:ledger" })],
    ...over,
  });

  it("shows its facts, history, events, hits and other scopes; acts on its own scope's permissions", async () => {
    const { api } = renderApp({
      path: "/bans/b1",
      routes: {
        "GET /bans/:id": { body: detail() },
        "POST /bans/:id/extend": { body: ban("b1") },
      },
    });
    await page().findByTestId("ban-detail", {}, LOADED);
    expect(page().getByText("(NG, AS64500)")).toBeTruthy();
    expect(page().getByTestId("ban-history").textContent).toContain(
      "ban.extend by alice",
    );
    expect(page().getByTestId("ban-hits").textContent).toBe("1,000+");
    expect(
      page().getByTestId("ban-events").querySelector("a")!.getAttribute("href"),
    ).toBe("/security/events/e1?scope=global");
    expect(page().getByTestId("ban-others").textContent).toContain(
      "Service ledger",
    );
    expectAbsent(
      page().queryByTestId("ban-ladder"),
      "the ladder step (not reported yet)",
    );
    // The actions follow bans:write on the ban's own scope.
    await waitFor(() =>
      expect(
        api.calls.some(
          (c) =>
            c.path === "/meta/permissions" &&
            c.query.get("scope") === "service:checkout",
        ),
      ).toBe(true),
    );
    fireEvent.change(await page().findByTestId("ban-extension", {}, LOADED), {
      target: { value: "30d" },
    });
    fireEvent.click(page().getByTestId("ban-extend"));
    expect(
      (await page().findByTestId("ban-message", {}, LOADED)).textContent,
    ).toBe("Extended.");
    expect(api.calls.find((c) => c.path === "/bans/b1/extend")!.body).toEqual({
      duration: "30d",
    });
  });

  it("offers no action without bans:write on the ban's scope, and shows the ladder step once reported", async () => {
    renderApp({
      path: "/bans/b1",
      routes: {
        ...defaultRoutes({
          permissions: {
            global: {
              "policy:read": true,
              "bans:read": true,
              "bans:write": true,
            },
            "service:checkout": { "bans:read": true },
          },
        }),
        "GET /bans/:id": { body: detail({ ladderStep: 3 }) },
      },
    });
    expect(
      (await page().findByTestId("ban-ladder", {}, LOADED)).textContent,
    ).toBe("3");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expectAbsent(page().queryByTestId("ban-actions"), "the actions");
  });

  it("widens to the range and opens the new ban", async () => {
    renderApp({
      path: "/bans/b1",
      routes: {
        "GET /bans/:id": (call: MockCall) =>
          call.path === "/bans/b7"
            ? {
                body: detail({
                  ban: ban("b7", {
                    subject: { type: "cidr", value: "198.51.100.0/24" },
                  }),
                }),
              }
            : { body: detail() },
        "POST /bans/:id/widen": {
          status: 201,
          body: ban("b7", {
            subject: { type: "cidr", value: "198.51.100.0/24" },
          }),
        },
      },
    });
    fireEvent.click(await page().findByTestId("ban-widen", {}, LOADED));
    await waitFor(() =>
      expect(window.location.pathname).toBe("/security/bans/b7"),
    );
    await page().findByText("198.51.100.0/24", {}, LOADED);
  });

  it("a missing ban says so", async () => {
    renderApp({
      path: "/bans/nope",
      routes: { "GET /bans/:id": problem(404, "not_found") },
    });
    await page().findByText("The ban could not be read", {}, LOADED);
  });
});
