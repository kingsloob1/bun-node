import type { JsonEditorState, JsonEditorStateOptions } from "./jsonParse";
import { useId, useMemo } from "react";
import { Button } from "./Button";
import { cx } from "./classNames";
import { joinIds, useField } from "./fieldContext";
import { formatBytes, jsonEditorState } from "./jsonParse";

/** Props of {@link JsonEditor}. */
export interface JsonEditorProps extends JsonEditorStateOptions {
  /** The text (controlled). Seed it with `JSON.stringify(value, null, 2)`. */
  value: string;
  /** Called on every edit, format and minify with the new state. */
  onChange: (state: JsonEditorState) => void;
  /** Visible rows. Defaults to `10`. */
  rows?: number;
  /** Accessible name when not inside a `Field`. */
  "aria-label"?: string;
  /** The textarea's id. Defaults to the enclosing field's, or a generated one. */
  id?: string;
  /** Read-only: no editing, no format/minify. */
  readOnly?: boolean;
  /** Disabled. */
  disabled?: boolean;
  /** Placeholder text. */
  placeholder?: string;
  /** Extra class names on the wrapper. */
  className?: string;
}

/**
 * A plain-textarea JSON editor: the parse error with line and column, a
 * UTF-8 size meter against `maxBytes` (turning red over it), and Format /
 * Minify. Inside a `Field` it takes the field's id and description.
 */
export function JsonEditor({
  value: text,
  onChange,
  maxBytes,
  allowEmpty = false,
  rows = 10,
  "aria-label": ariaLabel,
  id,
  readOnly = false,
  disabled = false,
  placeholder,
  className,
}: JsonEditorProps) {
  const field = useField();
  const generatedId = useId();
  const inputId = id ?? field?.id ?? generatedId;
  const errorId = `${inputId}-json-error`;
  const sizeId = `${inputId}-json-size`;
  const state = useMemo(
    () => jsonEditorState(text, { maxBytes, allowEmpty }),
    [text, maxBytes, allowEmpty],
  );
  const emit = (next: string) =>
    onChange(jsonEditorState(next, { maxBytes, allowEmpty }));
  const reformat = (indent: number | undefined) => {
    if (state.error === null && state.value !== undefined) {
      emit(JSON.stringify(state.value, null, indent));
    }
  };
  const canFormat =
    !readOnly && !disabled && state.error === null && state.value !== undefined;

  return (
    <div
      className={cx(
        "json-editor",
        !state.valid && "json-editor-invalid",
        className,
      )}
    >
      <textarea
        id={inputId}
        className="input json-editor-text"
        rows={rows}
        value={text}
        placeholder={placeholder}
        readOnly={readOnly}
        disabled={disabled}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        aria-label={ariaLabel}
        aria-invalid={!state.valid || field?.["aria-invalid"] || undefined}
        aria-required={field?.required}
        aria-describedby={joinIds(
          field?.["aria-describedby"],
          state.error && errorId,
          sizeId,
        )}
        onChange={(event) => emit(event.target.value)}
      />
      <div className="json-editor-bar">
        {state.error ? (
          <p
            id={errorId}
            className="json-editor-error"
          >
            Line {state.error.line}, column {state.error.column}:{" "}
            {state.error.message}
          </p>
        ) : (
          <p className="json-editor-ok muted">Valid JSON</p>
        )}
        <span
          id={sizeId}
          className={cx("json-editor-size", state.overLimit && "is-over")}
        >
          {maxBytes !== undefined && (
            <meter
              className="json-editor-meter"
              min={0}
              max={maxBytes}
              low={maxBytes * 0.8}
              high={maxBytes}
              optimum={0}
              value={Math.min(state.bytes, maxBytes)}
              aria-hidden="true"
            />
          )}
          {maxBytes === undefined
            ? formatBytes(state.bytes)
            : state.overLimit
              ? `${formatBytes(state.bytes)} of ${formatBytes(maxBytes)}: over the limit by ${formatBytes(state.bytes - maxBytes)}`
              : `${formatBytes(state.bytes)} of ${formatBytes(maxBytes)}`}
        </span>
        {!readOnly && (
          <span className="json-editor-actions">
            <Button
              size="sm"
              disabled={!canFormat}
              onClick={() => reformat(2)}
            >
              Format
            </Button>
            <Button
              size="sm"
              disabled={!canFormat}
              onClick={() => reformat(undefined)}
            >
              Minify
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}
