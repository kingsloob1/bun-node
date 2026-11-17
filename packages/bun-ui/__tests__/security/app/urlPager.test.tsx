/**
 * The URL-cursor pager (ui.md §5): the trail of cursors walked is in the
 * URL (`page`, `limit`), so back/forward and a shared link land on the same
 * page; the kit's `Pager` drives it.
 */
import type { UrlCursor } from "../../../app/security/components/urlCursor";
import { describe, expect, it } from "bun:test";
import { expectUndefined } from "../../harness/assert";
import {
  trailOf,
  useUrlCursor,
} from "../../../app/security/components/urlCursor";
import { UrlPager } from "../../../app/security/components/UrlPager";
import { RouterProvider } from "../../../app/security/router";
import { act, fireEvent, page, render, setupDom, visit } from "./dom";

setupDom();

/** Pages of a fake cursor list: `c<n>` leads to page n. */
const NEXT: Record<string, string | undefined> = {
  first: "c1",
  c1: "c2",
  c2: undefined,
};

/** The position the probe last rendered with. */
let seen: UrlCursor | undefined;

/** Renders the pager over the fake list. */
function Probe() {
  const position = useUrlCursor(50);
  seen = position;
  const next = NEXT[position.cursor ?? "first"];
  return (
    <UrlPager
      position={position}
      page={{ items: [1, 2], ...(next === undefined ? {} : { next }) }}
    />
  );
}

/** The trail in the URL now. */
function urlTrail(): string[] {
  return trailOf(window.location.search);
}

describe("the URL cursor", () => {
  it("walks forward and back through the trail in the URL", () => {
    visit("/security/bans?scope=global");
    render(
      <RouterProvider basePath="/security">
        <Probe />
      </RouterProvider>,
    );
    const previous = () =>
      page().getByRole("button", { name: "Previous" }) as HTMLButtonElement;
    const next = () =>
      page().getByRole("button", { name: "Next" }) as HTMLButtonElement;
    expect(previous().disabled).toBe(true);
    fireEvent.click(next());
    expect(urlTrail()).toEqual(["c1"]);
    expect(seen?.cursor).toBe("c1");
    fireEvent.click(next());
    expect(urlTrail()).toEqual(["c1", "c2"]);
    expect(next().disabled).toBe(true);
    fireEvent.click(previous());
    expect(urlTrail()).toEqual(["c1"]);
    expect(new URLSearchParams(window.location.search).get("scope")).toBe(
      "global",
    );
  });

  it("the browser's back button returns to the previous page", async () => {
    visit("/security/bans");
    render(
      <RouterProvider basePath="/security">
        <Probe />
      </RouterProvider>,
    );
    fireEvent.click(page().getByRole("button", { name: "Next" }));
    fireEvent.click(page().getByRole("button", { name: "Next" }));
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(seen?.cursor).toBe("c1");
  });

  it("a page size starts the walk again; the default size stays out of the URL", () => {
    visit(`/security/bans?page=${encodeURIComponent(JSON.stringify(["c1"]))}`);
    render(
      <RouterProvider basePath="/security">
        <Probe />
      </RouterProvider>,
    );
    expect(seen?.cursor).toBe("c1");
    fireEvent.change(page().getByLabelText("Rows per page"), {
      target: { value: "100" },
    });
    expect(urlTrail()).toEqual([]);
    expect(new URLSearchParams(window.location.search).get("limit")).toBe(
      "100",
    );
    expect(seen?.limit).toBe(100);
  });

  it("a malformed trail, or an oversized limit, is the first page at the cap", () => {
    expect(trailOf("?page=not-json")).toEqual([]);
    expect(trailOf(`?page=${encodeURIComponent("[1,2]")}`)).toEqual([]);
    visit("/security/bans?limit=5000");
    render(
      <RouterProvider basePath="/security">
        <Probe />
      </RouterProvider>,
    );
    expect(seen?.limit).toBe(200);
    expectUndefined(seen?.cursor);
  });
});
