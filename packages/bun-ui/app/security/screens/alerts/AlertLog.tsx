/**
 * The delivery log and the dead letters (`GET /alerts/deliveries`,
 * `/alerts/dead-letters`): each try's channel, alert kind, severity,
 * outcome and reason (never the message), a page at a time, filtered by
 * channel. With `alerts:write`, a dead letter is **Replayed** (queued
 * again).
 */
import { Table } from "../../../kit/components/Table";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "../../../kit/components/Badge";
import { Button } from "../../../kit/components/Button";
import { dataOf } from "../../api/client";
import { isApiError } from "../../api/errors";
import { ErrorView } from "../../components/ErrorView";
import { UrlPager } from "../../components/UrlPager";
import { useUrlCursor } from "../../components/urlCursor";
import { useUrlParams, when } from "../../components/urlParams";
import { useSecurityClient } from "../../context";
import { useGlobalCanFn } from "../../meta/hooks";
import { alertKeys } from "./alertQueries";

/** The channel filter, shared by both lists. */
function ChannelFilter() {
  const { params, set } = useUrlParams();
  return (
    <form
      className="filters"
      aria-label="Filters"
      onSubmit={(event) => event.preventDefault()}
    >
      <label>
        Channel{" "}
        <input
          className="input"
          defaultValue={params.get("channel") ?? ""}
          data-testid="filter-channel"
          onBlur={(e) => set("channel", e.target.value.trim())}
          onKeyDown={(e) => {
            if (e.key === "Enter") set("channel", e.currentTarget.value.trim());
          }}
        />
      </label>
    </form>
  );
}

/** The outcome's badge. */
function Outcome({ outcome }: { outcome: "sent" | "failed" | "dead" }) {
  return (
    <Badge
      tone={
        outcome === "sent"
          ? "success"
          : outcome === "failed"
            ? "warning"
            : "danger"
      }
    >
      {outcome === "sent"
        ? "Sent"
        : outcome === "failed"
          ? "Failed, retried"
          : "Dead letter"}
    </Badge>
  );
}

/** The delivery log. */
export function Deliveries() {
  const { client } = useSecurityClient();
  const { params } = useUrlParams();
  const position = useUrlCursor(50);
  const channel = params.get("channel") ?? "";
  const page = useQuery({
    queryKey: alertKeys.deliveries(channel, position.cursor, position.limit),
    queryFn: ({ signal }) =>
      dataOf(
        client.get("/alerts/deliveries", {
          query: {
            limit: position.limit,
            ...(position.cursor === undefined
              ? {}
              : { cursor: position.cursor }),
            ...(channel === "" ? {} : { channel }),
          },
          signal,
        }),
      ),
  });
  return (
    <section
      aria-label="Delivery log"
      data-testid="alerts-deliveries"
    >
      <ChannelFilter />
      {page.isError ? (
        <ErrorView
          error={page.error}
          title="The delivery log could not be read"
          onRetry={() => void page.refetch()}
        />
      ) : (
        <>
          <Table label="Delivery log">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Channel</th>
                <th scope="col">Alert</th>
                <th scope="col">Severity</th>
                <th scope="col">Outcome</th>
                <th scope="col">Tries</th>
                <th scope="col">Why</th>
              </tr>
            </thead>
            <tbody>
              {(page.data?.items ?? []).map((item) => (
                <tr
                  key={`${item.id}-${item.attempts}`}
                  data-testid="delivery-row"
                >
                  <td>{when(item.at)}</td>
                  <td>{item.channelId}</td>
                  <td>{item.kind}</td>
                  <td>{item.severity ?? "digest"}</td>
                  <td>
                    <Outcome outcome={item.outcome} />
                  </td>
                  <td>{item.attempts}</td>
                  <td>{item.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {page.data !== undefined && page.data.items.length === 0 ? (
            <p data-testid="deliveries-empty">No delivery yet.</p>
          ) : null}
          <UrlPager
            position={position}
            page={page.data}
            label="Delivery log pages"
          />
        </>
      )}
    </section>
  );
}

/** The dead letters. */
export function DeadLetters() {
  const { client } = useSecurityClient();
  const queryClient = useQueryClient();
  const { params } = useUrlParams();
  const position = useUrlCursor(50);
  const canWrite = useGlobalCanFn()("alerts:write");
  const [message, setMessage] = useState<string | null>(null);
  const channel = params.get("channel") ?? "";
  const page = useQuery({
    queryKey: alertKeys.deadLetters(channel, position.cursor, position.limit),
    queryFn: ({ signal }) =>
      dataOf(
        client.get("/alerts/dead-letters", {
          query: {
            limit: position.limit,
            ...(position.cursor === undefined
              ? {}
              : { cursor: position.cursor }),
            ...(channel === "" ? {} : { channel }),
          },
          signal,
        }),
      ),
  });
  const replay = async (id: string) => {
    setMessage(null);
    try {
      await dataOf(
        client.post("/alerts/dead-letters/:id/replay", { params: { id } }),
      );
      setMessage(`Dead letter ${id} queued again.`);
      await queryClient.invalidateQueries({ queryKey: ["alerts"] });
    } catch (error) {
      setMessage(
        isApiError(error)
          ? `Not replayed: ${error.detail ?? error.title}`
          : "Not replayed.",
      );
    }
  };
  return (
    <section
      aria-label="Dead letters"
      data-testid="alerts-dead-letters"
    >
      <ChannelFilter />
      {message === null ? null : (
        <p
          role="status"
          data-testid="replay-outcome"
        >
          {message}
        </p>
      )}
      {page.isError ? (
        <ErrorView
          error={page.error}
          title="The dead letters could not be read"
          onRetry={() => void page.refetch()}
        />
      ) : (
        <>
          <Table label="Dead letters">
            <thead>
              <tr>
                <th scope="col">Died</th>
                <th scope="col">Channel</th>
                <th scope="col">Alert</th>
                <th scope="col">Severity</th>
                <th scope="col">Tries</th>
                <th scope="col">Last failure</th>
                {canWrite ? <th scope="col">Replay</th> : null}
              </tr>
            </thead>
            <tbody>
              {(page.data?.items ?? []).map((item) => (
                <tr
                  key={item.id}
                  data-testid="dead-letter-row"
                >
                  <td>{when(item.diedAt)}</td>
                  <td>{item.channelId}</td>
                  <td>{item.kind}</td>
                  <td>{item.severity ?? "digest"}</td>
                  <td>{item.attempts}</td>
                  <td>{item.reason}</td>
                  {canWrite ? (
                    <td>
                      <Button
                        size="sm"
                        data-testid="dead-letter-replay"
                        onClick={() => void replay(item.id)}
                      >
                        Replay
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
          {page.data !== undefined && page.data.items.length === 0 ? (
            <p data-testid="dead-letters-empty">No dead letter.</p>
          ) : null}
          <UrlPager
            position={position}
            page={page.data}
            label="Dead letter pages"
          />
        </>
      )}
    </section>
  );
}
