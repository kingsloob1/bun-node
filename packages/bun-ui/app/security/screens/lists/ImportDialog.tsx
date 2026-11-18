/**
 * The lists' CSV import (ui.md §4.1): a file, or text pasted, checked whole
 * ({@link importCsv}) before anything is written. A file with any bad line
 * is refused with every problem listed by line; a good one's entries join
 * the screen's unsaved changes, saved with the draft.
 */
import type { ChangeEvent } from "react";
import type { ListEntryDto } from "./entries";
import type { ImportResult } from "./csv";
import { useState } from "react";
import { Button } from "../../../kit/components/Button";
import { Dialog } from "../../../kit/components/Dialog";
import { Field } from "../../../kit/components/Field";
import { CSV_COLUMNS, importCsv } from "./csv";
import { MAX_IMPORT_ROWS } from "./entries";

/** The most problems listed (the rest are counted). */
const SHOWN_PROBLEMS = 100;

/** Props of {@link ImportDialog}. */
export interface ImportDialogProps {
  /** Whether it is showing. */
  open: boolean;
  /** Closes it. */
  onClose: () => void;
  /** The keys already in the scope's lists (a row may not repeat one). */
  existing: ReadonlySet<string>;
  /** Called with a checked file's entries. */
  onImport: (entries: ListEntryDto[]) => void;
}

/** See the module's description. */
export function ImportDialog(props: ImportDialogProps) {
  return props.open ? <OpenImportDialog {...props} /> : null;
}

/** The mounted dialog. */
function OpenImportDialog({ onClose, existing, onImport }: ImportDialogProps) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const check = (csv: string) => setResult(importCsv(csv, existing));
  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    const csv = await file.text();
    setText(csv);
    check(csv);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Import entries from CSV"
      description={`At most ${MAX_IMPORT_ROWS.toLocaleString("en")} rows. The file is checked whole: nothing is added unless every line is good.`}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button onClick={() => check(text)}>Check</Button>
          <Button
            variant="primary"
            disabled={result?.ok !== true}
            onClick={() => {
              if (result?.ok === true) {
                onImport(result.entries);
                onClose();
              }
            }}
          >
            {result?.ok === true
              ? `Add ${result.entries.length.toLocaleString("en")} to the draft`
              : "Add to the draft"}
          </Button>
        </>
      }
    >
      <p className="field-hint">
        Columns: <code>{CSV_COLUMNS.join(",")}</code>. A kind is one of{" "}
        <code>ip</code>, <code>userHash</code>, <code>user</code>,{" "}
        <code>apiKeyHash</code>, <code>apiKey</code>, <code>country</code>,{" "}
        <code>asn</code>; a <code>user</code> or <code>apiKey</code> id is keyed
        when the draft is saved. Paths are separated by <code>;</code>.
      </p>
      <Field label="CSV file">
        {(control) => (
          <input
            {...control}
            type="file"
            accept=".csv,text/csv,text/plain"
            data-testid="lists-import-file"
            onChange={(event) => void onFile(event)}
          />
        )}
      </Field>
      <Field label="Or paste the CSV">
        {(control) => (
          <textarea
            {...control}
            className="input lists-import-text"
            rows={8}
            spellCheck={false}
            value={text}
            data-testid="lists-import-text"
            onChange={(event) => {
              setText(event.target.value);
              setResult(null);
            }}
          />
        )}
      </Field>
      {result === null ? null : result.ok ? (
        <p
          role="status"
          data-testid="lists-import-ok"
        >
          {result.entries.length === 1
            ? "1 entry is ready to add."
            : `${result.entries.length.toLocaleString("en")} entries are ready to add.`}
        </p>
      ) : (
        <div
          className="problem-banner"
          role="alert"
          data-testid="lists-import-problems"
        >
          <p className="problem-banner-title">
            <strong>
              The file was refused:{" "}
              {result.problems.length.toLocaleString("en")} problem(s). Nothing
              was added.
            </strong>
          </p>
          <ul className="problem-banner-issues">
            {result.problems.slice(0, SHOWN_PROBLEMS).map((problem) => (
              <li
                key={`${problem.line}:${problem.message}`}
                data-testid="lists-import-problem"
              >
                Line {problem.line}: {problem.message}
              </li>
            ))}
          </ul>
          {result.problems.length > SHOWN_PROBLEMS ? (
            <p>
              and{" "}
              {(result.problems.length - SHOWN_PROBLEMS).toLocaleString("en")}{" "}
              more
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
