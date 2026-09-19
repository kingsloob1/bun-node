import type { ShortcutKeyEvent } from "../../../app/layout/shortcuts";
import { describe, expect, it } from "bun:test";
import { arrowTarget } from "../../../app/components/listKeys";
import {
  isTypingTarget,
  SHORTCUT_HELP,
  shortcutFor,
} from "../../../app/layout/shortcuts";
import { wsFixture } from "../docs/ws/fixtures";
import { act, fireEvent, page, setupDom, visit, waitFor, within } from "../dom";
import { metaFixture, permissionsFixture } from "../fixtures";
import { renderApp } from "../renderApp";

setupDom();

/** A key event for {@link shortcutFor}, plain by default. */
function key(
  value: string,
  overrides: Partial<ShortcutKeyEvent> = {},
): ShortcutKeyEvent {
  return {
    key: value,
    target: document.body,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    defaultPrevented: false,
    ...overrides,
  };
}

/** Renders the Overview and waits for its queue filter. */
async function renderOverview(): Promise<HTMLInputElement> {
  renderApp();
  return (await page().findByLabelText(
    "Filter queues by name",
  )) as HTMLInputElement;
}

describe("shortcutFor", () => {
  it("maps / and ? and nothing else", () => {
    expect(shortcutFor(key("/"))).toBe("focus-search");
    expect(shortcutFor(key("?"))).toBe("show-help");
    expect(shortcutFor(key("a"))).toBeNull();
    expect(shortcutFor(key("Escape"))).toBeNull();
  });

  it("ignores a key with Ctrl, Meta or Alt, during composition, or already handled", () => {
    expect(shortcutFor(key("/", { ctrlKey: true }))).toBeNull();
    expect(shortcutFor(key("/", { metaKey: true }))).toBeNull();
    expect(shortcutFor(key("?", { altKey: true }))).toBeNull();
    expect(shortcutFor(key("/", { isComposing: true }))).toBeNull();
    expect(shortcutFor(key("/", { defaultPrevented: true }))).toBeNull();
  });

  it("ignores a key typed into a field", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    const inside = document.createElement("span");
    editable.append(inside);
    document.body.append(input, textarea, select, editable);
    for (const target of [input, textarea, select, editable, inside]) {
      expect(shortcutFor(key("/", { target }))).toBeNull();
      expect(shortcutFor(key("?", { target }))).toBeNull();
    }
  });

  it("still answers from a checkbox, a button or a link: nothing is typed there", () => {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const button = document.createElement("button");
    const link = document.createElement("a");
    for (const target of [checkbox, button, link]) {
      expect(isTypingTarget(target)).toBe(false);
      expect(shortcutFor(key("/", { target }))).toBe("focus-search");
    }
  });
});

describe("the / shortcut", () => {
  it("focuses the screen's search box, which announces the shortcut", async () => {
    const search = await renderOverview();
    expect(search.getAttribute("aria-keyshortcuts")).toBe("/");
    const event = fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(search);
    // Handled: the "/" is not typed anywhere else.
    expect(event).toBe(false);
  });

  it("does nothing while typing in a field", async () => {
    const search = await renderOverview();
    const other = document.createElement("input");
    document.body.append(other);
    other.focus();
    fireEvent.keyDown(other, { key: "/" });
    expect(document.activeElement).toBe(other);
    expect(document.activeElement).not.toBe(search);
  });

  it("does nothing with Ctrl held (the browser's own shortcut)", async () => {
    const search = await renderOverview();
    fireEvent.keyDown(document.body, { key: "/", ctrlKey: true });
    expect(document.activeElement).not.toBe(search);
  });

  it("does nothing on a screen without a search box", async () => {
    visit("/jobs/nowhere");
    renderApp();
    await page().findByTestId("not-found");
    const before = document.activeElement;
    const event = fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(before);
    expect(event).toBe(true);
  });

  it("finds the jobs search on a queue screen", async () => {
    visit("/jobs/queues/emails");
    renderApp({
      handlers: {
        "GET /queues/emails": {
          body: {
            name: "emails",
            paused: false,
            counts: {},
            total: 0,
            limits: null,
          },
        },
        "GET /queues/emails/counts": { body: {} },
        "GET /queues/emails/jobs": {
          body: { items: [], page: { offset: 0, limit: 20, hasMore: false } },
        },
      },
    });
    const search = await page().findByLabelText("Search");
    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(search);
  });
});

