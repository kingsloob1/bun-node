/**
 * The bans list (ui.md §4.2): the control plane's bans on the scope and
 * under it, a page at a time with the cursor trail in the URL, filtered by
 * state, subject kind, source (the sources that exist: manual, and
 * automatic once agents report their engines' bans), rule and subject (an
 * address finds the ranges holding it), sorted by start or end. Live: a new
 * ban never moves the page; it is counted in an "N new — show" chip.
 */
import { Table } from "../../../kit/components/Table";
import type { BanDto, BanFilters } from "./banQueries";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../../kit/components/Button";
import { dataOf } from "../../api/client";
import { ErrorView } from "../../components/ErrorView";
import { Subject } from "../../components/Subject";
import { UrlPager } from "../../components/UrlPager";
import { PAGE_PARAM, useUrlCursor } from "../../components/urlCursor";
import { useSecurityClient } from "../../context";
import { useNewCount } from "../../live/hooks";
import { useCan } from "../../meta/hooks";
import { Link } from "../../router";
import { useRouter } from "../../routing";
import { scopeLabel } from "../../scope/scope";
import { banKeys, filtersOf, listQuery, when } from "./banQueries";
import { BulkLiftDialog } from "./BulkLiftDialog";

/** Props of {@link BansScreen}. */
export interface BansScreenProps {
  /** The scope on screen. */
  scope: string;
}

/** A ban's state, for people. */
function stateOf(ban: BanDto): string {
  if (ban.active)
    return ban.expiresAt === null ? "In force, permanent" : "In force";
  return ban.liftedAt === null ? "Expired" : "Lifted";
}

