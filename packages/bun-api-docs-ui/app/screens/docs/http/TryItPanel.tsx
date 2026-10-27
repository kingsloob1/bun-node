import type { RawResponse } from "../../../api/client";
import type { JsonEditorState } from "../../../components/jsonParse";
import type { SchemaRoot } from "../schema/resolve";
import type { DocOperation, DocParameter } from "./model";
import type { FieldValue, InputKind, TryItRequest, TryItValues } from "./tryIt";
import { useMemo, useState } from "react";
import { isApiError } from "../../../api/errors";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { CopyButton } from "../../../components/CopyButton";
import { Field } from "../../../components/Field";
import { Checkbox, Select, TextInput } from "../../../components/inputs";
import { JsonEditor } from "../../../components/JsonEditor";
import { jsonEditorState } from "../../../components/jsonParse";
import { JsonView } from "../../../components/JsonView";
import { ProblemBanner } from "../../../components/ProblemBanner";
import { Tabs } from "../../../components/Tabs";
import { useDocsClient, useDocsUiConfig } from "../../../context";
import {
  bodySchema,
  buildRequest,
  curlSnippet,
  documentedNote,
  fetchSnippet,
  formParameters,
  initialBodyText,
  inputKind,
  isDestructive,
  paramKey,
  tryItGate,
} from "./tryIt";

/** What one send produced. */
type TryItResult =
  | {
      /** A response arrived, whatever its status. */
      ok: true;
      /** The response: real status, visible headers, body and timing. */
      response: RawResponse;
    }
  | {
      /** No response: a network failure (an `ApiError` of kind `network`) or anything else thrown. */
      ok: false;
      /** What was thrown. */
      error: unknown;
      /** Milliseconds from send to failure. */
      ms: number;
    };

/** Props of {@link TryItPanel}. */
export interface TryItPanelProps {
  /** The operation to send. */
  operation: DocOperation;
  /** The document, for `$ref`s in parameter and body schemas. */
  root: SchemaRoot;
}

/** Hints per input kind. */
function kindHint(
  kind: InputKind,
  parameter: DocParameter,
): string | undefined {
  switch (kind.kind) {
    case "list":
      return "Comma-separated; each value is sent as a repeated key (name=a&name=b).";
    case "enum-list":
      return "Each ticked value is sent as a repeated key.";
    case "number": {
      const bounds = [
        kind.min !== undefined ? `min ${kind.min}` : undefined,
        kind.max !== undefined ? `max ${kind.max}` : undefined,
      ].filter(Boolean);
      return [kind.integer ? "An integer" : "A number", ...bounds].join(", ");
    }
    default:
      return parameter.in === "path"
        ? "Percent-encoded as one path segment."
        : undefined;
  }
}

/** One parameter's control. */
function ParameterInput({
  parameter,
  kind,
  value,
  onChange,
  disabled,
}: {
  /** The parameter. */
  parameter: DocParameter;
  /** Its input kind. */
  kind: InputKind;
  /** Its value. */
  value: FieldValue | undefined;
  /** Sets it. */
  onChange: (value: FieldValue) => void;
  /** Whether the panel is off. */
  disabled: boolean;
}) {
  const text = typeof value === "string" ? value : "";
  switch (kind.kind) {
    case "boolean":
    case "enum": {
      const options =
        kind.kind === "boolean" ? ["true", "false"] : kind.options;
      return (
        <Select<string>
          value={text}
          disabled={disabled}
          options={[
            { value: "", label: parameter.required ? "Choose…" : "(not sent)" },
            ...options.map((option) => ({ value: option })),
          ]}
          onChange={onChange}
        />
      );
    }
    case "enum-list": {
      const picked = Array.isArray(value) ? value : [];
      return (
        <div
          className="http-tryit-checks"
          role="group"
          aria-label={parameter.name}
        >
          {kind.options.map((option) => (
            <Checkbox
              key={option}
              label={option}
              disabled={disabled}
              checked={picked.includes(option)}
              onChange={(checked) =>
                onChange(
                  checked
                    ? [...picked, option]
                    : picked.filter((item) => item !== option),
                )
              }
            />
          ))}
        </div>
      );
    }
    default:
      return (
        <TextInput
          value={text}
          disabled={disabled}
          inputMode={kind.kind === "number" ? "decimal" : undefined}
          placeholder={kind.kind === "list" ? "a, b, c" : undefined}
          onChange={(next) => onChange(next)}
        />
      );
  }
}