describe("the ? shortcut", () => {
  it("opens the shortcut list; Escape closes it and gives focus back", async () => {
    const search = await renderOverview();
    const toggle = page().getByRole("button", { name: /^Theme:/ });
    toggle.focus();
    fireEvent.keyDown(document.body, { key: "?" });
    const dialog = await page().findByRole("dialog", {
      name: "Keyboard shortcuts",
    });
    const list = within(dialog).getByTestId("shortcut-list");
    for (const entry of SHORTCUT_HELP) {
      expect(list.textContent).toContain(entry.description);
    }
    expect(within(list).getAllByText("/")[0]!.tagName).toBe("KBD");

    // While it is open, / does not reach the page behind.
    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).not.toBe(search);

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => {
      expect(page().queryByRole("dialog")).toBeNull();
    });
    expect(document.activeElement).toBe(toggle);
  });

  it("does nothing while typing a ? into a field", async () => {
    const search = await renderOverview();
    search.focus();
    fireEvent.keyDown(search, { key: "?" });
    expect(page().queryByRole("dialog")).toBeNull();
  });
});

describe("the skip link", () => {
  it("moves focus to the main landmark without touching the URL", async () => {
    await renderOverview();
    const skip = page().getByRole("link", { name: "Skip to content" });
    const url = window.location.href;
    await act(async () => {
      fireEvent.click(skip);
    });
    expect(document.activeElement).toBe(document.getElementById("main"));
    expect(document.activeElement!.tagName).toBe("MAIN");
    expect(window.location.href).toBe(url);
  });
});

describe("arrowTarget", () => {
  it("moves down and up, stops at the ends, and jumps with Home/End", () => {
    const items = ["a", "b", "c"].map((id) => {
      const link = document.createElement("a");
      link.id = id;
      return link;
    });
    const [a, b, c] = items as [
      HTMLAnchorElement,
      HTMLAnchorElement,
      HTMLAnchorElement,
    ];
    expect(arrowTarget("ArrowDown", items, null)).toBe(a);
    expect(arrowTarget("ArrowDown", items, a)).toBe(b);
    expect(arrowTarget("ArrowDown", items, c)).toBe(c);
    expect(arrowTarget("ArrowUp", items, b)).toBe(a);
    expect(arrowTarget("ArrowUp", items, a)).toBe(a);
    expect(arrowTarget("Home", items, c)).toBe(a);
    expect(arrowTarget("End", items, a)).toBe(c);
    expect(arrowTarget("Enter", items, a)).toBeNull();
    expect(arrowTarget("ArrowDown", [], null)).toBeNull();
  });
});

describe("the WebSocket docs sidebar", () => {
  it("moves between its links with the arrow keys, and from the search with ArrowDown", async () => {
    visit("/jobs/docs/ws");
    renderApp({
      handlers: {
        "GET /meta": { body: metaFixture({ mode: "both" }) },
        "GET /meta/permissions": { body: permissionsFixture() },
        "GET /asyncapi.json": { body: wsFixture("both") },
      },
    });
    await page().findByTestId("ws-main", {}, { timeout: 5_000 });
    const nav = page().getByRole("navigation", {
      name: "WebSocket reference",
    });
    const links = nav.querySelectorAll<HTMLAnchorElement>("a.ws-nav-link");
    expect(links.length).toBeGreaterThan(2);

    const search = within(nav).getByRole("searchbox");
    search.focus();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement).toBe(links[0]!);

    fireEvent.keyDown(links[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(links[1]!);
    fireEvent.keyDown(links[1]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(links[0]!);
    fireEvent.keyDown(links[0]!, { key: "End" });
    expect(document.activeElement).toBe(links[links.length - 1]!);
    fireEvent.keyDown(links[links.length - 1]!, { key: "Home" });
    expect(document.activeElement).toBe(links[0]!);
  });
});
