/**
 * A small structural accessibility audit of a rendered document: the rules a
 * DOM without layout can check. It is not axe — it knows nothing of colour
 * (see `contrast.test.ts`) or of what a pointer can reach — but it catches
 * the regressions a screen actually suffers: a second `h1`, a skipped
 * heading level, an unlabelled input, an icon button with no name, a table
 * with no name, an ARIA reference to an id that does not exist.
 *
 * Each rule returns readable findings (`rule: element — why`), so a failing
 * test names the element to fix.
 */

/** One problem the audit found. */
export interface AuditFinding {
  /** The rule broken, e.g. `"one-h1"`. */
  rule: string;
  /** What and where, in words. */
  detail: string;
}

/** Options of {@link auditDocument}. */
export interface AuditOptions {
  /** Where to look. Defaults to `document.body`. */
  root?: HTMLElement;
  /** Rules to skip, by name. */
  skip?: readonly string[];
}

/** A short description of an element for a finding. */
function describe(element: Element): string {
  const id = element.id ? `#${element.id}` : "";
  const testId = element.getAttribute("data-testid");
  const classes = element.getAttribute("class");
  const text = (element.textContent ?? "").trim().slice(0, 40);
  return `<${element.tagName.toLowerCase()}${id}${testId ? ` data-testid="${testId}"` : ""}${classes ? ` class="${classes}"` : ""}>${text ? ` "${text}"` : ""}`;
}

/** Whether `element` or an ancestor hides it from assistive technology. */
function isHidden(element: Element): boolean {
  for (
    let node: Element | null = element;
    node !== null;
    node = node.parentElement
  ) {
    if (
      node.getAttribute("aria-hidden") === "true" ||
      node.hasAttribute("hidden") ||
      node.hasAttribute("inert")
    ) {
      return true;
    }
    // A closed <dialog> renders nothing.
    if (node.tagName === "DIALOG" && !node.hasAttribute("open")) {
      return true;
    }
  }
  return false;
}

/** Text an element contributes to a name: its text, minus aria-hidden parts. */
function visibleText(element: Element): string {
  let text = "";
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === 3) {
      text += child.textContent ?? "";
    } else if (child.nodeType === 1) {
      const el = child as Element;
      if (el.getAttribute("aria-hidden") === "true") {
        continue;
      }
      if (el.tagName === "IMG") {
        text += el.getAttribute("alt") ?? "";
        continue;
      }
      if (el.tagName === "svg" || el.tagName === "SVG") {
        text += el.getAttribute("aria-label") ?? "";
        continue;
      }
      text += el.getAttribute("aria-label") ?? visibleText(el);
    }
  }
  return text;
}

/** The text of the elements an `aria-labelledby` names. */
function labelledByText(element: Element): string {
  const ids = element.getAttribute("aria-labelledby");
  if (!ids) {
    return "";
  }
  return ids
    .split(/\s+/)
    .map((id) => element.ownerDocument.getElementById(id))
    .map((target) => (target ? visibleText(target) : ""))
    .join(" ");
}

/** The accessible name of a control, button or link (a simplified accname). */
export function accessibleName(element: Element): string {
  const byRef = labelledByText(element).trim();
  if (byRef) {
    return byRef;
  }
  const aria = element.getAttribute("aria-label")?.trim();
  if (aria) {
    return aria;
  }
  const tag = element.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
    const labels = (element as HTMLInputElement).labels;
    const fromLabels = labels
      ? Array.from(labels, (label) => visibleText(label))
          .join(" ")
          .trim()
      : "";
    if (fromLabels) {
      return fromLabels;
    }
    const wrapping = element.closest("label");
    if (wrapping) {
      return visibleText(wrapping).trim();
    }
    return element.getAttribute("title")?.trim() ?? "";
  }
  return (
    visibleText(element).trim() || element.getAttribute("title")?.trim() || ""
  );
}

/** `h1`…`h6` and `role="heading"` in document order, visible to AT. */
function headings(root: HTMLElement): { element: Element; level: number }[] {
  return Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]"))
    .filter((element) => !isHidden(element))
    .map((element) => ({
      element,
      level:
        element.getAttribute("role") === "heading"
          ? Number(element.getAttribute("aria-level") ?? 2)
          : Number(element.tagName.slice(1)),
    }));
}

