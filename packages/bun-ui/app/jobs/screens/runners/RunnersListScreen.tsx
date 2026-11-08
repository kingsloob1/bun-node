import type { RunnerListItemDto } from "../../api/types";
import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useId } from "react";
import { listRunners, runnerKeys, runnerPath } from "../../api/runners";
import { Badge } from "../../components/Badge";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { ErrorView } from "../../components/ErrorView";
import { Pager } from "../../components/Pager";
import { Spinner } from "../../components/Spinner";
import { Table } from "../../components/Table";
import { clientWindow } from "../../components/useClientPage";
import { useApiClient } from "../../context";
import { plural } from "../../format";
import { SEARCH_SHORTCUT } from "../../layout/shortcuts";
import { useCan } from "../../meta/hooks";
import { Link } from "../../router";
import { intParam, useUrlParams } from "../queues/urlState";
import { useListRefetchInterval, useRunnerListLive } from "./live";
import { filterRunners, orderRunners, RUNNER_STATUS } from "./runnerFormat";
import "./runners.css";

/**
 * Runners per page.
 *
 * Twenty-five: a runner row is three short cells, so a page holds more than a
 * queue's, and a namespace registering one runner per report or sweep reaches
 * a few dozen. The window lives in the URL, like `/queues`, since the whole
 * screen is this one list and a link should reproduce the page being read.
 */
const RUNNER_PAGE_SIZE = 25;

/**
 * One row: a local runner with its name and lifecycle status, or the id of one
 * registered in another process, with its shared paused flag; either one's
 * run in flight is marked.
 */
function RunnerRow({ item }: { item: RunnerListItemDto }) {
  const status = item.status ? RUNNER_STATUS[item.status] : null;
  return (
    <tr data-testid={`runner-row-${item.id}`}>
      <td>
        <Link
          to={runnerPath(item.id)}
          className="runner-link"
        >
          {item.isLocal && item.name && item.name !== item.id
            ? item.name
            : item.id}
        </Link>
        {item.isLocal && item.name && item.name !== item.id && (
          <code className="runner-id muted">{item.id}</code>
        )}
      </td>
      <td className="runners-where">
        {item.isLocal ? (
          <Badge tone="accent">Local</Badge>
        ) : (
          <Badge
            tone="neutral"
            title="Registered by another process: its name shows on its own screen."
          >
            Other process
          </Badge>
        )}
      </td>
      <td className="runners-status">
        {status ? (
          <Badge
            tone={status.tone}
            title={status.hint}
          >
            {status.label}
          </Badge>
        ) : item.isPaused ? (
          <Badge
            tone="warning"
            title="Paused through the shared state: its owner skips scheduled runs."
          >
            Paused
          </Badge>
        ) : (
          <Badge
            tone="neutral"
            title="Not paused. Its lifecycle status shows only in its own process."
          >
            Active
          </Badge>
        )}{" "}
        {item.isRunning && (
          <Badge
            tone="accent"
            title="A run holds this runner's lock right now, in whichever process."
          >
            Run in flight
          </Badge>
        )}
      </td>
    </tr>
  );
}

/** `/runners`: every runner in the namespace, local first; filtered in the browser. */
export function RunnersListScreen() {
  const api = useApiClient();
  const canList = useCan("runners.list");
  const [params, update] = useUrlParams();
  const filterId = useId();
  const filter = params.get("search") ?? "";
  const deferredFilter = useDeferredValue(filter);

  const refetchInterval = useListRefetchInterval();
  useRunnerListLive(canList);
  const runners = useQuery({
    queryKey: runnerKeys.list(),
    queryFn: ({ signal }) => listRunners(api, signal),
    refetchInterval,
    enabled: canList,
  });

  if (!canList) {
    return (
      <div className="screen">
        <h1 className="screen-title">Runners</h1>
        <EmptyState
          title="Nothing to show"
          description="You may not list runners on this API."
        />
      </div>
    );
  }

  const all = runners.data ? orderRunners(runners.data.items) : [];
  const shown = filterRunners(all, deferredFilter);
  const localCount = all.filter((item) => item.isLocal).length;
  // The list is read whole and filtered in the browser, so the page is cut
  // here too; the window is in the URL, as on `/queues`.
  const page = clientWindow(shown.length, {
    offset: intParam(params, "offset", 0),
    limit: intParam(params, "limit", RUNNER_PAGE_SIZE),
  });
  const rows = shown.slice(page.offset, page.offset + page.limit);

  return (
    <div
      className="screen"
      data-testid="runners-list"
    >
      <h1 className="screen-title">Runners</h1>
      <Card
        title="Runners"
        actions={
          <div className="search">
            <label
              htmlFor={filterId}
              className="visually-hidden"
            >
              Filter runners by id or name
            </label>
            <input
              id={filterId}
              type="search"
              className="input"
              placeholder="Filter runners"
              {...SEARCH_SHORTCUT}
              value={filter}
              maxLength={200}
              onChange={(event) =>
                update({ search: event.target.value, offset: null })
              }
            />
          </div>
        }
      >
        {runners.isPending ? (
          <Spinner
            label="Loading runners"
            showLabel
          />
        ) : runners.isError ? (
          <ErrorView
            error={runners.error}
            title="Could not load runners"
            onRetry={() => void runners.refetch()}
          />
        ) : all.length === 0 ? (
          <EmptyState
            title="No runners yet"
            description="Runners appear here once a process registers one in this namespace."
          />
        ) : shown.length === 0 ? (
          <EmptyState
            title="No runners match"
            description={`No runner id or name contains “${deferredFilter.trim()}”.`}
          />
        ) : (
          <>
            <Table label="Runners">
              <thead>
                <tr>
                  <th scope="col">Runner</th>
                  <th
                    scope="col"
                    className="runners-where"
                  >
                    Where
                  </th>
                  <th
                    scope="col"
                    className="runners-status"
                  >
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <RunnerRow
                    key={item.id}
                    item={item}
                  />
                ))}
              </tbody>
            </Table>
            {page.paged && (
              <Pager
                label="Runner pages"
                offset={page.offset}
                limit={page.limit}
                total={shown.length}
                itemCount={rows.length}
                onChange={(next) =>
                  update({
                    offset: next.offset > 0 ? String(next.offset) : null,
                    limit:
                      next.limit === RUNNER_PAGE_SIZE
                        ? null
                        : String(next.limit),
                  })
                }
              />
            )}
            <p
              className="muted runners-count"
              data-testid="runners-count"
            >
              {plural(localCount, "local runner")},{" "}
              {plural(all.length - localCount, "runner")} in other processes
              {shown.length < all.length && ` (${shown.length} shown)`}
            </p>
          </>
        )}
      </Card>
    </div>
  );
}