/** See the module's description. */
export function BansScreen({ scope }: BansScreenProps) {
  const { client } = useSecurityClient();
  const { location, navigate } = useRouter();
  const position = useUrlCursor(50);
  const filters = filtersOf(location.search);
  const canWrite = useCan("bans:write");
  const canAnalytics = useCan("analytics:read");
  const [lifting, setLifting] = useState(false);
  const page = useQuery({
    queryKey: banKeys.list(scope, filters, position.cursor, position.limit),
    queryFn: ({ signal }) =>
      dataOf(
        client.get("/bans", {
          query: {
            scope,
            limit: position.limit,
            ...(position.cursor === undefined
              ? {}
              : { cursor: position.cursor }),
            ...listQuery(filters),
          },
          signal,
        }),
      ),
  });
  // The source filter offers automatic bans only once some exist.
  const autoExists = useQuery({
    queryKey: banKeys.autoExists(scope),
    staleTime: 60_000,
    queryFn: async ({ signal }) =>
      (
        await dataOf(
          client.get("/bans", {
            query: { scope, source: "auto", limit: 1 },
            signal,
          }),
        )
      ).items.length > 0,
  });
  // New bans since the newest on screen: counted, never inserted.
  const newest = page.data?.items[0]?.createdAt ?? 0;
  const fresh = useNewCount(["ban"], (data) => {
    const ban = (data as { ban?: BanDto } | null)?.ban;
    return ban !== undefined && ban.active && ban.createdAt > newest;
  });
  /** Moves to `next` filters, back to the first page. */
  const setFilter = (name: keyof BanFilters, value: string) => {
    const params = new URLSearchParams(location.search);
    if (value === "") params.delete(name);
    else params.set(name, value);
    params.delete(PAGE_PARAM);
    const query = params.toString();
    navigate(`${location.path ?? "/bans"}${query === "" ? "" : `?${query}`}`);
  };
  const scopeQuery = `scope=${encodeURIComponent(scope)}`;
  return (
    <div
      className="screen"
      data-testid="bans"
    >
      <div className="screen-header">
        <h1>Bans: {scopeLabel(scope)}</h1>
        <div className="screen-actions">
          {canAnalytics ? (
            <Link to={`/bans/auto?${scopeQuery}`}>Automatic bans</Link>
          ) : null}
          {canWrite ? (
            <>
              <Link
                to={`/bans/new?${scopeQuery}`}
                data-testid="new-ban"
              >
                New ban
              </Link>
              <Button
                variant="danger"
                size="sm"
                data-testid="bulk-lift-open"
                onClick={() => setLifting(true)}
              >
                Lift matching…
              </Button>
            </>
          ) : null}
        </div>
      </div>
      <form
        className="filters"
        aria-label="Filters"
        onSubmit={(event) => event.preventDefault()}
      >
        <label>
          State{" "}
          <select
            data-always-set
            className="input"
            value={filters.state}
            onChange={(e) => setFilter("state", e.target.value)}
            data-testid="filter-state"
          >
            <option value="active">In force</option>
            <option value="past">Lifted or expired</option>
            <option value="all">All</option>
          </select>
        </label>
        <label>
          Subject{" "}
          <select
            className="input"
            value={filters.kind}
            onChange={(e) => setFilter("kind", e.target.value)}
            data-testid="filter-kind"
          >
            <option value="">Any</option>
            <option value="ip">Address</option>
            <option value="cidr">Range</option>
            <option value="user">User key</option>
            <option value="apiKey">API key key</option>
          </select>
        </label>
        <label>
          Source{" "}
          <select
            className="input"
            value={filters.source}
            onChange={(e) => setFilter("source", e.target.value)}
            data-testid="filter-source"
          >
            <option value="">Any</option>
            <option value="manual">Manual</option>
            {autoExists.data === true || filters.source === "auto" ? (
              <option value="auto">Automatic</option>
            ) : null}
          </select>
        </label>
        <label>
          Rule{" "}
          <input
            placeholder="e.g. ladder or counted:login"
            className="input"
            defaultValue={filters.rule}
            data-testid="filter-rule"
            onBlur={(e) => setFilter("rule", e.target.value.trim())}
          />
        </label>
        <label>
          Search{" "}
          <input
            className="input"
            type="search"
            placeholder="Address, range or account key"
            defaultValue={filters.search}
            data-testid="filter-search"
            onKeyDown={(e) => {
              if (e.key === "Enter")
                setFilter("search", e.currentTarget.value.trim());
            }}
          />
        </label>
        <label>
          Order{" "}
          <select
            data-always-set
            className="input"
            value={`${filters.sort}:${filters.direction}`}
            data-testid="filter-sort"
            onChange={(e) => {
              const [sort, direction] = e.target.value.split(":") as [
                string,
                string,
              ];
              const params = new URLSearchParams(location.search);
              params.set("sort", sort);
              params.set("direction", direction);
              params.delete(PAGE_PARAM);
              navigate(`${location.path ?? "/bans"}?${params.toString()}`);
            }}
          >
            <option value="created:desc">Newest first</option>
            <option value="created:asc">Oldest first</option>
            <option value="expires:asc">Ending soonest</option>
            <option value="expires:desc">Ending latest</option>
          </select>
        </label>
      </form>
      {fresh.count > 0 ? (
        <Button
          size="sm"
          data-testid="new-bans"
          onClick={() => {
            fresh.reset();
            if (position.depth > 0) {
              const params = new URLSearchParams(location.search);
              params.delete(PAGE_PARAM);
              navigate(`${location.path ?? "/bans"}?${params.toString()}`);
            } else void page.refetch();
          }}
        >
          {fresh.count} new — show
        </Button>
      ) : null}
      {page.isError ? (
        <ErrorView
          error={page.error}
          title="The bans could not be read"
          onRetry={() => void page.refetch()}
        />
      ) : (
        <>
          <Table
            label="Bans"
            testId="bans-table"
          >
            <thead>
              <tr>
                <th scope="col">Subject</th>
                <th scope="col">Action</th>
                <th scope="col">Reason</th>
                <th scope="col">Source</th>
                <th scope="col">Started</th>
                <th scope="col">Ends</th>
                <th scope="col">State</th>
                <th scope="col">Writes</th>
              </tr>
            </thead>
            <tbody>
              {(page.data?.items ?? []).map((ban) => (
                <tr
                  key={ban.id}
                  data-testid="ban-row"
                >
                  <td>
                    <Link
                      to={`/bans/${encodeURIComponent(ban.id)}?${scopeQuery}`}
                    >
                      <Subject
                        kind={ban.subject.type}
                        value={ban.subject.value}
                        {...(ban.country === undefined
                          ? {}
                          : { country: ban.country })}
                        {...(ban.asn === undefined ? {} : { asn: ban.asn })}
                      />
                    </Link>
                  </td>
                  <td>{ban.action}</td>
                  <td>{ban.reason}</td>
                  <td>
                    {ban.source}
                    {ban.rule === undefined ? null : (
                      <span className="muted">
                        {" "}
                        ({ban.rule}
                        {ban.step === undefined ? "" : `, step ${ban.step}`})
                      </span>
                    )}
                  </td>
                  <td>{when(ban.createdAt)}</td>
                  <td>
                    {ban.expiresAt === null ? "Permanent" : when(ban.expiresAt)}
                  </td>
                  <td>{stateOf(ban)}</td>
                  <td>{ban.count}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {page.data !== undefined && page.data.items.length === 0 ? (
            <p data-testid="bans-empty">No ban matches.</p>
          ) : null}
          <UrlPager
            position={position}
            page={page.data}
            label="Bans pages"
          />
        </>
      )}
      {canWrite ? (
        <BulkLiftDialog
          open={lifting}
          onClose={() => setLifting(false)}
          scope={scope}
          filters={filters}
        />
      ) : null}
    </div>
  );
}
