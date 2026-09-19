import type { JobsApiAction } from "../../../api/contract";
import type { SchemaRoot } from "../schema/resolve";
import type { DocOperation, DocParameter, DocResponse } from "./model";
import { Badge } from "../../../components/Badge";
import { CopyButton } from "../../../components/CopyButton";
import { useUiConfig } from "../../../context";
import { useCanFn, useMeta } from "../../../meta/hooks";
import { Prose } from "../schema/Prose";
import { SchemaTree } from "../schema/SchemaTree";
import { methodTone } from "./model";
import { TryItPanel } from "./TryItPanel";

/** Props of {@link OperationView}. */
export interface OperationViewProps {
  /** The operation shown. */
  operation: DocOperation;
  /** The document. */
  root: SchemaRoot;
  /** Opens a component schema (`#/components/schemas/X`) in the side panel. */
  onRef: (ref: string, name: string) => void;
}

/** A method badge. */
export function MethodBadge({
  method,
}: {
  /** Upper-case method. */ method: string;
}) {
  return (
    <Badge
      tone={methodTone(method)}
      className="http-method"
    >
      {method}
    </Badge>
  );
}

/** How an array query parameter is sent, from `style`/`explode`. */
function styleNote(parameter: DocParameter): string | undefined {
  if (parameter.in !== "query" || parameter.style === undefined) {
    return undefined;
  }
  if (parameter.style === "form" && parameter.explode !== false) {
    return "Repeat the key for each value (state=a&state=b).";
  }
  return `style: ${parameter.style}${parameter.explode === undefined ? "" : `, explode: ${String(parameter.explode)}`}`;
}

