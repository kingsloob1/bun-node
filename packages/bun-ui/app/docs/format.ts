/** One shared integer formatter in the browser's locale. */
const integerFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

/** Formats a count, e.g. `12,345`. */
export function formatNumber(value: number): string {
  return integerFormat.format(value);
}
