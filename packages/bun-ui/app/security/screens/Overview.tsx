/**
 * The landing screen (the user's decision for U1; U2 replaces it with the
 * analytics page): a small summary of the scope from endpoints that exist —
 * its published policy, its active bans, the agents and the audit chain.
 * Each card is present only when the operator may read it, and reads on its
 * own: a part the deployment does not run (no agents: `/agents` answers
 * 404) leaves its card out, and a card that fails says so without taking
 * the others with it.
 */
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "../../kit/components/Card";
import { Spinner } from "../../kit/components/Spinner";
import { dataOf } from "../api/client";
import { isApiError } from "../api/errors";
import { queryKeys } from "../api/keys";
import { useSecurityClient } from "../context";
import { useRefetchInterval } from "../live/context";
import { useCan, useGlobalCanFn } from "../meta/hooks";
import { POLL_INTERVAL_MS } from "../queryClient";
import { scopeLabel } from "../scope/scope";

/** Props of {@link Overview}. */
export interface OverviewProps {
  /** The scope on screen. */
  scope: string;
}

/** A count that may be "200+" (one page read). */
function countOf(page: {
  readonly items: readonly unknown[];
  readonly next?: string;
}): string {
  return page.next === undefined
    ? String(page.items.length)
    : `${page.items.length}+`;
}

/** One card's read: loading, its text, absent (404), or failed. */
function CardBody<T>({
  query,
  testId,
  render,
}: {
  /** The card's query. */
  query: {
    readonly data: T | undefined;
    readonly error: unknown;
    readonly isPending: boolean;
  };
  /** The text's test id. */
  testId: string;
  /** The text for the data. */
  render: (data: T) => ReactNode;
}) {
  if (query.isPending) return <Spinner label="Loading" />;
  if (query.error !== null && query.error !== undefined) {
    return (
      <p
        className="overview-failed"
        data-testid={`${testId}-failed`}
      >
        {isApiError(query.error) ? query.error.title : "Could not be read"}
      </p>
    );
  }
  return <p data-testid={testId}>{render(query.data as T)}</p>;
}

/** Whether a card's read answered 404 (the part is not running): the card is left out. */
function absent(error: unknown): boolean {
  return isApiError(error) && error.status === 404;
}

/** See the module's description. */
export function Overview({ scope }: OverviewProps) {
  const { client } = useSecurityClient();
  const global = useGlobalCanFn();
  const refetchInterval = useRefetchInterval(POLL_INTERVAL_MS);
  const canPolicy = useCan("policy:read");
  const canBans = useCan("bans:read");
  const canAgents = global("agents:read");
  const canAudit = global("audit:read");
  const policy = useQuery({
    queryKey: [...queryKeys.overview(scope), "policy"],
    enabled: canPolicy,
    refetchInterval,
    queryFn: ({ signal }) =>
      dataOf(client.get("/policies/:scope", { params: { scope }, signal })),
  });
  const bans = useQuery({
    queryKey: [...queryKeys.overview(scope), "bans"],
    enabled: canBans,
    refetchInterval,
    queryFn: ({ signal }) =>
      dataOf(
        client.get("/bans", {
          query: { scope, active: true, limit: 200 },
          signal,
        }),
      ),
  });
  const agents = useQuery({
    queryKey: [...queryKeys.overview(scope), "agents"],
    enabled: canAgents,
    refetchInterval,
    queryFn: ({ signal }) =>
      dataOf(client.get("/agents", { query: { limit: 200 }, signal })),
  });
  const audit = useQuery({
    queryKey: [...queryKeys.overview(scope), "audit"],
    enabled: canAudit,
    refetchInterval,
    queryFn: ({ signal }) => dataOf(client.get("/audit/verify", { signal })),
  });
  return (
    <div
      className="screen"
      data-testid="overview"
    >
      <h1>Overview: {scopeLabel(scope)}</h1>
      <div className="overview-cards">
        {canPolicy && !absent(policy.error) ? (
          <Card title="Policy">
            <CardBody
              query={policy}
              testId="overview-policy"
              render={(data) =>
                data.head === null
                  ? "Nothing published yet"
                  : `Version ${data.head.number}`
              }
            />
          </Card>
        ) : null}
        {canBans && !absent(bans.error) ? (
          <Card title="Active bans">
            <CardBody
              query={bans}
              testId="overview-bans"
              render={countOf}
            />
          </Card>
        ) : null}
        {canAgents && !absent(agents.error) ? (
          <Card title="Agents">
            <CardBody
              query={agents}
              testId="overview-agents"
              render={(data) =>
                `${data.items.filter((agent) => agent.status === "ok").length} of ${countOf(data)} ok`
              }
            />
          </Card>
        ) : null}
        {canAudit && !absent(audit.error) ? (
          <Card title="Audit chain">
            <CardBody
              query={audit}
              testId="overview-audit"
              render={(data) =>
                data.ok
                  ? `Verified (${data.checked} entries)`
                  : `Broken at entry ${data.problems[0]?.n ?? "?"}`
              }
            />
          </Card>
        ) : null}
      </div>
    </div>
  );
}