/** The parameters, grouped by where they go. */
function Parameters({ operation, root, onRef }: OperationViewProps) {
  if (operation.parameters.length === 0) {
    return null;
  }
  return (
    <section
      className="http-section"
      aria-labelledby={`params-${operation.id}`}
    >
      <h3 id={`params-${operation.id}`}>Parameters</h3>
      <ul
        className="http-params"
        data-testid="op-parameters"
      >
        {operation.parameters.map((parameter) => {
          const note = styleNote(parameter);
          return (
            <li
              key={`${parameter.in}:${parameter.name}`}
              className="http-param"
              data-param={parameter.name}
            >
              <div className="http-param-head">
                <code className="http-param-name">{parameter.name}</code>
                <Badge tone="neutral">{parameter.in}</Badge>
                {parameter.required ? (
                  <span className="schema-required">required</span>
                ) : (
                  <span className="http-muted">optional</span>
                )}
                {parameter.deprecated && (
                  <Badge tone="warning">deprecated</Badge>
                )}
              </div>
              {parameter.description && (
                <div className="http-param-description">
                  <Prose text={parameter.description} />
                </div>
              )}
              {note && <p className="http-muted http-param-style">{note}</p>}
              <SchemaTree
                schema={parameter.schema}
                root={root}
                depth={0}
                onRef={onRef}
                label={`Schema of ${parameter.name}`}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The request body. */
function RequestBody({ operation, root, onRef }: OperationViewProps) {
  const body = operation.requestBody;
  if (!body) {
    return null;
  }
  return (
    <section
      className="http-section"
      aria-labelledby={`body-${operation.id}`}
      data-testid="op-body"
    >
      <h3 id={`body-${operation.id}`}>
        Request body{" "}
        <span className="http-muted">
          {body.required ? "(required)" : "(optional)"}
        </span>
      </h3>
      {body.description && <Prose text={body.description} />}
      {body.content.map((media) => (
        <div
          key={media.contentType}
          className="http-media"
        >
          <code className="http-media-type">{media.contentType}</code>
          {media.schema !== undefined && (
            <SchemaTree
              schema={media.schema}
              root={root}
              depth={2}
              onRef={onRef}
              label={`Request body schema (${media.contentType})`}
            />
          )}
        </div>
      ))}
    </section>
  );
}

/** A status badge's tone. */
function statusTone(
  status: string,
): "success" | "warning" | "danger" | "neutral" {
  if (status.startsWith("2")) {
    return "success";
  }
  if (status.startsWith("4")) {
    return "warning";
  }
  if (status.startsWith("5")) {
    return "danger";
  }
  return "neutral";
}

/** One response. */
function ResponseItem({
  response,
  root,
  onRef,
}: {
  /** The response. */
  response: DocResponse;
  /** The document. */
  root: SchemaRoot;
  /** Opens a component. */
  onRef: OperationViewProps["onRef"];
}) {
  const success = response.status.startsWith("2");
  return (
    <li
      className="http-response"
      data-status={response.status}
    >
      <div className="http-response-head">
        <Badge tone={statusTone(response.status)}>{response.status}</Badge>
        <span>{response.description}</span>
      </div>
      {response.codes.length > 0 && (
        <ul
          className="http-codes"
          aria-label={`Problem codes for ${response.status}`}
        >
          {response.codes.map((code) => (
            <li key={code}>
              <code>{code}</code>
            </li>
          ))}
        </ul>
      )}
      {response.content.map((media) => (
        <div
          key={media.contentType}
          className="http-media"
        >
          <code className="http-media-type">{media.contentType}</code>
          {media.schema !== undefined && (
            <SchemaTree
              schema={media.schema}
              root={root}
              depth={success ? 1 : 0}
              onRef={onRef}
              label={`Response ${response.status} schema (${media.contentType})`}
            />
          )}
        </div>
      ))}
    </li>
  );
}

/**
 * One operation: method and path, summary and description, the permission
 * it needs with a you-have / you-lack marker, whether it is a mutation, its
 * CSRF rules and driver requirements, its parameters, body and responses
 * (schemas as trees), and its try-it panel.
 */
export function OperationView({ operation, root, onRef }: OperationViewProps) {
  const can = useCanFn();
  const meta = useMeta();
  const config = useUiConfig();
  const allowed =
    operation.action === undefined
      ? undefined
      : can(operation.action as JobsApiAction);
  const csrf = operation.csrf;
  return (
    <article
      className="http-operation"
      aria-labelledby={`op-${operation.id}`}
      data-testid="http-operation"
    >
      <header className="http-operation-head">
        <div className="http-operation-line">
          <MethodBadge method={operation.method} />
          <code
            className="http-operation-path"
            data-testid="op-path"
          >
            {operation.path}
          </code>
          {operation.deprecated && <Badge tone="warning">deprecated</Badge>}
        </div>
        <h2
          id={`op-${operation.id}`}
          className="http-operation-title"
        >
          {operation.summary ?? operation.id}
        </h2>
        <p className="http-operation-id">
          <span className="http-muted">operationId</span>{" "}
          <code>{operation.id}</code>
          <CopyButton
            text={operation.id}
            ariaLabel="Copy the operation id"
          />
        </p>
      </header>

      <div
        className="http-markers"
        aria-label="Access"
        role="group"
      >
        {operation.action !== undefined && (
          <Badge
            tone={allowed ? "success" : "danger"}
            title="From your permissions (/meta/permissions). authorize may still decide per queue, runner or job."
          >
            <span
              data-testid="op-permission"
              data-allowed={String(allowed)}
            >
              {allowed ? "You have " : "You lack "}
              <code>{operation.action}</code>
            </span>
          </Badge>
        )}
        <Badge
          tone={operation.mutation ? "warning" : "neutral"}
          title={
            operation.mutation
              ? "Changes state: CSRF checks apply, and a read-only API refuses it."
              : "Reads only."
          }
        >
          <span data-testid="op-mutation">
            {operation.mutation ? "Mutation" : "Read"}
          </span>
        </Badge>
        {operation.mutation && meta.readOnly && (
          <Badge tone="danger">Refused: the API is read-only</Badge>
        )}
        {operation.requires.length > 0 && (
          <span
            className="http-requires"
            data-testid="op-requires"
          >
            <span className="http-muted">Needs driver support:</span>{" "}
            {operation.requires.map((method) => (
              <code key={method}>{method}</code>
            ))}
          </span>
        )}
      </div>

      {csrf && (
        <div
          className="http-csrf"
          role="note"
          data-testid="op-csrf"
        >
          {csrf.header !== null && (
            <p>
              Every mutation must carry the <code>{csrf.header}</code> header,
              with any non-empty value.{" "}
              {config.csrfHeader === csrf.header
                ? "The app sends it."
                : "This UI is not configured to send it."}
            </p>
          )}
          {csrf.requireJson && (
            <p>
              Send <code>Content-Type: application/json</code>, even with no
              body; any other media type is refused with 415.
            </p>
          )}
          {csrf.header === null && !csrf.requireJson && (
            <p>Cross-site requests are refused (Origin / Sec-Fetch-Site).</p>
          )}
        </div>
      )}

      {operation.description && (
        <div className="http-description">
          <Prose text={operation.description} />
        </div>
      )}

      <Parameters
        operation={operation}
        root={root}
        onRef={onRef}
      />
      <RequestBody
        operation={operation}
        root={root}
        onRef={onRef}
      />

      <section
        className="http-section"
        aria-labelledby={`responses-${operation.id}`}
      >
        <h3 id={`responses-${operation.id}`}>Responses</h3>
        <ul
          className="http-responses"
          data-testid="op-responses"
        >
          {operation.responses.map((response) => (
            <ResponseItem
              key={response.status}
              response={response}
              root={root}
              onRef={onRef}
            />
          ))}
        </ul>
      </section>

      <TryItPanel
        key={operation.id}
        operation={operation}
        root={root}
      />
    </article>
  );
}
