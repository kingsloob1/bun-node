import type { JobsApiAction } from "../../../api/contract";
import type { JsonEditorState } from "../../../components/jsonParse";
import type { SchemaRoot } from "../schema/resolve";
import type { DocOperation, DocParameter } from "./model";
import type { FieldValue, InputKind, TryItRequest, TryItValues } from "./tryIt";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { docsKeys } from "../../../api/docs";
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
import { useApiClient, useUiConfig } from "../../../context";
import { useCanFn, useMeta } from "../../../meta/hooks";
import { successStatuses } from "./model";
import {
  bodySchema,
  buildRequest,
  curlSnippet,
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
      /** It succeeded (2xx). */
      ok: true;
      /** The parsed body, `undefined` for none. */
      value: unknown;
      /** Milliseconds from send to parsed answer. */
      ms: number;
    }
  | {
      /** It failed: an `ApiError` (problem, HTTP, network or parse). */
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

/** The documented success statuses, e.g. `"200"`, for a result whose own status the client does not expose. */
function documentedSuccess(operation: DocOperation): string {
  const statuses = successStatuses(operation);
  return statuses.length > 0 ? statuses.join(" / ") : "2xx";
}

/** The status, timing, headers note and body of the last send. */
function ResultView({
  result,
  operation,
}: {
  /** The outcome. */
  result: TryItResult;
  /** The operation, for its documented success status. */
  operation: DocOperation;
}) {
  const error = result.ok ? undefined : result.error;
  const problem = isApiError(error) ? error : undefined;
  return (
    <section
      className="http-tryit-result"
      aria-label="Response"
      data-testid="tryit-result"
    >
      <div className="http-tryit-status">
        {result.ok ? (
          <Badge tone="success">
            <span data-testid="tryit-status">
              {documentedSuccess(operation)}
            </span>
          </Badge>
        ) : (
          <Badge tone="danger">
            <span data-testid="tryit-status">
              {problem
                ? problem.status === 0
                  ? "No response"
                  : String(problem.status)
                : "Error"}
            </span>
          </Badge>
        )}
        {problem && <code>{problem.code}</code>}
        <span
          className="http-tryit-timing"
          data-testid="tryit-timing"
        >
          {`${Math.round(result.ms)} ms`}
        </span>
      </div>
      <p className="http-muted">
        {result.ok
          ? "Succeeded. The status shown is the documented one: the app's client returns the parsed body, not the response's status or headers."
          : "Response headers are not exposed by the app's client; the problem it parsed is shown below."}
      </p>
      {result.ok ? (
        result.value === undefined ? (
          <p className="http-muted">No body.</p>
        ) : (
          <JsonView
            value={result.value}
            label="Response body"
            expandDepth={2}
          />
        )
      ) : (
        <>
          <ProblemBanner error={error} />
          {problem && problem.kind === "problem" && (
            <JsonView
              value={{
                type: problem.type,
                title: problem.title,
                status: problem.status,
                code: problem.code,
                detail: problem.detail,
                instance: problem.instance,
                ...(problem.issues.length > 0
                  ? { issues: problem.issues }
                  : {}),
                ...(Object.keys(problem.context).length > 0
                  ? { context: problem.context }
                  : {}),
              }}
              label="Problem body"
              expandDepth={1}
            />
          )}
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
    | TryItRequest
    | undefined;
}) {
  const config = useUiConfig();
  const [tab, setTab] = useState<SnippetTab>("curl");
  const context = {
    apiBase: config.apiBase,
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
 * required fields), sent through the app's own `ApiClient` so the CSRF
 * header and `Content-Type` rules apply exactly as everywhere else in the
 * app. Mutations ask first; destructive ones need the operation id typed.
 * It is off, with the reason shown, on a read-only API for a mutation and
 * when the caller lacks the operation's permission.
 */
export function TryItPanel({ operation, root }: TryItPanelProps) {
  const api = useApiClient();
  const config = useUiConfig();
  const meta = useMeta();
  const can = useCanFn();
  const queryClient = useQueryClient();
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

  const gate = tryItGate(operation, {
    readOnly: meta.readOnly,
    permitted:
      operation.action === undefined || can(operation.action as JobsApiAction),
  });
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
      const value = await api.request<unknown>(request.method, request.path, {
        query: request.query,
        body: request.body,
      });
      setResult({ ok: true, value, ms: performance.now() - started });
      if (operation.mutation) {
        // The rest of the app shows what this changed.
        void queryClient.invalidateQueries({
          predicate: (query) => query.queryKey[0] !== docsKeys.all[0],
        });
      }
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
              ? `The ${csrfParameter.name} header is added by the app's client.`
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
            : "This changes the real API, as the app's own buttons would."
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
