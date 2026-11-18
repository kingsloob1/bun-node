/**
 * The events list's "N new — show" chip (ui.md §5): live `event` messages
 * on `events:<scope>` (subscribed while the list is mounted) that the
 * list's filter would show are counted, never inserted; nothing re-reads
 * the list until the chip is clicked, which reads the first page again.
 */
import type { MockCall } from "./mockApi";
import { describe, expect, it } from "bun:test";
import { expectAbsent } from "../../harness/assert";
import { fireEvent, LOADED, page, setupDom, waitFor } from "./dom";
import { eventFixture, eventReads, liveStreams } from "./eventsFixtures";
import { renderApp } from "./renderApp";

setupDom();

const OLD = eventFixture({ id: "ev-old" });
const NEW = eventFixture({ id: "ev-new", at: OLD.at + 1_000 });

/** The ids of the rows on screen, in order. */
function rowIds(): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>('[data-testid="event-row"]'),
  ].map((row) => row.dataset.eventId ?? "");
}

/** The first-page reads (no cursor) among `calls`. */
function firstPageReads(calls: readonly MockCall[]): number {
  return eventReads(calls).filter((call) => !call.query.has("cursor")).length;
}

/** Lets messages that should do nothing have the time to (past the 250 ms invalidation window). */
function quiet(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 400));
}

/** Waits until the stream asking for `events:global` is live. */
async function untilLive(live: ReturnType<typeof liveStreams>) {
  await waitFor(() => expect(live.opened("events:global")).toBe(true), LOADED);
  await page().findByText("Live", {}, LOADED);
}

describe("the events list's live chip", () => {
  it("counts matching events without re-reading the list, until it is clicked", async () => {
    const live = liveStreams();
    // The list answers the old page until the chip asks again.
    let reads = 0;
    const { api } = renderApp({
      live: true,
      path: "/events?scope=global&action=block",
      routes: {
        "GET /live": live.route,
        "GET /analytics/events": () => {
          reads += 1;
          return { body: { items: reads === 1 ? [OLD] : [NEW, OLD] } };
        },
      },
    });
    await waitFor(() => expect(rowIds()).toEqual(["ev-old"]), LOADED);
    await untilLive(live);
    const before = eventReads(api.calls).length;
    // One that matches the filter, one that does not (an allow), and a ban
    // message (which invalidates other screens' reads, never this list).
    live.sendEvent(NEW);
    live.sendEvent(eventFixture({ id: "ev-allow", action: "allow" }));
    live.send("ban", { topic: "bans:global", ban: { id: "b1" } });
    const chip = await page().findByTestId("events-new", {}, LOADED);
    expect(chip.textContent).toBe("1 new — show");
    await quiet();
    // The list was not read again, and did not change under the operator.
    expect(eventReads(api.calls).length).toBe(before);
    expect(rowIds()).toEqual(["ev-old"]);
    // A second matching event adds to the count.
    live.sendEvent(eventFixture({ id: "ev-new-2", at: OLD.at + 2_000 }));
    await waitFor(
      () =>
        expect(page().getByTestId("events-new").textContent).toBe(
          "2 new — show",
        ),
      LOADED,
    );
    expect(eventReads(api.calls).length).toBe(before);
    // The control: clicking the chip reads the list again.
    fireEvent.click(page().getByTestId("events-new"));
    await waitFor(
      () => expect(eventReads(api.calls).length).toBe(before + 1),
      LOADED,
    );
    await waitFor(() => expect(rowIds()).toEqual(["ev-new", "ev-old"]), LOADED);
    expectAbsent(page().queryByTestId("events-new"), "the chip");
    live.end();
  });

  it("from a later page, the chip goes to the first page and reads it again", async () => {
    const live = liveStreams();
    const { api } = renderApp({
      live: true,
      path: "/events?scope=global",
      routes: {
        "GET /live": live.route,
        "GET /analytics/events": (call) => ({
          body: call.query.has("cursor")
            ? { items: [eventFixture({ id: "ev-older", at: 1 })] }
            : { items: [OLD], next: "c1" },
        }),
      },
    });
    await waitFor(() => expect(rowIds()).toEqual(["ev-old"]), LOADED);
    fireEvent.click(page().getByRole("button", { name: "Next" }));
    await waitFor(() => expect(rowIds()).toEqual(["ev-older"]), LOADED);
    await untilLive(live);
    // The first page is cached and fresh: only the chip's invalidation re-reads it.
    expect(firstPageReads(api.calls)).toBe(1);
    live.sendEvent(NEW);
    fireEvent.click(await page().findByTestId("events-new", {}, LOADED));
    await waitFor(() => expect(firstPageReads(api.calls)).toBe(2), LOADED);
    expect(new URLSearchParams(window.location.search).has("page")).toBe(false);
    expect(new URLSearchParams(window.location.search).get("scope")).toBe(
      "global",
    );
    live.end();
  });

  it("a gap (messages lost) says new events may have arrived", async () => {
    const live = liveStreams();
    renderApp({
      live: true,
      path: "/events?scope=global",
      routes: {
        "GET /live": live.route,
        "GET /analytics/events": { body: { items: [OLD] } },
      },
    });
    await waitFor(() => expect(rowIds()).toEqual(["ev-old"]), LOADED);
    await untilLive(live);
    expectAbsent(page().queryByTestId("events-new"), "the chip");
    live.send("gap", { reason: "slow", epoch: "e1", seq: 9 });
    const chip = await page().findByTestId("events-new", {}, LOADED);
    expect(chip.textContent).toBe("New events may have arrived — show");
    live.end();
  });
});
