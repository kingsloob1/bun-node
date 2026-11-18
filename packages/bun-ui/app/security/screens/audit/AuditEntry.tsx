/**
 * One audit entry (ui.md §8): who, what, where and when, its place in the
 * chain (its hash and the one before), its reconciled status, and what it
 * changed: the state before and after side by side, or the diff it holds,
 * then the rest of the entry as it was hashed.
 */
import { useQuery } from "@tanstack/react-query";
import { JsonView } from "../../../kit/components/JsonView";
import { Spinner } from "../../../kit/components/Spinner";
import { dataOf } from "../../api/client";
import type { ChangeRow } from "../../components/ChangesTable";
import { ChangesTable } from "../../components/ChangesTable";
import { ErrorView } from "../../components/ErrorView";
import { when } from "../../components/urlParams";
import { useSecurityClient } from "../../context";
import { Link } from "../../router";
import { useParams } from "../../routing";
import { scopeLabel } from "../../scope/scope";
import { auditKeys, phaseOf } from "./auditQueries";

/** Props of {@link AuditEntry}. */
export interface AuditEntryProps {
  /** The scope on screen (links keep it). */
  scope: string;
}

/** Whether `value` is a diff's list of changes. */
function isChanges(value: unknown): value is ChangeRow[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { path?: unknown }).path === "string",
    )
  );
}

/** See the module's description. */
export function AuditEntry({ scope }: AuditEntryProps) {
  const { n: raw = "" } = useParams<{ n: string }>();
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  const { client } = useSecurityClient();
  const entry = useQuery({
    queryKey: auditKeys.entry(n),
    enabled: Number.isSafeInteger(n),
    // An entry never changes once appended.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: ({ signal }) =>
      dataOf(client.get("/audit/:n", { params: { n }, signal })),
  });
  const back = (
    <p>
      <Link to={`/audit?scope=${encodeURIComponent(scope)}`}>Audit</Link>
    </p>
  );
  if (!Number.isSafeInteger(n)) {
    return (
      <div className="screen">
        {back}
        <p role="alert">There is no audit entry “{raw}”.</p>
      </div>
    );
  }
  if (entry.isError) {
    return (
      <div className="screen">
        {back}
        <ErrorView
          error={entry.error}
          title={`Entry ${n} could not be read`}
          headingLevel={1}
        />
      </div>
    );
  }
  if (entry.data === undefined) return <Spinner label="Loading the entry" />;
  const data = entry.data;
  const { before, after, diff, changes, ...rest } = data.entry as Record<
    string,
    unknown
  >;
  const listed = isChanges(diff) ? diff : isChanges(changes) ? changes : null;
  return (
    <div
      className="screen"
      data-testid="audit-entry"
    >
      {back}
      <h1>
        Entry {data.n}: {data.action}
      </h1>
      <dl
        className="key-value"
        data-testid="audit-entry-facts"
      >
        <dt>When</dt>
        <dd>{when(data.at)}</dd>
        <dt>Actor</dt>
        <dd>{data.actor}</dd>
        <dt>Scope</dt>
        <dd>{scopeLabel(data.scope)}</dd>
        <dt>Phase</dt>
        <dd>{phaseOf(data)}</dd>
        <dt>Hash</dt>
        <dd>
          <code>{data.hash}</code>
        </dd>
        <dt>Previous hash</dt>
        <dd>
          <code>{data.prevHash}</code>
        </dd>
      </dl>
      {listed === null ? null : (
        <section aria-label="Changes">
          <h2>Changes</h2>
          <ChangesTable
            changes={listed}
            testId="audit-entry-diff"
          />
        </section>
      )}
      {before === undefined && after === undefined ? null : (
        <section
          aria-label="Before and after"
          data-testid="audit-entry-before-after"
        >
          <h2>Before and after</h2>
          <div className="audit-before-after">
            <JsonView
              value={before ?? null}
              label="Before"
              expandDepth={2}
            />
            <JsonView
              value={after ?? null}
              label="After"
              expandDepth={2}
            />
          </div>
        </section>
      )}
      <section aria-label="The entry">
        <h2>The entry as hashed</h2>
        <JsonView
          value={rest}
          label="Entry"
          expandDepth={1}
          copyable
        />
      </section>
    </div>
  );
}
