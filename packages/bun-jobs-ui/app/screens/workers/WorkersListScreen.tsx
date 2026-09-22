import type { WorkerState } from "../../api/contract";
import type { WorkerServer, WorkerServiceGroup } from "../../api/workers";
import type { WorkerFilterValues } from "./filters";
import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useId } from "react";
import { WORKER_STATES } from "../../api/contract";
import {
  distinctValues,
  groupByService,
  hostsExposed,
  listWorkers,
  matchesWorker,
  workerKeys,
} from "../../api/workers";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { ErrorView } from "../../components/ErrorView";
import { Field } from "../../components/Field";
import { Select } from "../../components/inputs";
import { Spinner } from "../../components/Spinner";
import { useApiClient } from "../../context";
import { plural } from "../../format";
import { SEARCH_SHORTCUT } from "../../layout/shortcuts";
import { useCan } from "../../meta/hooks";
import { useUrlParams } from "../queues/urlState";
import {
  hasWorkerFilters,
  readWorkerFilters,
  WORKER_FILTER_PARAMS,
  workerListQuery,
} from "./filters";
import { useWorkerListLive, useWorkerRefetchInterval } from "./live";
import { useWorkerPagesRouted } from "./routed";
import { WorkerTable } from "./WorkerTable";
import "./workers.css";

/** A server's heading: `host · pid N`, or a note when the API hides hosts. */
function serverTitle(server: WorkerServer): string {
  if (server.host === null && server.pid === null) {
    return "Hosts hidden by the API";
  }
  return `${server.host ?? "unknown host"} · pid ${server.pid ?? "?"}`;
}

/** One server's workers, as a section inside its service's card. */
function ServerSection({
  server,
  linkQueues,
  linkKeys,
}: {
  /** The server and its workers. */
  server: WorkerServer;
  /** Whether queue names link to the queue screen (`queues.list`). */
  linkQueues: boolean;
  /** Whether stable keys link to their worker page. */
  linkKeys: boolean;
}) {
  const title = serverTitle(server);
  return (
    <section
      className="worker-server"
      data-testid={`worker-server-${server.key}`}
    >
      <h3 className="worker-server-title">
        {title}{" "}
        <span className="muted">{plural(server.workers.length, "worker")}</span>
      </h3>
      <WorkerTable
        workers={server.workers}
        label={`Workers on ${title}`}
        linkQueues={linkQueues}
        linkKeys={linkKeys}
      />
    </section>
  );
}

/** One service's servers: a card per service, a section per server inside it. */
function ServiceCard({
  group,
  linkQueues,
  linkKeys,
}: {
  /** The service, its servers and its worker count. */
  group: WorkerServiceGroup;
  /** Whether queue names link to the queue screen (`queues.list`). */
  linkQueues: boolean;
  /** Whether stable keys link to their worker page. */
  linkKeys: boolean;
}) {
  return (
    <Card
      title={group.service ?? "No service named"}
      actions={<span className="muted">{plural(group.count, "worker")}</span>}
    >
      <div data-testid={`worker-service-${group.service ?? "none"}`}>
        {group.service === null && (
          <p className="muted worker-service-note">
            These processes set no <code>service</code> on their BunJobs
            context, so they are grouped by host and pid alone.
          </p>
        )}
        {group.servers.map((server) => (
          <ServerSection
            key={server.key}
            server={server}
            linkQueues={linkQueues}
            linkKeys={linkKeys}
          />
        ))}
      </div>
    </Card>
  );
}

/** How each worker state reads in the State filter. */
const STATE_LABELS: Readonly<Record<WorkerState, string>> = {
  running: "Running",
  paused: "Paused",
  stopping: "Stopping",
  stopped: "Stopped",
  restarting: "Restarting",
};

/** Props of {@link FilterSelect}. */
interface FilterSelectProps {
  /** The visible label, e.g. "Queue". */
  label: string;
  /** What "no filter" reads as, e.g. "Any queue". */
  any: string;
  /** The value in force; `""` for any. */
  value: string;
  /** The values to offer, from the unfiltered list. The value in force is offered too, even when no live worker has it any more. */
  choices: readonly string[];
  /** Sets the filter; `""` clears it. */
  onChange: (value: string) => void;
  /** How a value reads, when not as itself. */
  labelOf?: (value: string) => string;
}

/** One server-side filter: a select over the values the live workers have. */
function FilterSelect({
  label,
  any,
  value,
  choices,
  onChange,
  labelOf,
}: FilterSelectProps) {
  const values =
    value !== "" && !choices.includes(value) ? [value, ...choices] : choices;
  return (
    <Field label={label}>
      <Select
        options={[
          { value: "", label: any },
          ...values.map((choice) => ({
            value: choice,
            label: labelOf ? labelOf(choice) : choice,
          })),
        ]}
        value={value}
        onChange={onChange}
      />
    </Field>
  );
}

/**
 * `/workers`: every live worker in the namespace, grouped by service, then by
 * the server hosting it.
 *
 * Queue, service, host and state are **server-side** filters, sent to
 * `GET /workers` and kept in the URL; the search box narrows what came back,
 * in the browser. The choices each filter offers come from the unfiltered
 * list, which is the same read (and cache entry) the page shows when nothing
 * is filtered, so an unfiltered page costs one request.
 */
