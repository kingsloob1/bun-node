import type { UiConfig } from "../../lib/shared/config.ts";
import { describe, expect, it } from "bun:test";
import { parseUiConfig, readUiConfig, UiConfigError } from "../../app/config";
import {
  applyTheme,
  initialTheme,
  nextTheme,
  readStoredTheme,
  storeTheme,
  THEME_STORAGE_KEY,
} from "../../app/theme";
import { UI_CONFIG_ELEMENT_ID } from "../../lib/shared/config.ts";
import { act, fireEvent, page, setupDom } from "./dom";
import { uiConfig } from "./fixtures";
import { mockFetch } from "./mockFetch";
import { defaultHandlers } from "./renderApp";

setupDom();

/**
 * `app/boot` imports `react-dom/client`, and react-dom decides at module
 * evaluation whether it runs in a DOM. Imported statically, it would evaluate
 * ahead of `./dom`'s registration whenever this is the first DOM file of the
 * run (`bun test --randomize`), and every later file's `onChange` would stop
 * firing. So it is loaded here, after the DOM exists (see `dom.ts`).
 */
const { boot } = await import("../../app/boot");

/** Writes a shell like jobsUi() serves: the config script and #root. */
function writeShell(config: unknown): void {
  const script = document.createElement("script");
  script.type = "application/json";
  script.id = UI_CONFIG_ELEMENT_ID;
  script.textContent =
    typeof config === "string" ? config : JSON.stringify(config);
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(script, root);
}

describe("readUiConfig", () => {
  it("reads the injected config", () => {
    writeShell(uiConfig());
    expect(readUiConfig()).toEqual(uiConfig());
  });

  it("explains a missing element, bad JSON and a wrong shape", () => {
    expect(() => readUiConfig()).toThrow(UiConfigError);
    expect(() => readUiConfig()).toThrow("not served by jobsUi()");
    writeShell("{not json");
    expect(() => readUiConfig()).toThrow("not valid JSON");
    expect(() => parseUiConfig({ ...uiConfig(), version: 2 })).toThrow(
      "version 2",
    );
    expect(() => parseUiConfig({ ...uiConfig(), apiBase: 1 })).toThrow(
      '"apiBase"',
    );
    expect(() => parseUiConfig({ ...uiConfig(), csrfHeader: 1 })).toThrow(
      '"csrfHeader"',
    );
    expect(() => parseUiConfig({ ...uiConfig(), theme: "blue" })).toThrow(
      '"theme"',
    );
    expect(() => parseUiConfig([])).toThrow("not an object");
  });
});

describe("theme", () => {
  it("cycles system → light → dark", () => {
    expect(nextTheme("system")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("system");
  });

  it("forces light/dark with data-theme and leaves system to the media query", () => {
    const root = document.documentElement;
    applyTheme("dark", root);
    expect(root.dataset.theme).toBe("dark");
    applyTheme("system", root);
    expect(root.dataset.theme).toBeUndefined();
  });

  it("remembers the choice, preferring it over the mount's default", () => {
    expect(initialTheme("dark")).toBe("dark");
    storeTheme("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(initialTheme("dark")).toBe("light");
    localStorage.setItem(THEME_STORAGE_KEY, "neon");
    expect(readStoredTheme()).toBeNull();
  });

  it("survives storage that throws", () => {
    const original = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      expect(readStoredTheme()).toBeNull();
      expect(() => storeTheme("dark")).not.toThrow();
      expect(initialTheme("light")).toBe("light");
    } finally {
      Object.defineProperty(globalThis, "localStorage", original!);
    }
  });
});

describe("boot", () => {
  it("renders the app from the injected config and marks it ready", async () => {
    const config: UiConfig = uiConfig({ theme: "dark", title: "Ops jobs" });
    writeShell(config);
    const api = mockFetch(defaultHandlers());
    const { root } = boot({
      client: { fetch: api.fetch },
      retry: false,
      live: { disabled: true },
    });
    try {
      await page().findByTestId("app-ready");
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(document.title).toBe("Ops jobs");
      expect(api.calls[0]!.url).toBe("/jobs-api/meta");

      // The header's toggle cycles and remembers the theme.
      fireEvent.click(page().getByRole("button", { name: /^Theme: Dark/ }));
      expect(document.documentElement.dataset.theme).toBeUndefined();
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
    } finally {
      act(() => root.unmount());
    }
  });

  it("renders a plain message when the config is missing", () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    expect(() => boot()).toThrow(UiConfigError);
    expect(root.textContent).toContain("The jobs UI could not start");
  });
});
