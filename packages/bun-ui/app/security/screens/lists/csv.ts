/**
 * The lists' CSV import and export (ui.md §4.1). One header line, then one
 * entry per line:
 *
 * ```csv
 * kind,value,action,override,locked,paths,expiresAt,reason,mode
 * ip,203.0.113.0/24,block,,,,2026-12-01T00:00:00Z,abuse,
 * country,KP,drop,,true,,,,
 * ```
 *
 * `kind` is one of `ip`, `userHash`, `user`, `apiKeyHash`, `apiKey`,
 * `country`, `asn`; `paths` holds route prefixes separated by `;` or
 * spaces; the booleans read `true`/`false` (or `yes`/`no`, `1`/`0`, empty
 * for false). An import holds at most {@link MAX_IMPORT_ROWS} rows and is
 * checked whole before anything is written: one bad line refuses it, every
 * problem listed by line. An export writes account entries as their keys,
 * and never a raw account id.
 */
import type { ListEntryDto } from "./entries";
import type { EntryField, EntryInput, InputKind } from "./validate";
import { entryKey, MAX_IMPORT_ROWS } from "./entries";
import { checkEntry, INPUT_KINDS } from "./validate";

/** The columns, in order. */
export const CSV_COLUMNS = [
  "kind",
  "value",
  "action",
  "override",
  "locked",
  "paths",
  "expiresAt",
  "reason",
  "mode",
] as const;

/** One problem of an import. */
export interface ImportProblem {
  /** The line (1 is the header). */
  readonly line: number;
  /** What is wrong. */
  readonly message: string;
}

/** An import's outcome: every entry, or every problem (never both). */
export type ImportResult =
  | { readonly ok: true; readonly entries: ListEntryDto[] }
  | { readonly ok: false; readonly problems: ImportProblem[] };

/** A record and the line it starts on. */
interface CsvRecord {
  /** Its line, 1-based. */
  readonly line: number;
  /** Its cells. */
  readonly cells: string[];
}

/** Splits CSV text into records (RFC 4180: quoted cells may hold commas, quotes and line breaks). */
export function parseCsv(text: string): CsvRecord[] | ImportProblem {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  let i = 0;
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  const endRecord = () => {
    cells.push(cell);
    if (!(cells.length === 1 && cells[0].trim() === ""))
      records.push({ line: start, cells });
    cells = [];
    cell = "";
  };
  while (i < body.length) {
    const char = body[i];
    if (quoted) {
      if (char === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        if (char === "\n") line += 1;
        cell += char;
      }
      i += 1;
      continue;
    }
    if (char === '"' && cell === "") quoted = true;
    else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      endRecord();
      if (char === "\r" && body[i + 1] === "\n") i += 1;
      line += 1;
      start = line;
    } else cell += char;
    i += 1;
  }
  if (quoted) return { line: start, message: "A quoted cell is never closed" };
  endRecord();
  return records;
}

/** A boolean cell, or `undefined` when it reads as neither. */
function booleanCell(text: string): boolean | undefined {
  const value = text.trim().toLowerCase();
  if (["", "false", "no", "0"].includes(value)) return false;
  if (["true", "yes", "1"].includes(value)) return true;
  return undefined;
}

/** Undoes the export's spreadsheet guard (a `'` before `=`, `+`, `-`, `@`). */
function unguard(text: string): string {
  return /^'[=+\-@\t\r]/.test(text) ? text.slice(1) : text;
}

/** Each field's column name, for a problem's message. */
const FIELD_COLUMNS: Readonly<Record<EntryField, string>> = {
  kind: "kind",
  value: "value",
  action: "action",
  override: "override",
  paths: "paths",
  expiresAt: "expiresAt",
  reason: "reason",
  mode: "mode",
};

/**
 * Reads an import; see the module's description. `existing` are the keys
 * already in the scope's lists, which a row may not repeat.
 */