/** The response headers the browser let the page see. */
function HeadersView({
  headers,
}: {
  /** Lower-cased names to values, in order. */
  headers: Record<string, string>;
}) {
  const entries = Object.entries(headers);
  return (
    <details
      className="http-tryit-headers"
      data-testid="tryit-headers"
    >
      <summary>{`Headers (${entries.length})`}</summary>
      {entries.length === 0 ? (
        <p className="http-muted">No headers visible to the page.</p>
      ) : (
        <dl>
          {entries.map(([name, value]) => (
            <div
              key={name}
              data-header={name}
            >
              <dt>
                <code>{name}</code>
              </dt>
              <dd>
                <code>{value}</code>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </details>
  );
}

/** A response body: a JSON tree, text, or "No body." */
function BodyView({
  body,
  label,
}: {
  /** The parsed JSON, the text, or `undefined`. */
  body: unknown;
  /** The tree's accessible label. */
  label: string;
}) {
  if (body === undefined) {
    return <p className="http-muted">No body.</p>;
  }
  if (typeof body === "string") {
    return (
      <pre
        className="http-tryit-text"
        aria-label={label}
      >
        <code>{body}</code>
      </pre>
    );
  }
  return (
    <JsonView
      value={body}
      label={label}
      expandDepth={2}
    />
  );
}

/** The real status, timing, headers and body of the last send. */
function ResultView({
  result,
  operation,
}: {
  /** The outcome. */
  result: TryItResult;
  /** The operation, for its documented statuses. */
  operation: DocOperation;
}) {
  const response = result.ok ? result.response : undefined;
  const error = result.ok ? result.response.error : result.error;
  const problem = isApiError(error) ? error : undefined;
  const note = response
    ? documentedNote(operation, response.status)
    : undefined;
  const ms = response ? response.durationMs : result.ok ? 0 : result.ms;
  return (
    <section
      className="http-tryit-result"
      aria-label="Response"
      data-testid="tryit-result"
    >
      <div className="http-tryit-status">
        <Badge tone={response?.ok ? "success" : "danger"}>
          <span data-testid="tryit-status">
            {response
              ? String(response.status)
              : problem?.status === 0
                ? "No response"
                : "Error"}
          </span>
        </Badge>
        {response?.statusText && (
          <span className="http-muted">{response.statusText}</span>
        )}
        {problem && <code>{problem.code}</code>}
        <span
          className="http-tryit-timing"
          data-testid="tryit-timing"
        >
          {`${Math.round(ms)} ms`}
        </span>
      </div>
      {note && (
        <p
          className="http-muted"
          data-testid="tryit-documented"
        >
          {note}
        </p>
      )}
      {!response && <ProblemBanner error={error} />}
      {response && (
        <>
          {!response.ok && <ProblemBanner error={error} />}
          <HeadersView headers={response.headers} />
          <BodyView
            body={response.body}
            label={
              response.ok
                ? "Response body"
                : problem?.kind === "problem"
                  ? "Problem body"
                  : "Response body"
            }
          />
        </>
      )}
    </section>
  );
}

/** Which snippet is showing. */
type SnippetTab = "curl" | "fetch";

/** The curl / fetch() snippets of the request the form would send. */
function Snippets({
  request,
}: {
  /** The request, when the form is complete. */ request:
    TryItRequest | undefined;
}) {
  const api = useDocsClient();
  const config = useDocsUiConfig();
  const [tab, setTab] = useState<SnippetTab>("curl");
  const context = {
    apiBase: api.base,
    origin: typeof window === "undefined" ? "" : window.location.origin,
    csrfHeader: config.csrfHeader,
  };
  const text = request
    ? tab === "curl"
      ? curlSnippet(request, context)
      : fetchSnippet(request, context)
    : undefined;
  return (
    <Tabs<SnippetTab>
      label="Snippets"
      value={tab}
      onChange={setTab}
      tabs={[
        { value: "curl", label: "curl" },
        { value: "fetch", label: "fetch()" },
      ]}
      className="http-snippets"
    >
      {text === undefined ? (
        <p className="http-muted">
          Fill in the required fields to see the snippet.
        </p>
      ) : (
        <div className="http-snippet">
          <CopyButton
            text={text}
            ariaLabel={`Copy the ${tab === "curl" ? "curl command" : "fetch() call"}`}
          />
          <pre data-testid={`snippet-${tab}`}>
            <code>{text}</code>
          </pre>
        </div>
      )}
    </Tabs>
  );
}

/**
 * The "try it" panel of one operation: a form built from its path and query
 * parameters, a JSON editor for its body (prefilled with the schema's
 * required fields), sent to the document's resolved server with the
 * viewer's own client, so the CSRF header and `Content-Type` rules apply
 * exactly as the snippets promise. Mutations ask first; destructive ones
 * need the operation id typed.
 */
export function TryItPanel({ operation, root }: TryItPanelProps) {
  const api = useDocsClient();
  const config = useDocsUiConfig();
  const parameters = formParameters(operation);
  const schema = bodySchema(operation);
  const bodyOptional = operation.requestBody?.required !== true;

  const [values, setValues] = useState<TryItValues>({});
  const [body, setBody] = useState<JsonEditorState>(() =>
    jsonEditorState(initialBodyText(operation, root), {
      allowEmpty: bodyOptional,
    }),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<TryItRequest | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<TryItResult | null>(null);

  // A standalone viewer knows neither the API's read-only setting nor the
  // caller's permissions; the API's answer stays final either way.
  const gate = tryItGate(operation, { readOnly: false, permitted: true });
  const disabled = !gate.enabled || pending;

  const built = useMemo(
    () =>
      buildRequest(
        operation,
        root,
        values,
        schema === undefined ? undefined : body.value,
      ),
    [operation, root, values, schema, body.value],
  );

  async function send(request: TryItRequest): Promise<void> {
    setPending(true);
    const started = performance.now();
    try {
      const response = await api.requestRaw(request.method, request.path, {
        query: request.query,
        body: request.body,
      });
      setResult({ ok: true, response });
    } catch (error) {
      setResult({ ok: false, error, ms: performance.now() - started });
    } finally {
      setPending(false);
    }
  }

  function submit() {
    if (!gate.enabled) {
      return;
    }
    if (schema !== undefined && !body.valid) {
      setErrors({
        body: body.error
          ? `Line ${body.error.line}: ${body.error.message}`
          : "The body is not valid JSON",
      });
      return;
    }
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    if (operation.mutation) {
      setConfirming(built.request);
      return;
    }
    void send(built.request);
  }

  const destructive = isDestructive(operation);
  const csrfParameter = operation.parameters.find(
    (parameter) =>
      parameter.in === "header" && parameter.name === operation.csrf?.header,
  );

  return (
    <section
      className="http-tryit"
      aria-labelledby={`tryit-${operation.id}`}
      data-testid="tryit"
    >
      <h3 id={`tryit-${operation.id}`}>Try it</h3>
      {!gate.enabled && (
        <p
          className="http-tryit-disabled"
          role="note"
          data-testid="tryit-disabled"
        >
          {gate.reason}
        </p>
      )}
      <form
        className="http-tryit-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {parameters.length === 0 && schema === undefined && (
          <p className="http-muted">No parameters.</p>
        )}
        {parameters.map((parameter) => {
          const key = paramKey(parameter);
          const kind = inputKind(parameter, root);
          return (
            <Field
              key={key}
              label={
                <>
                  <code>{parameter.name}</code>{" "}
                  <span className="http-muted">{parameter.in}</span>
                </>
              }
              required={parameter.required}
              hint={kindHint(kind, parameter)}
              error={errors[key]}
            >
              <ParameterInput
                parameter={parameter}
                kind={kind}
                value={values[key]}
                disabled={disabled}
                onChange={(next) =>
                  setValues((current) => ({ ...current, [key]: next }))
                }
              />
            </Field>
          );
        })}
        {csrfParameter && (
          <p
            className="http-muted"
            data-testid="tryit-csrf"
          >
            {config.csrfHeader === csrfParameter.name
              ? `The ${csrfParameter.name} header is added by the viewer's client.`
              : config.csrfHeader
                ? `The API asks for ${csrfParameter.name}, but this UI sends ${config.csrfHeader}: the API will refuse this with 403 CSRF_REJECTED.`
                : `The API asks for ${csrfParameter.name}, but this UI is configured with no CSRF header: the API will refuse this with 403 CSRF_REJECTED.`}
          </p>
        )}
        {schema !== undefined && (
          <Field
            label="Body (application/json)"
            required={!bodyOptional}
            hint={
              bodyOptional
                ? "Optional: leave it empty to send none."
                : "Prefilled with the schema's required fields."
            }
            error={errors.body}
          >
            <JsonEditor
              value={body.text}
              allowEmpty={bodyOptional}
              readOnly={disabled}
              rows={8}
              onChange={setBody}
            />
          </Field>
        )}
        <div className="http-tryit-actions">
          <Button
            type="submit"
            variant={
              operation.mutation
                ? destructive
                  ? "danger"
                  : "primary"
                : "primary"
            }
            disabled={disabled}
          >
            {pending ? "Sending…" : `Send ${operation.method}`}
          </Button>
          {result && (
            <Button
              variant="ghost"
              onClick={() => setResult(null)}
            >
              Clear response
            </Button>
          )}
        </div>
      </form>
      <Snippets request={built.ok ? built.request : undefined} />
      {result && (
        <ResultView
          result={result}
          operation={operation}
        />
      )}
      <ConfirmDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={`Send ${operation.method} ${confirming?.path ?? operation.path}?`}
        description={
          destructive
            ? "This changes the real API and cannot be undone."
            : "This changes the real API."
        }
        variant={destructive ? "danger" : "default"}
        confirmLabel={`Send ${operation.method}`}
        confirmText={destructive ? operation.id : undefined}
        onConfirm={async () => {
          if (confirming) {
            await send(confirming);
          }
        }}
      />
    </section>
  );
}
