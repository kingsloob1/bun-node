import type { PageMove } from "../../../app/components/pagerState";
import { describe, expect, it, mock } from "bun:test";
import { Pager } from "../../../app/components/Pager";
import {
  PAGE_SELECT_MAX,
  pageNumbers,
  pageOffset,
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
      page: 1,
      pageCount: 18,
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
      page: 2,
      pageCount: null,
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

  it("numbers the pages, and counts them only when the total is known", () => {
    const at = (offset: number, total?: number | null) =>
      pagerState({ offset, limit: 20, total, itemCount: 20 });
    expect(at(0, 345)).toMatchObject({ page: 1, pageCount: 18 });
    expect(at(20, 345)).toMatchObject({ page: 2, pageCount: 18 });
    // The last page is partial, and still a page.
    expect(at(340, 345)).toMatchObject({ page: 18, pageCount: 18 });
    // An exact multiple does not invent a trailing empty page.
    expect(at(0, 340).pageCount).toBe(17);
    // No rows is one (empty) page, never zero.
    expect(at(0, 0)).toMatchObject({ page: 1, pageCount: 1 });
    // An offset past the end reads as the last page, not as page 21 of 18.
    expect(at(400, 345).page).toBe(18);
    // Without a total there is nothing to count, but we still know where we are.
    expect(at(60, null)).toMatchObject({ page: 4, pageCount: null });
    expect(at(60)).toMatchObject({ page: 4, pageCount: null });
  });

  it("turns a page back into an offset, clamped to the pages that exist", () => {
    expect(pageOffset(1, 20, 18)).toBe(0);
    expect(pageOffset(4, 20, 18)).toBe(60);
    expect(pageOffset(18, 20, 18)).toBe(340);
    // Out of range, either way.
    expect(pageOffset(99, 20, 18)).toBe(340);
    expect(pageOffset(0, 20, 18)).toBe(0);
    expect(pageOffset(-3, 20, 18)).toBe(0);
    expect(pageOffset(Number.NaN, 20, 18)).toBe(0);
    // Unbounded without a page count.
    expect(pageOffset(99, 20)).toBe(1960);
  });

  it("lists every page number", () => {
    expect(pageNumbers(3)).toEqual([1, 2, 3]);
    expect(pageNumbers(1)).toEqual([1]);
    expect(pageNumbers(0)).toEqual([]);
    expect(pageNumbers(PAGE_SELECT_MAX)).toHaveLength(PAGE_SELECT_MAX);
    expect(pageNumbers(PAGE_SELECT_MAX).at(-1)).toBe(PAGE_SELECT_MAX);
  });
});