export function importCsv(
  text: string,
  existing: ReadonlySet<string> = new Set(),
): ImportResult {
  const parsed = parseCsv(text);
  if (!Array.isArray(parsed)) return { ok: false, problems: [parsed] };
  const [header, ...rows] = parsed;
  if (header === undefined)
    return { ok: false, problems: [{ line: 1, message: "The file is empty" }] };
  const names = header.cells.map((name) => name.trim());
  const at = new Map(names.map((name, index) => [name, index]));
  const missing = ["kind", "value", "action"].filter((name) => !at.has(name));
  const unknown = names.filter(
    (name) => !(CSV_COLUMNS as readonly string[]).includes(name),
  );
  if (missing.length > 0 || unknown.length > 0) {
    return {
      ok: false,
      problems: [
        {
          line: header.line,
          message: [
            missing.length > 0
              ? `missing column(s): ${missing.join(", ")}`
              : "",
            unknown.length > 0
              ? `unknown column(s): ${unknown.join(", ")}`
              : "",
          ]
            .filter(Boolean)
            .join("; ")
            .replace(/^./, (first) => first.toUpperCase()),
        },
      ],
    };
  }
  if (rows.length === 0)
    return { ok: false, problems: [{ line: header.line, message: "No rows" }] };
  if (rows.length > MAX_IMPORT_ROWS) {
    return {
      ok: false,
      problems: [
        {
          line: header.line,
          message: `The file holds ${rows.length.toLocaleString("en")} rows; one import takes at most ${MAX_IMPORT_ROWS.toLocaleString("en")}`,
        },
      ],
    };
  }
  const problems: ImportProblem[] = [];
  const entries: ListEntryDto[] = [];
  const seen = new Map<string, number>();
  for (const row of rows) {
    const cell = (name: (typeof CSV_COLUMNS)[number]) => {
      const index = at.get(name);
      return index === undefined ? "" : (row.cells[index] ?? "");
    };
    if (row.cells.length > names.length) {
      problems.push({
        line: row.line,
        message: `${row.cells.length} cells; the header names ${names.length}`,
      });
      continue;
    }
    const kind = cell("kind").trim();
    if (!(INPUT_KINDS as readonly string[]).includes(kind)) {
      problems.push({
        line: row.line,
        message: `kind: one of ${INPUT_KINDS.join(", ")}`,
      });
      continue;
    }
    const override = booleanCell(cell("override"));
    const locked = booleanCell(cell("locked"));
    if (override === undefined || locked === undefined) {
      problems.push({
        line: row.line,
        message: `${override === undefined ? "override" : "locked"}: true or false`,
      });
      continue;
    }
    const value =
      kind === "country" ? cell("value").trim().toUpperCase() : cell("value");
    const input: EntryInput = {
      kind: kind as InputKind,
      value,
      action: cell("action").trim() as EntryInput["action"],
      override,
      locked,
      paths: cell("paths"),
      expiresAt: cell("expiresAt"),
      reason: unguard(cell("reason")),
      mode: cell("mode").trim() as EntryInput["mode"],
    };
    const checked = checkEntry(input);
    if (!checked.ok) {
      for (const [field, message] of Object.entries(checked.errors)) {
        problems.push({
          line: row.line,
          message: `${FIELD_COLUMNS[field as EntryField]}: ${message}`,
        });
      }
      continue;
    }
    const key = entryKey(checked.entry);
    const first = seen.get(key);
    if (existing.has(key)) {
      problems.push({
        line: row.line,
        message: "Already listed in this scope",
      });
    } else if (first !== undefined) {
      problems.push({
        line: row.line,
        message: `Repeats line ${first}`,
      });
    } else {
      seen.set(key, row.line);
      entries.push(checked.entry);
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, entries };
}

/** A cell, quoted when it needs to be; text a spreadsheet would run as a formula is guarded with a `'`. */
function csvCell(value: string, guard = false): string {
  const text = guard && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** The export of `entries`, and how many were left out (a raw account id is never written). */
export function toCsv(entries: readonly ListEntryDto[]): {
  readonly text: string;
  readonly skipped: number;
} {
  const lines = [CSV_COLUMNS.join(",")];
  let skipped = 0;
  for (const entry of entries) {
    let kind: InputKind;
    let value: string;
    if (entry.ip !== undefined) [kind, value] = ["ip", entry.ip];
    else if (entry.userHash !== undefined)
      [kind, value] = ["userHash", entry.userHash];
    else if (entry.apiKeyHash !== undefined)
      [kind, value] = ["apiKeyHash", entry.apiKeyHash];
    else if (entry.country !== undefined)
      [kind, value] = ["country", entry.country];
    else if (entry.asn !== undefined)
      [kind, value] = ["asn", String(entry.asn)];
    else {
      skipped += 1;
      continue;
    }
    lines.push(
      [
        kind,
        csvCell(value),
        entry.action,
        entry.override === true ? "true" : "",
        entry.locked === true ? "true" : "",
        csvCell((entry.paths ?? []).join(";")),
        csvCell(entry.expiresAt ?? ""),
        csvCell(entry.reason ?? "", true),
        entry.mode ?? "",
      ].join(","),
    );
  }
  return { text: `${lines.join("\n")}\n`, skipped };
}
