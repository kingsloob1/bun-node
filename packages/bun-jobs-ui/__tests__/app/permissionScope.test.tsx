import type { MockHandler } from "./mockFetch";
import { describe, expect, it } from "bun:test";
import { page, setupDom, waitFor, within } from "./dom";
import { permissionsFixture } from "./fixtures";
import { renderQueue } from "./queues/fixtures";

setupDom();

/**
 * `/meta/permissions` answers per target: untargeted grants everything, but
 * the host's `authorize` refuses `queues.pause` for the `emails` queue.
 */
const perQueue: MockHandler = (call) => ({
  body:
    call.query.get("queue") === "emails"
      ? permissionsFixture({ "queues.pause": false })
      : permissionsFixture(),
});

/** The queue screen's action group, once loaded. */
async function actions() {
  await page().findByTestId("queue-total");
  return page().findByRole("group", { name: "Queue actions" });
}

describe("per-queue permissions", () => {
  it("asks /meta/permissions about the queue on screen", async () => {
    const { calls } = renderQueue({
      handlers: { "GET /meta/permissions": perQueue },
    });
    await actions();
    await waitFor(() => {
      const asked = calls.filter(
        (call) =>
          call.path === "/meta/permissions" &&
          call.query.get("queue") === "emails",
      );
      if (asked.length === 0) {
        throw new Error("no targeted permissions request yet");
      }
    });
  });

  it("hides an action the host refuses for this queue, though granted in general", async () => {
    renderQueue({ handlers: { "GET /meta/permissions": perQueue } });
    const group = await actions();
    await waitFor(() => {
      if (within(group).queryByRole("button", { name: "Pause" }) !== null) {
        throw new Error("Pause is still offered");
      }
    });
    // Other actions the queue allows stay.
    expect(within(group).queryByRole("button", { name: /Drain/ })).toBeTruthy();
  });

  it("falls back to the untargeted map when the targeted request fails", async () => {
    renderQueue({
      handlers: {
        "GET /meta/permissions": (call) =>
          call.query.get("queue") === null
            ? { body: permissionsFixture() }
            : { status: 500, body: { code: "INTERNAL" } },
      },
    });
    const group = await actions();
    expect(
      await within(group).findByRole("button", { name: "Pause" }),
    ).toBeTruthy();
  });
});
