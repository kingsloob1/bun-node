import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useId } from "react";
import { listQueuesPage, queueKeys } from "../../api/queues";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { ErrorView } from "../../components/ErrorView";
import { Pager } from "../../components/Pager";
import { Spinner } from "../../components/Spinner";
import { useApiClient } from "../../context";
import { useCan, useMeta } from "../../meta/hooks";
import { QueueTable } from "../Overview";
import { refreshInterval } from "./live";
import { clampLimit, intParam, useUrlParams } from "./urlState";
import "./queues.css";

/** `/queues`: every queue, searchable (case-insensitive) and paged; search and page live in the URL. */
export function QueuesListScreen() {
  const api = useApiClient();
  const { limits } = useMeta();
  const canList = useCan("queues.list");
  const [params, update] = useUrlParams();
  const searchId = useId();

  const search = params.get("search") ?? "";
  const deferredSearch = useDeferredValue(search);
  const limit = clampLimit(
    intParam(
      params,
      "limit",
      Math.min(limits.defaultPageSize, limits.maxQueues),
    ),
    limits.maxQueues,
  );
  const offset = intParam(params, "offset", 0);
  const query = { search: deferredSearch, offset, limit };

  const queues = useQuery({
    queryKey: queueKeys.page(query),
    queryFn: ({ signal }) => listQueuesPage(api, query, signal),
    refetchInterval: refreshInterval("list"),
    placeholderData: keepPreviousData,
    enabled: canList,
  });

  if (!canList) {
    return (
      <div className="screen">
        <h1 className="screen-title">Queues</h1>
        <EmptyState
          title="Nothing to show"
          description="You may not list queues on this API."
        />
      </div>
    );
  }

  return (
    <div
      className="screen"
      data-testid="queues-list"
    >
      <h1 className="screen-title">Queues</h1>
      <Card
        title="Queues"
        actions={
          <div className="search">
            <label
              htmlFor={searchId}
              className="visually-hidden"
            >
              Search queues by name
            </label>
            <input
              id={searchId}
              type="search"
              className="input"
              placeholder="Search queues"
              value={search}
              maxLength={200}
              onChange={(event) =>
                update({ search: event.target.value, offset: null })
              }
            />
          </div>
        }
      >
        {queues.isPending ? (
          <Spinner
            label="Loading queues"
            showLabel
          />
        ) : queues.isError ? (
          <ErrorView
            error={queues.error}
            title="Could not load queues"
            onRetry={() => void queues.refetch()}
          />
        ) : queues.data.items.length === 0 && offset === 0 ? (
          deferredSearch ? (
            <EmptyState
              title="No queues match"
              description={`No queue name contains “${deferredSearch}”.`}
            />
          ) : (
            <EmptyState
              title="No queues yet"
              description="Queues appear here once a job is added to one."
            />
          )
        ) : (
          <>
            <QueueTable
              items={queues.data.items}
              sparklines={false}
            />
            <Pager
              label="Queue pages"
              offset={offset}
              limit={limit}
              total={queues.data.page.total}
              itemCount={queues.data.items.length}
              hasMore={queues.data.page.hasMore}
              maxPageSize={limits.maxQueues}
              onChange={(next) =>
                update({
                  offset: next.offset > 0 ? String(next.offset) : null,
                  limit: String(next.limit),
                })
              }
            />
          </>
        )}
      </Card>
    </div>
  );
}