describe("Pager", () => {
  it("renders the range and moves by a page", () => {
    const onChange = mock((_next: PageMove) => {});
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
    const onChange = mock((_next: PageMove) => {});
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
    // `resize` marks the one move a walked list answers by keeping its
    // cursor; an offset pager reads the window and ignores it.
    expect(onChange).toHaveBeenCalledWith({
      offset: 50,
      limit: 50,
      resize: true,
    });
  });

  it("lists every page and jumps straight to one", () => {
    const onChange = mock((_next: PageMove) => {});
    render(
      <Pager
        offset={20}
        limit={20}
        total={345}
        onChange={onChange}
      />,
    );
    const select = page().getByLabelText("Page") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(Array.from(select.options).map((option) => option.value)).toEqual(
      Array.from({ length: 18 }, (_unused, index) => String(index + 1)),
    );
    // It shows the page the offset is on, and says how many there are.
    expect(select.value).toBe("2");
    expect(page().getByText("of 18")).toBeTruthy();
    fireEvent.change(select, { target: { value: "7" } });
    expect(onChange).toHaveBeenCalledWith({ offset: 120, limit: 20 });
  });

  it("jumps to the first and last pages, and disables prev/next there", () => {
    const onChange = mock((_next: PageMove) => {});
    const { rerender } = render(
      <Pager
        offset={0}
        limit={20}
        total={345}
        onChange={onChange}
      />,
    );
    const first = page().getByLabelText("Page") as HTMLSelectElement;
    expect(first.value).toBe("1");
    expect(
      (page().getByRole("button", { name: "Previous" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(first, { target: { value: "18" } });
    expect(onChange).toHaveBeenLastCalledWith({ offset: 340, limit: 20 });

    rerender(
      <Pager
        offset={340}
        limit={20}
        total={345}
        onChange={onChange}
      />,
    );
    const last = page().getByLabelText("Page") as HTMLSelectElement;
    expect(last.value).toBe("18");
    expect(
      (page().getByRole("button", { name: "Next" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(last, { target: { value: "1" } });
    expect(onChange).toHaveBeenLastCalledWith({ offset: 0, limit: 20 });
  });

  it("shows the page as text, with no control, when the total is unknown", () => {
    const { rerender } = render(
      <Pager
        offset={40}
        limit={20}
        itemCount={20}
        hasMore
        onChange={() => {}}
      />,
    );
    const nav = page().getByRole("navigation", { name: "Pagination" });
    expect(nav.textContent).toContain("Page 3");
    // No page control at all: nothing can bound it without a page count.
    expect(page().queryByLabelText("Page")).toBeNull();
    expect(nav.querySelector(".pager-page-static")).toBeTruthy();
    // Nothing is rendered disabled-and-unexplained: the size select is still
    // the only combobox, and prev/next still work.
    expect(nav.querySelectorAll("select")).toHaveLength(1);
    expect(nav.querySelectorAll("input")).toHaveLength(0);
    expect(
      (page().getByRole("button", { name: "Next" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    // One page and no total: no paging to locate yourself in, so no text.
    rerender(
      <Pager
        offset={0}
        limit={20}
        itemCount={3}
        hasMore={false}
        onChange={() => {}}
      />,
    );
    expect(nav.textContent).not.toContain("Page");
    expect(nav.querySelector(".pager-page-static")).toBeNull();
    // ...and the rest of the pager is untouched.
    expect(page().getByLabelText("Rows per page")).toBeTruthy();
    expect(nav.textContent).toContain("1–3");
  });

  it("uses a bounded number input beyond the select threshold", () => {
    const onChange = mock((_next: PageMove) => {});
    render(
      <Pager
        offset={0}
        limit={20}
        // 250 pages: far past PAGE_SELECT_MAX, and a select nobody could use.
        total={5000}
        onChange={onChange}
      />,
    );
    const input = page().getByLabelText("Page") as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    expect(input.type).toBe("number");
    expect(input.min).toBe("1");
    expect(input.max).toBe("250");
    expect(input.value).toBe("1");
    expect(page().getByText("of 250")).toBeTruthy();
    // Typing alone moves nothing; Enter commits.
    fireEvent.change(input, { target: { value: "137" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith({ offset: 2720, limit: 20 });
  });

  it("commits the typed page on blur, clamped to the last page", () => {
    const onChange = mock((_next: PageMove) => {});
    render(
      <Pager
        offset={0}
        limit={20}
        total={5000}
        onChange={onChange}
      />,
    );
    const input = page().getByLabelText("Page") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "9999" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith({ offset: 4980, limit: 20 });
    // A cleared box is not a page, and moves nothing.
    onChange.mockClear();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    // ...and the box goes back to showing where we are.
    expect(input.value).toBe("1");
  });

  it("drops an uncommitted draft when the page moves from elsewhere", () => {
    const { rerender } = render(
      <Pager
        offset={0}
        limit={20}
        total={5000}
        onChange={() => {}}
      />,
    );
    const input = page().getByLabelText("Page") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "137" } });
    expect(input.value).toBe("137");
    // Next was pressed instead: the box shows where we now are, and a blur
    // cannot commit the abandoned number.
    rerender(
      <Pager
        offset={20}
        limit={20}
        total={5000}
        onChange={() => {}}
      />,
    );
    expect((page().getByLabelText("Page") as HTMLInputElement).value).toBe("2");
  });

  it("switches from the input back to a select when the pages fit", () => {
    const { rerender } = render(
      <Pager
        offset={0}
        limit={20}
        total={5000}
        pageSelectMax={4}
        onChange={() => {}}
      />,
    );
    expect((page().getByLabelText("Page") as HTMLElement).tagName).toBe(
      "INPUT",
    );
    rerender(
      <Pager
        offset={0}
        limit={20}
        total={60}
        pageSelectMax={4}
        onChange={() => {}}
      />,
    );
    const select = page().getByLabelText("Page") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(select.options).toHaveLength(3);
  });

  it("disables the page control with the rest", () => {
    render(
      <Pager
        offset={0}
        limit={20}
        total={345}
        disabled
        onChange={() => {}}
      />,
    );
    expect((page().getByLabelText("Page") as HTMLSelectElement).disabled).toBe(
      true,
    );
  });
});

describe("Pager, walking by cursor", () => {
  it("counts the rows, and numbers nothing, on a page whose position is unknown", () => {
    render(
      <Pager
        offset={0}
        limit={20}
        itemCount={20}
        hasMore
        walk={{ canNext: true, canPrev: true, unnumbered: true }}
        onChange={() => {}}
      />,
    );
    const nav = page().getByRole("navigation", { name: "Pagination" });
    // Not "1–20": a walked page on a backend that does not count what
    // precedes it has no row numbers, and inventing them would be a lie in
    // exactly the place a reader trusts.
    expect(nav.textContent).toContain("20 rows");
    expect(nav.textContent).not.toContain("1–20");
    // And no page number either, for the same reason.
    expect(nav.textContent).not.toContain("Page");
    expect(page().queryByLabelText("Page")).toBeNull();
  });

  it("numbers the range again where the walked page does know where it sits", () => {
    render(
      <Pager
        offset={40}
        limit={20}
        itemCount={20}
        hasMore
        walk={{ canNext: true, canPrev: true }}
        onChange={() => {}}
      />,
    );
    expect(
      page().getByRole("navigation", { name: "Pagination" }).textContent,
    ).toContain("41–60");
  });

  it("asks to walk, not to move the offset, with Previous and Next", () => {
    const onChange = mock((_next: PageMove) => {});
    render(
      <Pager
        offset={0}
        limit={20}
        itemCount={20}
        hasMore
        walk={{ canNext: true, canPrev: true, unnumbered: true }}
        onChange={onChange}
      />,
    );
    fireEvent.click(page().getByRole("button", { name: "Next" }));
    fireEvent.click(page().getByRole("button", { name: "Previous" }));
    expect(onChange.mock.calls).toEqual([
      [{ offset: 0, limit: 20, step: "next" }],
      [{ offset: 0, limit: 20, step: "prev" }],
    ]);
  });

  it("walks back although the offset says there is nothing behind it", () => {
    const onChange = mock((_next: PageMove) => {});
    render(
      <Pager
        offset={0}
        limit={20}
        itemCount={20}
        hasMore={false}
        walk={{ canNext: false, canPrev: true, unnumbered: true }}
        onChange={onChange}
      />,
    );
    const prev = page().getByRole("button", { name: "Previous" });
    expect((prev as HTMLButtonElement).disabled).toBe(false);
    // The end of a walk: nothing to walk on to, and no offset to fall back on.
    expect(
      (page().getByRole("button", { name: "Next" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(prev);
    expect(onChange.mock.calls).toEqual([
      [{ offset: 0, limit: 20, step: "prev" }],
    ]);
  });

  it("falls back to the offset where the list cannot be walked", () => {
    const onChange = mock((_next: PageMove) => {});
    render(
      <Pager
        offset={20}
        limit={20}
        itemCount={20}
        hasMore
        // What the Active tab looks like: the API mints no cursor for it, so
        // there is nothing to walk and the offset pager is what is left.
        walk={{ canNext: false, canPrev: false }}
        onChange={onChange}
      />,
    );
    const next = page().getByRole("button", { name: "Next" });
    expect((next as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(next);
    fireEvent.click(page().getByRole("button", { name: "Previous" }));
    expect(onChange.mock.calls).toEqual([
      [{ offset: 40, limit: 20 }],
      [{ offset: 0, limit: 20 }],
    ]);
  });

  it("puts the walk's hint on the buttons that walk, and on no others", () => {
    const { rerender } = render(
      <Pager
        offset={0}
        limit={20}
        itemCount={20}
        hasMore
        walk={{ canNext: true, canPrev: false, hint: "what a walk misses" }}
        onChange={() => {}}
      />,
    );
    expect(page().getByRole("button", { name: "Next" }).title).toBe(
      "what a walk misses",
    );
    // Previous moves the offset here, so the walk's hint is not its business.
    expect(page().getByRole("button", { name: "Previous" }).title).toBe("");
    rerender(
      <Pager
        offset={0}
        limit={20}
        itemCount={20}
        hasMore
        onChange={() => {}}
      />,
    );
    expect(page().getByRole("button", { name: "Next" }).title).toBe("");
  });
});
