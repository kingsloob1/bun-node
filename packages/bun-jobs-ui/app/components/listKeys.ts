/**
 * Arrow-key movement through a vertical list of links (the API docs
 * sidebars): Down/Up to the next/previous item, stopping at the ends,
 * Home/End to the first/last. Each item stays a Tab stop too, so this adds
 * speed without hiding anything from Tab.
 */

/** The item a key moves focus to from `active`, or `null` when the key is not a movement key (or the list is empty). */
export function arrowTarget<T extends Element>(
  key: string,
  items: readonly T[],
  active: Element | null,
): T | null {
  if (items.length === 0) {
    return null;
  }
  const index = active ? items.indexOf(active as T) : -1;
  switch (key) {
    case "ArrowDown":
      return items[index < 0 ? 0 : Math.min(index + 1, items.length - 1)]!;
    case "ArrowUp":
      return items[index <= 0 ? 0 : index - 1]!;
    case "Home":
      return items[0]!;
    case "End":
      return items[items.length - 1]!;
    default:
      return null;
  }
}
