/**
 * A mounted jobs UI leaves nothing behind (embedding.md §8): `mountJobsUi`
 * under the {@link HandleLedger} — every timer, frame, window, document
 * and host-element listener, socket, observer and request — live updates
 * on, across its sections, then `unmount()`. The cases assert the mount
 * STARTED (its socket, its polling), so one that rendered nothing cannot
 * pass, and the negative controls show the check names a leak: a mount
 * never unmounted, and a listener planted on the host's element.
 */
import type { MountedUi } from "../../../lib/kit/browser/mount";
import { focusManager, onlineManager } from "@tanstack/react-query";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test";
import { sharedClockState } from "../../../app/jobs/hooks/useNow";
import { expectNone } from "../../harness/assert";
import { act, cleanup, render, setupDom, within } from "./dom";
import { HandleLedger, nativeSleep } from "./handleLedger";
import { hello } from "./live/fakes";
import { mockFetch } from "./mockFetch";
import { defaultHandlers } from "./renderApp";

setupDom();

/** Loaded after the DOM exists: react-dom decides at evaluation whether one does. */
const { mountJobsApp } = await import("../../../app/jobs/mountApp");

beforeAll(() => {
  // React adds one `selectionchange` listener per document, with its first
  // root, and never removes it: make it before any ledger records.
  render(<div />);
  cleanup();
});

/** The ledger of the running test. */
let ledger: HandleLedger;
/** Restores the global `fetch`. */
let restoreFetch: () => void = () => {};

beforeEach(() => {
  expect(focusManager.hasListeners()).toBe(false);
  expect(onlineManager.hasListeners()).toBe(false);
  expect(sharedClockState()).toEqual({ subscribers: 0, running: false });
  ledger = new HandleLedger();
  ledger.install();
  const tracked = ledger.trackFetch(mockFetch(defaultHandlers()).fetch);
  const spy = spyOn(globalThis, "fetch").mockImplementation(((
    input: string,
    init: RequestInit,
  ) => tracked(input, init)) as unknown as typeof fetch);
  restoreFetch = () => spy.mockRestore();
});

afterEach(() => {
  ledger.disposeAll();
  ledger.uninstall();
  restoreFetch();
});

/** Lets fetches answer and React commit, on timers the ledger never records. */
async function flush(rounds = 3): Promise<void> {
  for (let index = 0; index < rounds; index++) {
    await act(async () => {
      await nativeSleep(10);
    });
  }
}

/** A host element, its listeners recorded. */
function hostElement(): HTMLElement {
  const element = document.createElement("section");
  document.body.append(element);
  ledger.trackListeners(element, "host");
  return element;
}

/** Mounts the jobs UI into `element`, live on, its requests through the ledger. */
function mount(
  element: HTMLElement,
  shell: "none" | "tabs" | "full" = "full",
): MountedUi {
  let ui: MountedUi | undefined;
  act(() => {
    ui = mountJobsApp(
      element,
      { apiBase: "/jobs-api", basePath: "/jobs", shell },
      { live: { random: () => 0 }, retry: false },
    );
  });
  return ui!;
}

/** Opens the app's socket and says hello. */
async function goLive(): Promise<void> {
  for (let tries = 0; ledger.sockets.length === 0 && tries < 200; tries++) {
    await flush(1);
  }
  expect(ledger.sockets.length).toBeGreaterThan(0);
  const socket = ledger.sockets.at(-1)!;
  await act(async () => {
    socket.open();
    socket.receive(hello());
  });
  await flush();
  await act(async () => socket.ackAll());
  await flush();
}

/** Unmounts and drains, in the order the jobs leak test measured. */
async function unmountAndDrain(ui: MountedUi): Promise<void> {
  await act(async () => {
    ui.unmount();
    await nativeSleep(20);
  });
  await act(async () => {
    await nativeSleep(20);
  });
}

describe("a mounted jobs UI", () => {
  for (const shell of ["none", "full"] as const) {
    it(`closes everything it opened on unmount (shell "${shell}"), across its sections`, async () => {
      const element = hostElement();
      const ui = mount(element, shell);
      await flush();
      await goLive();
      expect(ledger.opened("interval").length).toBeGreaterThan(0);
      for (const path of ["/queues", "/workers", "/runners", "/events", "/"]) {
        await act(async () => ui.navigate(path));
        await flush();
      }
      await unmountAndDrain(ui);
      expectNone(element.children, "the host's children");
      ledger.assertNoneOpen();
      expect(ledger.sockets.every((socket) => socket.closedWith === 1000)).toBe(
        true,
      );
    });
  }

  it("two mounts unmounted in turn leave nothing either", async () => {
    const first = mount(hostElement());
    await flush();
    const second = mount(hostElement(), "tabs");
    await flush();
    await unmountAndDrain(first);
    await unmountAndDrain(second);
    ledger.assertNoneOpen();
  });

  it("negative control: a mount never unmounted is reported", async () => {
    const element = hostElement();
    const ui = mount(element);
    await flush();
    await goLive();
    expect(() => ledger.assertNoneOpen()).toThrow("outlived the unmount");
    await unmountAndDrain(ui);
  });

  it("negative control: a listener left on the host's element is reported", async () => {
    const element = hostElement();
    const ui = mount(element);
    await flush();
    element.addEventListener("click", () => {});
    await unmountAndDrain(ui);
    expect(() => ledger.assertNoneOpen()).toThrow("listener host click");
    expectNone(within(document.body).queryAllByTestId("app-ready"), "apps");
  });
});
