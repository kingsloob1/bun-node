/**
 * The live stream (ui.md §6): CP5's `/live` over server-sent events,
 * subscribed to the scope's readable topics (and the analytics panels'
 * `overview` and `events` while they are mounted, PR-U2); an event
 * refetches the screen's data, coalesced; a refusal falls back to polling,
 * said in the badge.
 */
import type { MockCall } from "./mockApi";
import { describe, expect, it } from "bun:test";
import { LOADED, page, setupDom, waitFor } from "./dom";
import { defaultRoutes, problem } from "./mockApi";
import { renderApp } from "./renderApp";

setupDom();

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

/**
 * The topics a `/live` call asked for, in either of bun-client's array forms
 * (`topics=a&topics=b`, or `topics[0]=a` for one element).
 */
function topicsOf(call: MockCall | undefined): string[] {
  if (call === undefined) return [];
  return [...call.query.entries()]
    .filter(([key]) => key === "topics" || /^topics\[\d+\]$/.test(key))
    .map(([, value]) => value);
}

/** The `GET /bans` calls so far. */
function banReads(calls: readonly MockCall[]): number {
  return calls.filter((call) => call.path === "/bans").length;
}

describe("the live stream", () => {
  it("subscribes to the scope's readable topics, goes live, and an event refetches the screen once", async () => {
    // The analytics panels add their topics as they mount: a new stream each time.
    let stream = eventStream();
    const { api } = renderApp({
      live: true,
      path: "/?scope=group:payments",
      routes: {
        "GET /live": () => {
          stream = eventStream();
          return stream.response;
        },
      },
    });
    await page().findByTestId("panel-offenders", {}, LOADED);
    await waitFor(
      () =>
        expect(
          topicsOf(api.calls.filter((call) => call.path === "/live").at(-1)),
        ).toEqual([
          "bans:group:payments",
          "policy:group:payments",
          "overview:group:payments",
          "events:group:payments",
        ]),
      LOADED,
    );
    await page().findByText("Live", {}, LOADED);
    await waitFor(() => expect(banReads(api.calls)).toBeGreaterThan(0), LOADED);
    const before = banReads(api.calls);
    stream.send("ban", { id: "b9" }, "e1:1");
    stream.send("ban.changed", { event: "ban.changed" }, "e1:2");
    await waitFor(() => expect(banReads(api.calls)).toBe(before + 1), LOADED);
    // Coalesced: the two events made one refetch.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(banReads(api.calls)).toBe(before + 1);
    // `/meta` is never refetched by an event.
    expect(api.calls.filter((call) => call.path === "/meta").length).toBe(1);
    stream.end();
  });

  it("a topic the operator may not read is not asked for", async () => {
    const stream = eventStream();
    const { api } = renderApp({
      live: true,
      routes: {
        ...defaultRoutes({ permissions: { global: { "policy:read": true } } }),
        "GET /live": () => stream.response,
      },
    });
    await page().findByText("Live", {}, LOADED);
    expect(topicsOf(api.calls.find((call) => call.path === "/live"))).toEqual([
      "policy:global",
    ]);
    stream.end();
  });

  it("a refusal falls back to polling, and says so", async () => {
    renderApp({
      live: true,
      routes: { "GET /live": problem(403, "forbidden") },
    });
    await page().findByTestId("analytics", {}, LOADED);
    const badge = await page().findByText("Polling 15s", {}, LOADED);
    await waitFor(
      () =>
        expect(badge.closest("[title]")?.getAttribute("title") ?? "").toContain(
          "refused",
        ),
      LOADED,
    );
  });
});
