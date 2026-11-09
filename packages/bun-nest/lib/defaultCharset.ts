/**
 * The media types outside `text/*` that `mime-db` gives a default charset, as
 * Express's `mime.contentType` reads them; `__tests__/replyCompat.nest.test.ts`
 * holds this to the `mime-types` Express resolves, entry by entry.
 */
const DEFAULT_CHARSETS: Readonly<Record<string, string>> = {
  "application/3gpdash-qoe-report+xml": "utf-8",
  "application/beep+xml": "utf-8",
  "application/cda+xml": "utf-8",
  "application/elm+json": "utf-8",
  "application/emergencycalldata.cap+xml": "utf-8",
  "application/fhir+json": "utf-8",
  "application/fhir+xml": "utf-8",
  "application/hl7v2+xml": "utf-8",
  "application/im-iscomposing+xml": "utf-8",
  "application/javascript": "utf-8",
  "application/json": "utf-8",
  "application/manifest+json": "utf-8",
  "application/msc-ivr+xml": "utf-8",
  "application/msc-mixer+xml": "utf-8",
  "application/news-checkgroups": "us-ascii",
  "application/news-groupinfo": "us-ascii",
  "application/pidf+xml": "utf-8",
  "application/pidf-diff+xml": "utf-8",
  "application/poc-settings+xml": "utf-8",
  "application/prs.cyn": "7-bit",
  "application/vnd.fdsn.stationxml+xml": "xml-based",
  "application/vnd.omads-email+xml": "utf-8",
  "application/vnd.omads-file+xml": "utf-8",
  "application/vnd.omads-folder+xml": "utf-8",
  "application/vnd.syncml+xml": "utf-8",
  "application/vnd.syncml.dm+wbxml": "utf-8",
  "application/vnd.syncml.dm+xml": "utf-8",
  "application/vnd.syncml.dmddf+xml": "utf-8",
  "application/vnd.syncml.dmtnds+xml": "utf-8",
  "application/vnd.wap.wbxml": "utf-8",
};

/**
 * `type` with the charset Express's `res.set("Content-Type", type)` adds when
 * it names none: `mime-types`' `contentType`, for a type already holding a `/`.
 * So `text/plain` is `text/plain; charset=utf-8`, and a type with no default
 * charset (`application/octet-stream`) is left alone.
 */
export function withDefaultCharset(type: string): string {
  if (type.includes("charset")) {
    return type;
  }
  const [essence = ""] = /^\s*[^;\s]*/.exec(type) ?? [];
  const name = essence.trim().toLowerCase();
  const charset =
    DEFAULT_CHARSETS[name] ?? (name.startsWith("text/") ? "utf-8" : undefined);
  return charset === undefined ? type : `${type}; charset=${charset}`;
}
