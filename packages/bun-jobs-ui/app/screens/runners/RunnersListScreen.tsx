import type { RunnerListItemDto } from "../../api/types";
import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useId } from "react";
import { listRunners, runnerKeys, runnerPath } from "../../api/runners";
import { Badge } from "../../components/Badge";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { ErrorView } from "../../components/ErrorView";
import { Spinner } from "../../components/Spinner";
import { Table } from "../../components/Table";
import { useApiClient } from "../../context";
import { plural } from "../../format";
import { SEARCH_SHORTCUT } from "../../layout/shortcuts";
import { useCan } from "../../meta/hooks";
import { Link } from "../../router";
import { useUrlParams } from "../queues/urlState";
import { useListRefetchInterval, useRunnerListLive } from "./live";
import { filterRunners, orderRunners, RUNNER_STATUS } from "./runnerFormat";
import "./runners.css";

/**
 * One row: a local runner with its name and lifecycle status, or a remote id
 * with its shared paused flag; either one's run in flight is marked.
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
            Remote
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
              onChange={(event) => update({ search: event.target.value })}
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
                {shown.map((item) => (
                  <RunnerRow
                    key={item.id}
                    item={item}
                  />
                ))}
              </tbody>
            </Table>
            <p
              className="muted runners-count"
              data-testid="runners-count"
            >
              {plural(localCount, "local runner")},{" "}
              {plural(all.length - localCount, "remote runner")}
              {shown.length < all.length && ` (${shown.length} shown)`}
            </p>
          </>
        )}
      </Card>
    </div>
  );
}
