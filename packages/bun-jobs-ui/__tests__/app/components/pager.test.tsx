import type { PageWindow } from "../../../app/components/pagerState";
import { describe, expect, it, mock } from "bun:test";
import { Pager } from "../../../app/components/Pager";
import {
  pagerState,
  pageSizeOptions,
} from "../../../app/components/pagerState";
import { fireEvent, page, render, setupDom } from "../dom";

setupDom();

describe("pagerState", () => {
  it("with a total: range, prev and next", () => {
    expect(pagerState({ offset: 0, limit: 20, total: 345 })).toEqual({
      from: 1,
      to: 20,
      text: "1–20 of 345",
      hasPrev: false,
      hasNext: true,
    });
    expect(pagerState({ offset: 340, limit: 20, total: 345 })).toMatchObject({
      from: 341,
      to: 345,
      text: "341–345 of 345",
      hasPrev: true,
      hasNext: false,
    });
    expect(pagerState({ offset: 320, limit: 20, total: 340 }).hasNext).toBe(
      false,
    );
    expect(pagerState({ offset: 0, limit: 20, total: 1_234_567 }).text).toBe(
      `1–20 of ${(1_234_567).toLocaleString()}`,
    );
  });

  it("with an empty total", () => {
    expect(pagerState({ offset: 0, limit: 20, total: 0 })).toMatchObject({
      from: 0,
      to: 0,
      text: "0 of 0",
      hasPrev: false,
      hasNext: false,
    });
  });

  it("without a total: no 'of', next from hasMore or a full page", () => {
    expect(
      pagerState({ offset: 20, limit: 20, itemCount: 20, hasMore: true }),
    ).toEqual({
      from: 21,
      to: 40,
      text: "21–40",
      hasPrev: true,
      hasNext: true,
    });
    expect(
      pagerState({ offset: 40, limit: 20, itemCount: 7, hasMore: false }),
    ).toMatchObject({ text: "41–47", hasNext: false });
    // No hasMore: a full page suggests more, a short one does not.
    expect(pagerState({ offset: 0, limit: 20, itemCount: 20 }).hasNext).toBe(
      true,
    );
    expect(pagerState({ offset: 0, limit: 20, itemCount: 3 }).hasNext).toBe(
      false,
    );
    expect(pagerState({ offset: 0, limit: 20, itemCount: 0 })).toMatchObject({
      text: "No rows",
      hasNext: false,
    });
  });

  it("offers page sizes bounded by the maximum", () => {
    expect(pageSizeOptions([10, 20, 50, 100], 20)).toEqual([10, 20, 50, 100]);
    expect(pageSizeOptions([10, 20, 50, 100], 20, 50)).toEqual([10, 20, 50]);
    expect(pageSizeOptions([10, 20, 50, 100], 20, 30)).toEqual([10, 20, 30]);
    expect(pageSizeOptions([10, 20], 25)).toEqual([10, 20, 25]);
    expect(pageSizeOptions([10, 20, 50], 20, 5)).toEqual([5]);
  });
});

describe("Pager", () => {
  it("renders the range and moves by a page", () => {
    const onChange = mock((_next: PageWindow) => {});
    render(
      <Pager
        offset={20}
        limit={20}
        total={345}
        onChange={onChange}
      />,
    );
    const nav = page().getByRole("navigation", { name: "Pagination" });
    expect(nav.textContent).toContain("21–40 of 345");
    fireEvent.click(page().getByRole("button", { name: "Next" }));
    fireEvent.click(page().getByRole("button", { name: "Previous" }));
    expect(onChange.mock.calls).toEqual([
      [{ offset: 40, limit: 20 }],
      [{ offset: 0, limit: 20 }],
    ]);
  });

  it("disables prev on the first page and next without more", () => {
    render(
      <Pager
        offset={0}
        limit={20}
        itemCount={5}
        hasMore={false}
        onChange={() => {}}
      />,
    );
    expect(page().getByText("1–5")).toBeTruthy();
    const prev = page().getByRole("button", { name: "Previous" });
    const next = page().getByRole("button", { name: "Next" });
    expect((prev as HTMLButtonElement).disabled).toBe(true);
    expect((next as HTMLButtonElement).disabled).toBe(true);
  });

  it("changes the page size, keeping the first visible row, within maxPageSize", () => {
    const onChange = mock((_next: PageWindow) => {});
    render(
      <Pager
        offset={60}
        limit={20}
        total={345}
        maxPageSize={50}
        onChange={onChange}
      />,
    );
    const select = page().getByLabelText("Rows per page") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      "10",
      "20",
      "50",
    ]);
    fireEvent.change(select, { target: { value: "50" } });
    expect(onChange).toHaveBeenCalledWith({ offset: 50, limit: 50 });
  });
});