/** The audit's rules, by name. */
const RULES: Record<string, (root: HTMLElement) => AuditFinding[]> = {
  /** Exactly one visible `h1`. */
  "one-h1": (root) => {
    const ones = headings(root).filter((heading) => heading.level === 1);
    return ones.length === 1
      ? []
      : [
          {
            rule: "one-h1",
            detail: `${ones.length} h1 elements${ones.length > 0 ? `: ${ones.map((one) => describe(one.element)).join(", ")}` : ""}`,
          },
        ];
  },

  /** No heading more than one level deeper than the one before it; the first is an h1. Dialogs start their own outline. */
  "heading-order": (root) => {
    const findings: AuditFinding[] = [];
    const outside = headings(root).filter(
      (heading) => heading.element.closest("dialog") === null,
    );
    let previous = 0;
    for (const { element, level } of outside) {
      if (level > previous + 1) {
        findings.push({
          rule: "heading-order",
          detail: `${describe(element)} is an h${level} after an h${previous || "(none)"}`,
        });
      }
      previous = level;
    }
    return findings;
  },

  /** A skip link, one `main` it targets, a banner and a navigation landmark. */
  landmarks: (root) => {
    const findings: AuditFinding[] = [];
    const mains = root.querySelectorAll("main,[role=main]");
    if (mains.length !== 1) {
      findings.push({
        rule: "landmarks",
        detail: `${mains.length} main landmarks`,
      });
    }
    if (!root.querySelector("header,[role=banner]")) {
      findings.push({ rule: "landmarks", detail: "no header (banner)" });
    }
    if (!root.querySelector("nav,[role=navigation]")) {
      findings.push({ rule: "landmarks", detail: "no nav landmark" });
    }
    const skip = root.querySelector<HTMLAnchorElement>("a.skip-link");
    const target = skip?.getAttribute("href")?.slice(1);
    if (
      !skip ||
      !target ||
      root.ownerDocument.getElementById(target) !== mains[0]
    ) {
      findings.push({
        rule: "landmarks",
        detail: "no skip link to the main landmark",
      });
    }
    return findings;
  },

  /** Every form control has an accessible name. */
  "control-name": (root) =>
    Array.from(
      root.querySelectorAll(
        "input:not([type=hidden]),select,textarea,[role=combobox],[role=textbox],[role=switch],[role=checkbox]",
      ),
    )
      .filter((element) => !isHidden(element) && !accessibleName(element))
      .map((element) => ({
        rule: "control-name",
        detail: `${describe(element)} has no label`,
      })),

  /** Every button and link has an accessible name. */
  "button-name": (root) =>
    Array.from(
      root.querySelectorAll(
        "button,a[href],[role=button],[role=link],[role=tab]",
      ),
    )
      .filter((element) => !isHidden(element) && !accessibleName(element))
      .map((element) => ({
        rule: "button-name",
        detail: `${describe(element)} has no accessible name`,
      })),

  /** Every table is named, and every header cell has a scope. */
  table: (root) => {
    const findings: AuditFinding[] = [];
    for (const table of Array.from(root.querySelectorAll("table"))) {
      if (isHidden(table)) {
        continue;
      }
      const caption = table.querySelector("caption")?.textContent?.trim();
      if (!caption && !accessibleNameOfRegion(table)) {
        findings.push({
          rule: "table",
          detail: `${describe(table)} has no caption or label`,
        });
      }
      for (const th of Array.from(table.querySelectorAll("th"))) {
        if (!th.hasAttribute("scope")) {
          findings.push({
            rule: "table",
            detail: `${describe(th)} has no scope`,
          });
        }
      }
    }
    return findings;
  },

  /** Every id an ARIA relation names exists. */
  "aria-refs": (root) => {
    const findings: AuditFinding[] = [];
    for (const attribute of [
      "aria-labelledby",
      "aria-describedby",
      "aria-controls",
    ]) {
      for (const element of Array.from(
        root.querySelectorAll(`[${attribute}]`),
      )) {
        for (const id of (element.getAttribute(attribute) ?? "")
          .split(/\s+/)
          .filter(Boolean)) {
          if (!root.ownerDocument.getElementById(id)) {
            findings.push({
              rule: "aria-refs",
              detail: `${describe(element)} ${attribute} names missing #${id}`,
            });
          }
        }
      }
    }
    return findings;
  },

  /** No duplicate ids. */
  "unique-ids": (root) => {
    const seen = new Map<string, number>();
    for (const element of Array.from(root.querySelectorAll("[id]"))) {
      seen.set(element.id, (seen.get(element.id) ?? 0) + 1);
    }
    return [...seen]
      .filter(([, count]) => count > 1)
      .map(([id, count]) => ({
        rule: "unique-ids",
        detail: `#${id} appears ${count} times`,
      }));
  },

  /** No positive `tabindex`: it reorders the page's tab sequence. */
  tabindex: (root) =>
    Array.from(root.querySelectorAll("[tabindex]"))
      .filter((element) => Number(element.getAttribute("tabindex")) > 0)
      .map((element) => ({
        rule: "tabindex",
        detail: `${describe(element)} has a positive tabindex`,
      })),
};

/** A table's `aria-label`/`aria-labelledby` name. */
function accessibleNameOfRegion(table: Element): string {
  return (
    labelledByText(table).trim() ||
    table.getAttribute("aria-label")?.trim() ||
    ""
  );
}

/** The names of every rule {@link auditDocument} runs. */
export const AUDIT_RULES: readonly string[] = Object.keys(RULES);

/** Runs every rule (minus `skip`) over `root` and returns the findings. */
export function auditDocument(options: AuditOptions = {}): AuditFinding[] {
  const root = options.root ?? document.body;
  const skip = new Set(options.skip ?? []);
  return Object.entries(RULES)
    .filter(([name]) => !skip.has(name))
    .flatMap(([, rule]) => rule(root));
}

/** The findings as lines, for a readable assertion. */
export function formatFindings(findings: readonly AuditFinding[]): string[] {
  return findings.map((finding) => `${finding.rule}: ${finding.detail}`);
}
