import type { LiveStatus } from "../../app/live";
import { describe, expect, it } from "bun:test";
import { liveStatusInfo } from "../../app/layout/liveStatusInfo";
import { act, page, setupDom } from "./dom";
import { installLiveFake } from "./liveFake";
import { renderApp } from "./renderApp";

setupDom();
const live = installLiveFake();

/** A status, with defaults for a healthy backend. */
function status(overrides: Partial<LiveStatus>): LiveStatus {
  return {
    state: "off",
    detail: null,
    events: "push",
    publishing: true,
    lastEventAt: null,
    ...overrides,
  };
}

/** The rendered badge: its text, tooltip and tone. */
function badge() {
  const root = page().getByTestId("live-status");
  const inner = root.querySelector<HTMLElement>(".badge")!;
  return {
    text: root.textContent,
    title: inner.title,
    tone: [...inner.classList].find((name) => name.startsWith("badge-")),
    state: root.dataset.state,
  };
}

describe("liveStatusInfo", () => {
  it("says Live, in green, when connected", () => {
    const info = liveStatusInfo(status({ state: "live" }));
    expect(info.text).toBe("Live");
    expect(info.tone).toBe("success");
    expect(info.title).toContain("Live updates are on");
    expect(info.title).toContain("pushed across processes");
  });

  it("says Connecting… while the first connection is made", () => {
    const info = liveStatusInfo(status({ state: "connecting" }));
    expect(info.text).toBe("Connecting…");
    expect(info.tone).toBe("info");
  });

  it("says Reconnecting…, as a warning with the reason in the tooltip", () => {
    const info = liveStatusInfo(
      status({ state: "reconnecting", detail: "The connection closed (1006)" }),
    );
    expect(info.text).toBe("Reconnecting…");
    expect(info.tone).toBe("warning");
    expect(info.title).toContain("The connection closed (1006).");
    expect(info.title).toContain("every 5 seconds");
  });

  it("says Polling Ns when off, neutral, with the reason, events and publishing in the tooltip", () => {
    const info = liveStatusInfo(
      status({
        state: "off",
        detail: "This API has no socket",
        events: "poll",
      }),
    );
    expect(info.text).toBe("Polling 5s");
    expect(info.tone).toBe("neutral");
    expect(info.title).toContain("This API has no socket.");
    expect(info.title).toContain("read from the backend on an interval");
    expect(info.title).toContain("Producers publishing events: yes.");
  });

  it("says Polling Ns when refused, as a warning", () => {
    const info = liveStatusInfo(
      status({ state: "refused", detail: "Forbidden (4003)" }),
    );
    expect(info.text).toBe("Polling 5s");
    expect(info.tone).toBe("warning");
    expect(info.title).toContain("refused");
    expect(info.title).toContain("Forbidden (4003).");
  });

  it("warns about events: local and publishing: false in every state", () => {
    for (const state of [
      "off",
      "connecting",
      "live",
      "reconnecting",
      "refused",
    ] as const) {
      const info = liveStatusInfo(
        status({ state, events: "local", publishing: false }),
      );
      expect(info.text).toEndWith(" · events: local · publishing: no");
      expect(info.tone).toBe("warning");
      expect(info.title).toContain("only seen from the API's own process");
      expect(info.title).toContain("Producers publishing events: no.");
    }
    expect(liveStatusInfo(status({ publishing: null })).title).toContain(
      "publishing events: unknown",
    );
  });
});

describe("the header badge", () => {
  it("follows the live status as it changes", async () => {
    live.install(status({ state: "connecting" }));
    renderApp();
    await page().findByTestId("live-status");
    expect(badge()).toMatchObject({
      text: "Connecting…",
      tone: "badge-info",
      state: "connecting",
    });

    await act(async () => live.setStatus({ state: "live", detail: null }));
    expect(badge()).toMatchObject({ text: "Live", tone: "badge-success" });

    await act(async () =>
      live.setStatus({ state: "reconnecting", detail: "Heartbeat missed" }),
    );
    expect(badge().text).toBe("Reconnecting…");
    expect(badge().title).toContain("Heartbeat missed.");
    expect(badge().tone).toBe("badge-warning");

    await act(async () =>
      live.setStatus({ state: "refused", detail: "Upgrade refused" }),
    );
    expect(badge()).toMatchObject({
      text: "Polling 5s",
      tone: "badge-warning",
      state: "refused",
    });

    await act(async () =>
      live.setStatus({ state: "off", detail: "No socket", events: "local" }),
    );
    expect(badge()).toMatchObject({
      text: "Polling 5s · events: local",
      tone: "badge-warning",
    });
  });
});
