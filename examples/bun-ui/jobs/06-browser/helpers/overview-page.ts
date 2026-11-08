/**
 * Page-side readers for `06-browser/overview-range.ts`: JavaScript sources
 * evaluated in the page through `Bun.WebView#evaluate`, which read what the
 * Overview shows (or change one control) and answer with plain JSON.
 *
 * They read nothing the example could not read itself from the DOM; they are
 * kept apart only so the example reads as a list of checks.
 */

/** One row of a table on the Overview: its test id's entity and every cell's text. */
export interface RowView {
  /** The runner id or worker key, from the row's `data-testid`. */
  id: string;
  /** Each cell's text, the row header first. */
  cells: string[];
  /**
   * Each cell's link target, in the same order as {@link cells}: the `href` of
   * its first `<a>`, or `null` where the cell is plain text. Cell 0 is the row
   * header (a Workers row's key, a Runners row's runner id) and cell 1 a
   * Workers row's queue; every other cell is a number and has none.
   */
  cellHrefs: (string | null)[];
}

/** One card of the Overview (Jobs, Queues, Runners, Workers), as it is now. */
export interface CardView {
  /** The card's whole text. */
  text: string;
  /** The `aria-label` of the range control in its header, or `null` when it has none. */
  picker: string | null;
  /** That control's selected value (`"3600"`, `"custom"`, …), or `null`. */
  pickerValue: string | null;
  /** The clamped-range caption: its text and `data-clamp-reason`, or `null`. */
  caption: { text: string; reason: string | null } | null;
  /** The RANGE_NOT_RETAINED explanation's text, or `null`. */
  notRetained: string | null;
  /** Whether a Retry button is anywhere in the card. */
  hasRetry: boolean;
  /** An error alert's text, or `null`. */
  alert: string | null;
  /** The "Showing the N busiest … of M" note, or `null`. */
  truncated: string | null;
  /** The analytics rows on screen (Runners and Workers only). */
  rows: RowView[];
  /** The headline figures, label to value. */
  figures: Record<string, string>;
  /** Every sparkline's accessible label. */
  sparklines: string[];
  /** Table column headers, in order. */
  headers: string[];
}

/** One labelled group of the "Over the range" band. */
export interface BandGroupView {
  /** Its heading, or `null` when it has none. */
  title: string | null;
  /** Each label and value, in order. */
  cells: [label: string, value: string][];
}

/** The "Over the range" band. */
export interface BandView {
  /** The head line, e.g. "Over the range in 1-minute buckets". */
  head: string;
  /** Its groups, in order: Finished in range, then Added in range. */
  groups: BandGroupView[];
  /** Whether the added group is still loading. */
  addedLoading: boolean;
}

/** What the Overview shows. */
export interface OverviewView {
  /** `location.search`. */
  search: string;
  /** Whether the Overview has rendered its counts. */
  ready: boolean;
  /** The "Apply date filter to page" checkbox: its label and state, or `null`. */
  scope: { label: string; checked: boolean } | null;
  /** The title row's page-wide range control's value, or `null` when absent. */
  pageRange: string | null;
  /** The label of every range control on the page, in order. */
  pickers: string[];
  /** The "Over the range" band, or `null` when absent. */
  band: BandView | null;
  /** The "Totals" grid's labels. */
  totals: string[];
  /** The cards, by title; a card that is not on the page is absent. */
  cards: Record<string, CardView>;
  /** The whole screen's text. */
  text: string;
}