export function WorkersListScreen() {
  const api = useApiClient();
  const canList = useCan("workers.list");
  const canQueues = useCan("queues.list");
  const linkKeys = useWorkerPagesRouted();
  const [params, update] = useUrlParams();
  const filterId = useId();
  const filter = params.get("search") ?? "";
  const deferredFilter = useDeferredValue(filter);
  const filters = readWorkerFilters(params);

  const refetchInterval = useWorkerRefetchInterval();
  useWorkerListLive(canList);
  // The unfiltered list: what each filter offers, and whether hosts show.
  const everything = useQuery({
    queryKey: workerKeys.list(),
    queryFn: ({ signal }) => listWorkers(api, {}, signal),
    refetchInterval,
    enabled: canList,
  });
  // Hosts are hidden when the workers carry none. Until the list answers the
  // page cannot tell, so a `?host=` waits for it; if it failed, the API
  // decides (and says so).
  const hostsShown = everything.isSuccess
    ? (hostsExposed(everything.data.items) ?? false)
    : everything.isError;
  const hostKnown = everything.isSuccess || everything.isError;
  const query = workerListQuery(filters, hostsShown);
  const workers = useQuery({
    queryKey: workerKeys.list(query),
    queryFn: ({ signal }) => listWorkers(api, query, signal),
    refetchInterval,
    enabled: canList && (filters.host === "" || hostKnown),
  });

  if (!canList) {
    return (
      <div className="screen">
        <h1 className="screen-title">Workers</h1>
        <EmptyState
          title="Nothing to show"
          description="You may not list workers on this API."
        />
      </div>
    );
  }

  const live = everything.data?.items ?? [];
  const filtered = hasWorkerFilters(filters);
  const all = workers.data?.items ?? [];
  const shown = all.filter((worker) => matchesWorker(worker, deferredFilter));
  const services = groupByService(shown);
  const serverCount = services.reduce(
    (total, group) => total + group.servers.length,
    0,
  );
  const total = everything.data ? live.length : all.length;
  const setFilter = (name: keyof WorkerFilterValues) => (value: string) =>
    update({ [name]: value });
  const clearFilters = () =>
    update(
      Object.fromEntries(WORKER_FILTER_PARAMS.map((name) => [name, null])),
    );

  return (
    <div
      className="screen"
      data-testid="workers-list"
    >
      <h1 className="screen-title">Workers</h1>
      {/*
       * A ROW, never a bare child of the column-flex `.screen`: there a
       * `.search`'s `flex: 0 1 260px` is a height, and the box grew 260px
       * tall. `__tests__/app/workers/filters.test.tsx` pins both.
       */}
      <div
        className="worker-filters"
        role="search"
        aria-label="Filter workers"
        data-testid="worker-filters"
      >
        <div className="search">
          <label
            htmlFor={filterId}
            className="visually-hidden"
          >
            Filter workers by id, queue or host
          </label>
          <input
            id={filterId}
            type="search"
            className="input"
            placeholder="Filter workers"
            {...SEARCH_SHORTCUT}
            value={filter}
            maxLength={200}
            onChange={(event) => update({ search: event.target.value })}
          />
        </div>
        <FilterSelect
          label="Queue"
          any="Any queue"
          value={filters.queue}
          choices={distinctValues(live, "queue")}
          onChange={setFilter("queue")}
        />
        <FilterSelect
          label="Service"
          any="Any service"
          value={filters.service}
          choices={distinctValues(live, "service")}
          onChange={setFilter("service")}
        />
        {hostsShown && (
          <FilterSelect
            label="Host"
            any="Any host"
            value={filters.host}
            choices={distinctValues(live, "host")}
            onChange={setFilter("host")}
          />
        )}
        <FilterSelect
          label="State"
          any="Any state"
          value={filters.state}
          choices={WORKER_STATES}
          onChange={setFilter("state")}
          labelOf={(state) => STATE_LABELS[state as WorkerState]}
        />
        {filtered && (
          <Button
            size="sm"
            onClick={clearFilters}
          >
            Clear filters
          </Button>
        )}
      </div>
      {filters.host !== "" && hostKnown && !hostsShown && (
        <p
          className="notice"
          role="note"
          data-testid="workers-host-ignored"
        >
          This API hides worker hosts, so the host filter in this link (
          <code>{filters.host}</code>) is ignored.
        </p>
      )}
      {workers.isPending ? (
        <Spinner
          label="Loading workers"
          showLabel
        />
      ) : workers.isError ? (
        <ErrorView
          error={workers.error}
          title="Could not load workers"
          onRetry={() => void workers.refetch()}
        />
      ) : all.length === 0 && (!filtered || total === 0) ? (
        <EmptyState
          title="No live workers"
          description="Workers appear here once a process runs one and it reports."
        />
      ) : all.length === 0 ? (
        <EmptyState
          title="No workers match these filters"
          description="No live worker has every value chosen above."
          action={
            <Button
              size="sm"
              onClick={clearFilters}
            >
              Clear filters
            </Button>
          }
        />
      ) : services.length === 0 ? (
        <EmptyState
          title="No workers match"
          description={`No worker id, queue or host contains “${deferredFilter.trim()}”.`}
        />
      ) : (
        <>
          <p
            className="muted"
            data-testid="workers-count"
          >
            {plural(shown.length, "worker")} on {plural(serverCount, "server")}
            {shown.length < total && ` (of ${total})`}
          </p>
          {services.map((group) => (
            <ServiceCard
              key={group.service ?? ""}
              group={group}
              linkQueues={canQueues}
              linkKeys={linkKeys}
            />
          ))}
        </>
      )}
    </div>
  );
}
