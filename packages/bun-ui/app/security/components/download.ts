/** Saves text the app made (a CSV, the audit export) as a file the browser downloads. */

/** Saves `text` as the file `name`, of `type`. */
export function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}
