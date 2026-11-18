/**
 * The shared {@link HandleLedger} on its own, with no UI (embedding.md §8):
 * each kind of handle is open while it should be (the negative control:
 * `assertNoneOpen` throws naming it) and closed, the right way, once the
 * code closes it. A UI's unmount test then only has to drive its app. The
 * DOM is the docs viewer's binding of the harness, which loads no app.
 */
import type { LedgerSocket, LedgerSocketClass } from "./handleLedger";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setupDom } from "../docs/app/dom";
import { expectNone } from "./assert";
import {
  HandleLedger,
  InertSocket,
  markClosed,
  nativeSleep,
} from "./handleLedger";

setupDom();

let ledger: HandleLedger;

beforeEach(() => {
  ledger = new HandleLedger();
  ledger.install();
});

afterEach(() => {
  ledger.disposeAll();
  ledger.uninstall();
});

/** The one handle of the ledger, asserting there is exactly one. */
function only(): HandleLedger["handles"][number] {
  expect(ledger.handles).toHaveLength(1);
  return ledger.handles[0];
}

/** Asserts `assertNoneOpen` throws, naming `text`: a handle left open is reported. */
function expectReported(text: string): void {
  expect(() => ledger.assertNoneOpen()).toThrow(text);
}

describe("each kind is open until closed, and reported while open", () => {
  it("a timeout: open, then fired or cleared", async () => {
    const id = setTimeout(() => {}, 60_000);
    expect(only()).toMatchObject({ kind: "timeout", detail: "60000ms" });
    expectReported("timeout 60000ms");
    clearTimeout(id);
    expect(only()).toMatchObject({ open: false, closedBy: "cleared" });

    setTimeout(() => {}, 1);
    await nativeSleep(20);
    expect(ledger.handles[1]).toMatchObject({ open: false, closedBy: "fired" });
    ledger.assertNoneOpen();
  });

  it("an interval: open until cleared (either clear clears it)", () => {
    const id = setInterval(() => {}, 1000);
    expectReported("interval 1000ms");
    clearTimeout(id);
    expect(only()).toMatchObject({ open: false, closedBy: "cleared" });
    ledger.assertNoneOpen();
  });

  it("an animation frame: open until painted or cancelled", () => {
    const id = requestAnimationFrame(() => {});
    expectReported("animation-frame frame");
    cancelAnimationFrame(id);
    expect(only()).toMatchObject({ open: false, closedBy: "cleared" });
  });

  it("a window or document listener: open until removed, fired once, or aborted", () => {
    const listener = () => {};
    window.addEventListener("popstate", listener);
    expectReported("listener window popstate");
    window.removeEventListener("popstate", listener);
    expect(ledger.handles[0]).toMatchObject({ closedBy: "removed" });

    document.addEventListener("keydown", () => {}, { once: true });
    expectReported("listener document keydown");
    document.dispatchEvent(new Event("keydown"));
    // Closed once it ran: happy-dom drops a `once` listener through the
    // (wrapped) removeEventListener, so it reads as removed.
    expect(ledger.handles[1]).toMatchObject({ open: false });

    const controller = new AbortController();
    window.addEventListener("resize", () => {}, { signal: controller.signal });
    expectReported("listener window resize");
    controller.abort();
    expect(ledger.handles[2]).toMatchObject({ closedBy: "removed" });
    ledger.assertNoneOpen();
  });

  it("a socket (an inert one by default): open until closed", () => {
    const socket = new WebSocket("ws://localhost/live");
    expect(socket).toBeInstanceOf(InertSocket);
    expect(ledger.sockets).toEqual([socket as unknown as LedgerSocket]);
    expectReported("websocket ws://localhost/live");
    socket.close();
    expect(only()).toMatchObject({ open: false, closedBy: "closed" });
  });

  it("an event source: open until closed", () => {
    const source = new EventSource("/stream");
    expectReported("eventsource");
    source.close();
    expect(only()).toMatchObject({ open: false, closedBy: "closed" });
  });

  it("an observer: open while it observes, not from its construction", () => {
    const observer = new MutationObserver(() => {});
    expectNone(ledger.handles, "handles of an observer that observes nothing");
    observer.observe(document.body, { childList: true });
    expectReported("observer MutationObserver");
    observer.disconnect();
    expect(only()).toMatchObject({ open: false, closedBy: "disconnected" });
  });

  it("a request: open until it settles or its signal aborts it", async () => {
    const fetch = ledger.trackFetch(() => Promise.resolve(new Response("ok")), {
      hang: (url) => url.endsWith("/slow"),
    });
    await fetch("/fast", {});
    expect(only()).toMatchObject({
      kind: "fetch",
      detail: "GET /fast",
      closedBy: "settled",
    });

    const controller = new AbortController();
    const pending = fetch("/slow", { signal: controller.signal });
    expectReported("fetch GET /slow");
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(ledger.handles[1]).toMatchObject({ closedBy: "aborted" });
    ledger.assertNoneOpen();
  });
});

describe("the ledger itself", () => {
  it("disposeAll closes what is open for real, marking it disposed", () => {
    let ran = false;
    setTimeout(() => {
      ran = true;
    }, 5);
    const socket = new WebSocket("ws://localhost/x");
    ledger.disposeAll();
    ledger.assertNoneOpen();
    // A socket's dispose is its own close(), which marks it closed first.
    expect(ledger.handles.map((handle) => handle.closedBy)).toEqual([
      "disposed",
      "closed",
    ]);
    expect(socket.readyState).toBe(InertSocket.CLOSED);
    return nativeSleep(20).then(() => expect(ran).toBe(false));
  });

  it("uninstall restores each global exactly", () => {
    ledger.uninstall();
    /** The own descriptors of the globals the ledger wraps (a sample). */
    const descriptors = () => ({
      setTimeout: Object.getOwnPropertyDescriptor(globalThis, "setTimeout"),
      WebSocket: Object.getOwnPropertyDescriptor(globalThis, "WebSocket"),
      addEventListener: Object.getOwnPropertyDescriptor(
        window,
        "addEventListener",
      ),
    });
    const before = descriptors();
    const other = new HandleLedger();
    other.install();
    expect(descriptors().setTimeout?.value).not.toBe(before.setTimeout?.value);
    expect(descriptors().WebSocket?.value).not.toBe(before.WebSocket?.value);
    other.uninstall();
    expect(descriptors()).toEqual(before);
    ledger.install(); // for afterEach
  });

  it("refuses a second install", () => {
    expect(() => ledger.install()).toThrow("already installed");
  });

  it("a subclass's socket class is the global WebSocket, recorded the same way", () => {
    ledger.uninstall();
    /** A UI's fake: it closes its handle itself, as the jobs UI's does. */
    class UiSocket implements LedgerSocket {
      handle: LedgerSocket["handle"];
      constructor(readonly url: string) {}
      close(): void {
        markClosed(this.handle);
      }
    }
    class UiLedger extends HandleLedger {
      protected override socketClass(): LedgerSocketClass {
        return UiSocket;
      }
    }
    const own = new UiLedger();
    own.install();
    try {
      const socket = new WebSocket("ws://localhost/ui");
      expect(socket).toBeInstanceOf(UiSocket);
      expect(() => own.assertNoneOpen()).toThrow("websocket ws://localhost/ui");
      socket.close();
      own.assertNoneOpen();
    } finally {
      own.disposeAll();
      own.uninstall();
      ledger.install(); // for afterEach
    }
  });
});
