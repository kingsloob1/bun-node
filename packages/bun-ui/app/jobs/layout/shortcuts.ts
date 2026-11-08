/**
 * The app's keyboard shortcuts, as pure functions over a key event, so the
 * rules (and the "not while typing" guard) are testable without rendering.
 */

/**
 * Marks a screen's search box for the `/` shortcut:
 * `<input {...SEARCH_SHORTCUT} />`. It also sets `aria-keyshortcuts`, so a
 * screen reader announces the shortcut on the box.
 */
export const SEARCH_SHORTCUT = {
  "data-shortcut": "search",
  "aria-keyshortcuts": "/",
} as const;

/** A shortcut the app answers. */
export type ShortcutAction = "focus-search" | "show-help";

/** One row of the help dialog. */
export interface ShortcutHelp {
  /** The keys, each rendered as a `<kbd>`. */
  keys: readonly string[];
  /** What they do. */
  description: string;
}

/** What the `?` dialog lists: the two shortcuts, then the keys the widgets answer. */
export const SHORTCUT_HELP: readonly ShortcutHelp[] = [
  { keys: ["/"], description: "Focus the screen's search box" },
  { keys: ["?"], description: "Show these shortcuts" },
  { keys: ["Esc"], description: "Close a dialog" },
  {
    keys: ["←", "→", "Home", "End"],
    description: "Move between tabs (queue states, panels)",
  },
  {
    keys: ["↑", "↓", "Home", "End"],
    description: "Move through the API docs sidebars (↓ from their search box)",
  },
];

/** Whether the event comes from somewhere the user types: a shortcut must not steal the key. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).tagName !== "string") {
    return false;
  }
  const element = target as HTMLElement;
  const tag = element.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  if (tag === "INPUT") {
    const type = (element as HTMLInputElement).type;
    return ![
      "checkbox",
      "radio",
      "button",
      "submit",
      "reset",
      "range",
      "color",
      "file",
    ].includes(type);
  }
  return (
    element.isContentEditable ||
    element.closest?.("[contenteditable]:not([contenteditable='false'])") !==
      null
  );
}

/** The parts of a key event {@link shortcutFor} reads. */
export interface ShortcutKeyEvent {
  /** `KeyboardEvent.key`. */
  key: string;
  /** Where it happened. */
  target: EventTarget | null;
  /** Modifier state. */
  ctrlKey: boolean;
  /** Modifier state. */
  metaKey: boolean;
  /** Modifier state. */
  altKey: boolean;
  /** Something else handled it already. */
  defaultPrevented: boolean;
  /** IME composition in progress. */
  isComposing?: boolean;
}

/**
 * The shortcut a key press means, or `null`. Nothing fires while typing in
 * a field, with Ctrl/Meta/Alt held (the browser's own shortcuts), during
 * composition, or after another handler took the key.
 */
export function shortcutFor(event: ShortcutKeyEvent): ShortcutAction | null {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    isTypingTarget(event.target)
  ) {
    return null;
  }
  if (event.key === "/") {
    return "focus-search";
  }
  if (event.key === "?") {
    return "show-help";
  }
  return null;
}

/** The current screen's search box (the first enabled one marked with {@link SEARCH_SHORTCUT}), if it has one. */
export function findSearchBox(root: ParentNode): HTMLInputElement | null {
  const candidates = root.querySelectorAll<HTMLInputElement>(
    '[data-shortcut="search"]',
  );
  for (const candidate of Array.from(candidates)) {
    if (!candidate.disabled && candidate.closest("[inert],[hidden]") === null) {
      return candidate;
    }
  }
  return null;
}
