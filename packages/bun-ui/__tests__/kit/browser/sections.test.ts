/**
 * `sectionsFor` (`lib/kit/browser/sections.ts`, embedding.md §2): the filter
 * a UI's nav and a host's side menu share. The UIs' own lists are checked
 * against what their navs render in each UI's app tests.
 */
import type { UiSection } from "../../../lib/kit/browser/sections";
import { describe, expect, it } from "bun:test";
import { sectionsFor } from "../../../lib/kit/browser/sections";

/** A UI's sections, spelled as a contract entry spells them. */
const SECTIONS = [
  { id: "home", label: "Home", path: "/", needs: "home:read" },
  { id: "items", label: "Items", path: "/items", needs: "items:read" },
  { id: "admin", label: "Admin", path: "/admin", needs: "admin:write" },
  { id: "help", label: "Help", path: "/help", needs: null },
  {
    id: "stats",
    label: "Stats",
    path: "/stats",
    needs: ["metrics:read", "items:read"],
  },
] as const satisfies readonly UiSection[];

describe("sectionsFor", () => {
  it("keeps the sections whose permission is granted, and those needing none, in order", () => {
    const granted = new Set(["items:read", "admin:write"]);
    expect(
      sectionsFor(SECTIONS, (permission) => granted.has(permission)).map(
        (section) => section.id,
      ),
    ).toEqual(["items", "admin", "help", "stats"]);
  });

  it("keeps a section needing a list when any one of them is granted", () => {
    const only = (granted: string) =>
      sectionsFor(SECTIONS, (permission) => permission === granted).map(
        (section) => section.id,
      );
    expect(only("metrics:read")).toEqual(["help", "stats"]);
    expect(only("items:read")).toEqual(["items", "help", "stats"]);
    expect(only("admin:write")).toEqual(["admin", "help"]);
  });

  it("asks once per section that needs something, with its permission", () => {
    const asked: string[] = [];
    sectionsFor(SECTIONS, (permission) => {
      asked.push(permission);
      return true;
    });
    // A list stops at the first one granted.
    expect(asked).toEqual([
      "home:read",
      "items:read",
      "admin:write",
      "metrics:read",
    ]);
  });

  it("negative control: granting nothing leaves only what needs nothing", () => {
    expect(sectionsFor(SECTIONS, () => false)).toEqual([SECTIONS[3]]);
  });

  it("returns the very section objects, so a caller can compare by identity", () => {
    const kept = sectionsFor(SECTIONS, () => true);
    expect(kept).toEqual([...SECTIONS]);
    expect(kept[1]).toBe(SECTIONS[1]);
    expect(kept).not.toBe(SECTIONS);
  });
});