/** Page-side: a snapshot of the Overview, as an {@link OverviewView}. */
export const READ_OVERVIEW = `(() => {
  const text = (node) => (node ? node.textContent.trim() : null);
  const screen = document.querySelector('[data-testid="overview"]');
  const cards = {};
  for (const card of document.querySelectorAll('[data-testid="overview"] section.card')) {
    const title = text(card.querySelector("h2"));
    if (!title) continue;
    const picker = card.querySelector('.range-picker[role="group"]');
    const caption = card.querySelector('[data-testid$="-range-caption"]');
    const rows = Array.from(
      card.querySelectorAll('[data-testid^="runner-analytics-row-"], [data-testid^="worker-analytics-row-"]'),
      (row) => ({
        id: row.dataset.testid.replace(/^(runner|worker)-analytics-row-/, ""),
        cells: Array.from(row.children, (cell) => cell.textContent.trim()),
        cellHrefs: Array.from(row.children, (cell) => {
          const link = cell.querySelector("a");
          return link ? link.getAttribute("href") : null;
        }),
      }),
    );
    const figures = {};
    for (const stat of card.querySelectorAll(".analytics-headline .stat")) {
      figures[text(stat.querySelector("dt"))] = text(stat.querySelector(".stat-value"));
    }
    cards[title] = {
      text: card.textContent,
      picker: picker ? picker.getAttribute("aria-label") : null,
      pickerValue: picker ? picker.querySelector("select").value : null,
      caption: caption ? { text: text(caption), reason: caption.getAttribute("data-clamp-reason") } : null,
      notRetained: text(card.querySelector('[data-testid$="-range-not-retained"]')),
      hasRetry: Array.from(card.querySelectorAll("button")).some((b) => b.textContent.trim() === "Retry"),
      alert: text(card.querySelector('[role="alert"]')),
      truncated: text(card.querySelector('[data-testid$="-truncated"]')),
      rows,
      figures,
      sparklines: Array.from(card.querySelectorAll('[role="img"]'), (image) => image.getAttribute("aria-label")),
      headers: Array.from(card.querySelectorAll("thead th"), (cell) => cell.textContent.trim()),
    };
  }
  const bandRoot = document.querySelector('[data-testid="range-stat"]');
  const band = bandRoot
    ? {
        head: Array.from(bandRoot.querySelector(".range-band-head").children, (part) => part.textContent.trim()).join(" "),
        groups: Array.from(bandRoot.querySelectorAll(".range-group"), (group) => ({
          title: group.querySelector(".range-group-title")
            ? group.querySelector(".range-group-title").textContent.trim().replace(/\\s+/g, " ")
            : null,
          cells: Array.from(group.querySelectorAll(".range-cell"), (cell) => [
            text(cell.querySelector("dt")),
            text(cell.querySelector("dd")),
          ]),
        })),
        addedLoading: !!bandRoot.querySelector('[data-testid="range-stat-added"] [role="status"], [data-testid="range-stat-added"] .spinner'),
      }
    : null;
  const scopeBox = document.querySelector(".range-scope input[type=checkbox]");
  const pagePicker = document.querySelector('.overview-range .range-picker[role="group"] select');
  return {
    search: location.search,
    ready: !!document.querySelector('[data-testid="state-counts"]'),
    scope: scopeBox
      ? { label: text(document.querySelector('label[for="' + scopeBox.id + '"]')), checked: scopeBox.checked }
      : null,
    pageRange: pagePicker ? pagePicker.value : null,
    pickers: Array.from(document.querySelectorAll('.range-picker[role="group"]'), (group) => group.getAttribute("aria-label")),
    band,
    totals: Array.from(document.querySelectorAll('[aria-label="Totals"] .stat-label'), (label) => label.textContent.trim()),
    cards,
    text: screen ? screen.textContent : "",
  };
})()`;

/**
 * Page-side: picks `value` in the range control labelled `label` (e.g.
 * "Jobs range"), as a user choosing from the list would. Resolves whether the
 * control was there.
 */
export function chooseRange(label: string, value: string): string {
  return `(() => {
    const select = document.querySelector(${JSON.stringify(`.range-picker[role="group"][aria-label="${label}"] select`)});
    if (!select) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(select, ${JSON.stringify(value)});
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`;
}

/** Page-side: clicks the "Apply date filter to page" checkbox. Resolves whether it was there. */
export const TOGGLE_SCOPE = `(() => {
  const box = document.querySelector(".range-scope input[type=checkbox]");
  if (!box) return false;
  box.click();
  return true;
})()`;
