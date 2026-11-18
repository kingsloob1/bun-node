/**
 * The audit log (ui.md §8, control-plane.md §6): every entry, newest first,
 * a page at a time with the cursor trail in the URL, filtered by actor,
 * action, time and (off `global`) the scope on screen; each entry opens
 * its detail. Beside it, the chain's state and, with `audit:export`, the
 * export (JSON Lines of the filter's time range, behind a step-up).
 */
import { Table } from "../../../kit/components/Table";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../../kit/components/Button";
import { dataOf } from "../../api/client";
import { errorFromResponse, isApiError } from "../../api/errors";
import { download } from "../../components/download";
import { ErrorView } from "../../components/ErrorView";
import { UrlPager } from "../../components/UrlPager";
import { useUrlCursor } from "../../components/urlCursor";
import {
  fromLocalInput,
  toLocalInput,
  useUrlParams,
  when,
} from "../../components/urlParams";
import { useSecurityClient } from "../../context";
import { useCan } from "../../meta/hooks";
import { Link } from "../../router";
import { scopeLabel } from "../../scope/scope";
import { withStepUp } from "../../stepUp";
import { AuditVerify } from "./AuditVerify";
import { auditFiltersOf, auditKeys, auditQuery, phaseOf } from "./auditQueries";

/** Props of {@link AuditScreen}. */
export interface AuditScreenProps {
  /** The scope on screen: `global` shows every scope's entries. */
  scope: string;
}

/** See the module's description. */
export function AuditScreen({ scope }: AuditScreenProps) {
  const { client, base, fetch } = useSecurityClient();
  const { params, set } = useUrlParams();
  const position = useUrlCursor(50);
  const filters = auditFiltersOf(params);
  const canExport = useCan("audit:export");
  const [exported, setExported] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const page = useQuery({
    queryKey: auditKeys.list(scope, filters, position.cursor, position.limit),
    queryFn: ({ signal }) =>
      dataOf(
        client.get("/audit", {
          query: {
            limit: position.limit,
            ...(position.cursor === undefined
              ? {}
              : { cursor: position.cursor }),
            ...auditQuery(scope, filters),
          },
          signal,
        }),
      ),
  });
  const scopeQuery = `scope=${encodeURIComponent(scope)}`;
  /** Downloads the export of the filter's time range, after a step-up. */
  const exportLog = async () => {
    setExporting(true);
    setExported(null);
    try {
      const query = new URLSearchParams();
      if (filters.since !== undefined)
        query.set("since", String(filters.since));
      if (filters.until !== undefined)
        query.set("until", String(filters.until));
      const suffix = query.size === 0 ? "" : `?${query.toString()}`;
      const text = await withStepUp(async () => {
        const response = await fetch(`${base}/audit/export${suffix}`);
        if (!response.ok) throw await errorFromResponse(response);
        return await response.text();
      });
      const lines = text === "" ? 0 : text.trimEnd().split("\n").length;
      download(
        `audit-${new Date().toISOString().slice(0, 10)}.jsonl`,
        text,
        "application/x-ndjson",
      );
      setExported(
        `Exported ${lines.toLocaleString()} ${lines === 1 ? "entry" : "entries"}. The export is itself an audit entry.`,
      );
    } catch (error) {
      setExported(
        isApiError(error)
          ? `The export failed: ${error.detail ?? error.title}`
          : "The export failed.",
      );
    } finally {
      setExporting(false);
    }
  };
  return (
    <div
      className="screen"
      data-testid="audit"
    >
      <div className="screen-header">
        <h1>Audit: {scope === "global" ? "every scope" : scopeLabel(scope)}</h1>
        {canExport ? (
          <div className="screen-actions">
            <Button
              size="sm"
              data-testid="audit-export"
              disabled={exporting}
              onClick={() => void exportLog()}
            >
              {exporting ? "Exporting…" : "Export (JSON Lines)"}
            </Button>
          </div>
        ) : null}
      </div>
      {exported === null ? null : (
        <p
          role="status"
          data-testid="audit-export-outcome"
        >
          {exported}
        </p>
      )}
      <AuditVerify />
      <form
        className="filters"
        aria-label="Filters"
        onSubmit={(event) => event.preventDefault()}
      >
        <label>
          Actor{" "}
          <input
            placeholder="e.g. alice"
            className="input"
            defaultValue={filters.actor}
            data-testid="filter-actor"
            onBlur={(e) => set("actor", e.target.value.trim())}
            onKeyDown={(e) => {
              if (e.key === "Enter") set("actor", e.currentTarget.value.trim());
            }}
          />
        </label>
        <label>
          Action{" "}
          <input
            className="input"
            placeholder="policy.publish"
            defaultValue={filters.action}
            data-testid="filter-action"
            onBlur={(e) => set("action", e.target.value.trim())}
            onKeyDown={(e) => {
              if (e.key === "Enter")
                set("action", e.currentTarget.value.trim());
            }}
          />
        </label>
        <label>
          From{" "}
          <input
            className="input"
            type="datetime-local"
            value={toLocalInput(filters.since)}
            data-testid="filter-since"
            onChange={(e) =>
              set("since", String(fromLocalInput(e.target.value) ?? ""))
            }
          />
        </label>
        <label>
          To{" "}
          <input
            className="input"
            type="datetime-local"
            value={toLocalInput(filters.until)}
            data-testid="filter-until"
            onChange={(e) =>
              set("until", String(fromLocalInput(e.target.value) ?? ""))
            }
          />
        </label>
        <label>
          Order{" "}
          <select
            data-always-set
            className="input"
            value={filters.direction}
            data-testid="filter-direction"
            onChange={(e) =>
              set("direction", e.target.value === "asc" ? "asc" : "")
            }
          >
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </select>
        </label>
      </form>
      {page.isError ? (
        <ErrorView
          error={page.error}
          title="The audit log could not be read"
          onRetry={() => void page.refetch()}
        />
      ) : (
        <>
          <Table
            label="Audit entries"
            testId="audit-table"
          >
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">When</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">Scope</th>
                <th scope="col">Phase</th>
              </tr>
            </thead>
            <tbody>
              {(page.data?.items ?? []).map((entry) => (
                <tr
                  key={entry.n}
                  data-testid="audit-row"
                >
                  <td>
                    <Link to={`/audit/${entry.n}?${scopeQuery}`}>
                      {entry.n}
                    </Link>
                  </td>
                  <td>{when(entry.at)}</td>
                  <td>{entry.actor}</td>
                  <td>{entry.action}</td>
                  <td>{scopeLabel(entry.scope)}</td>
                  <td>{phaseOf(entry)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {page.data !== undefined && page.data.items.length === 0 ? (
            <p data-testid="audit-empty">No entry matches.</p>
          ) : null}
          <UrlPager
            position={position}
            page={page.data}
            label="Audit pages"
          />
        </>
      )}
    </div>
  );
}
