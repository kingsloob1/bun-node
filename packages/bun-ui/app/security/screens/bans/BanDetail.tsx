/**
 * One ban (ui.md §4.2): its subject (with country and ASN), state and
 * writes; its history (the audit entries on it); the subject's events that
 * led to it (a link into the events list) and its hits since; its bans in
 * other scopes; and, with `bans:write` on its scope, extend, make
 * permanent, widen to the /24 or /64, and lift. The escalation ladder's
 * step shows once agents report their engines' bans.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../../kit/components/Button";
import { Spinner } from "../../../kit/components/Spinner";
import { dataOf } from "../../api/client";
import { isApiError } from "../../api/errors";
import { queryKeys } from "../../api/keys";
import { ErrorView } from "../../components/ErrorView";
import { Subject } from "../../components/Subject";
import { useSecurityClient } from "../../context";
import { canPerform } from "../../meta/hooks";
import { Link } from "../../router";
import { useNavigate, useParams } from "../../routing";
import { scopeLabel } from "../../scope/scope";
import { banKeys, when } from "./banQueries";

/** Props of {@link BanDetail}. */
export interface BanDetailProps {
  /** The scope on screen (links keep it). */
  scope: string;
}

/** The ways to extend a ban. */
const EXTENSIONS = ["24h", "7d", "30d", "90d"] as const;

/** See the module's description. */
export function BanDetail({ scope }: BanDetailProps) {
  const { id = "" } = useParams<{ id: string }>();
  const { client } = useSecurityClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [extension, setExtension] = useState<(typeof EXTENSIONS)[number]>("7d");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: banKeys.detail(id),
    queryFn: ({ signal }) =>
      dataOf(client.get("/bans/:id", { params: { id }, signal })),
  });
  const banScope = detail.data?.ban.scope;
  const permissions = useQuery({
    queryKey: queryKeys.permissions(banScope ?? "global"),
    enabled: banScope !== undefined,
    staleTime: 60_000,
    queryFn: ({ signal }) =>
      dataOf(
        client.get("/meta/permissions", {
          query: { scope: banScope ?? "global" },
          signal,
        }),
      ),
  });
  const scopeQuery = `scope=${encodeURIComponent(scope)}`;
  if (detail.isPending)
    return (
      <Spinner
        label="Loading the ban"
        showLabel
      />
    );
  if (detail.isError) {
    return (
      <div className="screen">
        <ErrorView
          headingLevel={1}
          error={detail.error}
          title="The ban could not be read"
          onRetry={() => void detail.refetch()}
        />
      </div>
    );
  }
  const {
    ban,
    history,
    historyTruncated,
    events,
    hitsSince,
    hitsSinceCapped,
    otherBans,
    ladderStep,
  } = detail.data;
  const canWrite =
    permissions.data !== undefined &&
    canPerform(permissions.data, "bans:write");
  /** Runs an action, then reloads the detail and the lists. */
  const act = async (run: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await run();
      setMessage(done);
      await queryClient.invalidateQueries({ queryKey: banKeys.detail(id) });
      await queryClient.invalidateQueries({ queryKey: ["bansList"] });
    } catch (failure) {
      setMessage(
        isApiError(failure)
          ? (failure.detail ?? failure.title)
          : "The action failed.",
      );
    } finally {
      setBusy(false);
    }
  };
  const eventsLink =
    ban.subject.type === "ip"
      ? `/events?${scopeQuery}&ip=${encodeURIComponent(ban.subject.value)}&to=${ban.createdAt}`
      : ban.subject.type === "user" || ban.subject.type === "apiKey"
        ? `/events?${scopeQuery}&${ban.subject.type}=${encodeURIComponent(ban.subject.value)}&to=${ban.createdAt}`
        : undefined;
  return (
    <div
      className="screen"
      data-testid="ban-detail"
    >
      <p>
        <Link to={`/bans?${scopeQuery}`}>Bans</Link>
      </p>
      <h1>
        <Subject
          kind={ban.subject.type}
          value={ban.subject.value}
          {...(ban.country === undefined ? {} : { country: ban.country })}
          {...(ban.asn === undefined ? {} : { asn: ban.asn })}
        />
      </h1>
      <dl
        className="key-value"
        data-testid="ban-facts"
      >
        <dt>Scope</dt>
        <dd>{scopeLabel(ban.scope)}</dd>
        <dt>State</dt>
        <dd data-testid="ban-state">
          {ban.active
            ? "In force"
            : ban.liftedAt === null
              ? "Expired"
              : "Lifted"}
        </dd>
        <dt>Action</dt>
        <dd>{ban.action}</dd>
        <dt>Reason</dt>
        <dd>{ban.reason}</dd>
        <dt>Source</dt>
        <dd>
          {ban.source}
          {ban.rule === undefined ? "" : ` (rule ${ban.rule})`}
        </dd>
        <dt>Started</dt>
        <dd>
          {when(ban.createdAt)}
          {ban.createdBy === undefined ? "" : ` by ${ban.createdBy}`}
        </dd>
        <dt>Ends</dt>
        <dd data-testid="ban-ends">
          {ban.expiresAt === null ? "Permanent" : when(ban.expiresAt)}
        </dd>
        {ban.liftedAt === null ? null : (
          <>
            <dt>Lifted</dt>
            <dd>
              {when(ban.liftedAt)}
              {ban.liftedBy === undefined ? "" : ` by ${ban.liftedBy}`}
            </dd>
          </>
        )}
        <dt>Writes</dt>
        <dd>{ban.count}</dd>
        {ladderStep === undefined ? null : (
          <>
            <dt>Ladder step</dt>
            <dd data-testid="ban-ladder">{ladderStep}</dd>
          </>
        )}
        {hitsSince === undefined ? null : (
          <>
            <dt>Hits since</dt>
            <dd data-testid="ban-hits">
              {hitsSince.toLocaleString()}
              {hitsSinceCapped === true ? "+" : ""}
            </dd>
          </>
        )}
      </dl>
      {canWrite && ban.active ? (
        <div
          className="ban-actions"
          data-testid="ban-actions"
        >
          <label>
            Extend to{" "}
            <select
              className="input"
              value={extension}
              data-testid="ban-extension"
              onChange={(e) =>
                setExtension(e.target.value as (typeof EXTENSIONS)[number])
              }
            >
              {EXTENSIONS.map((option) => (
                <option
                  key={option}
                  value={option}
                >
                  {option} from now
                </option>
              ))}
            </select>
          </label>{" "}
          <Button
            size="sm"
            disabled={busy}
            data-testid="ban-extend"
            onClick={() =>
              void act(
                () =>
                  dataOf(
                    client.post("/bans/:id/extend", {
                      params: { id },
                      body: { duration: extension },
                    }),
                  ),
                "Extended.",
              )
            }
          >
            Extend
          </Button>{" "}
          {ban.expiresAt === null ? null : (
            <Button
              size="sm"
              disabled={busy}
              data-testid="ban-permanent"
              onClick={() =>
                void act(
                  () =>
                    dataOf(
                      client.post("/bans/:id/extend", {
                        params: { id },
                        body: { duration: null },
                      }),
                    ),
                  "Made permanent.",
                )
              }
            >
              Make permanent
            </Button>
          )}{" "}
          {ban.subject.type === "ip" ? (
            <Button
              size="sm"
              disabled={busy}
              data-testid="ban-widen"
              onClick={() =>
                void act(async () => {
                  const range = await dataOf(
                    client.post("/bans/:id/widen", { params: { id } }),
                  );
                  navigate(
                    `/bans/${encodeURIComponent(range.id)}?${scopeQuery}`,
                  );
                }, "Widened.")
              }
            >
              Widen to the {ban.subject.value.includes(":") ? "/64" : "/24"}
            </Button>
          ) : null}{" "}
          <Button
            size="sm"
            variant="danger"
            disabled={busy}
            data-testid="ban-lift"
            onClick={() =>
              void act(
                () => dataOf(client.post("/bans/:id/lift", { params: { id } })),
                "Lifted.",
              )
            }
          >
            Lift
          </Button>
        </div>
      ) : null}
      {message === null ? null : (
        <p
          role="status"
          data-testid="ban-message"
        >
          {message}
        </p>
      )}
      <h2>History</h2>
      <ol
        className="ban-history"
        data-testid="ban-history"
      >
        {history.map((entry) => (
          <li key={entry.n}>
            {when(entry.at)}: {entry.action} by {entry.actor}
            {entry.status === undefined ? "" : ` (${entry.status})`}
          </li>
        ))}
      </ol>
      {historyTruncated ? (
        <p className="muted">Older entries are in the audit log.</p>
      ) : null}
      {events === undefined ? null : (
        <>
          <h2>What led to it</h2>
          <ul data-testid="ban-events">
            {events.map((event) => (
              <li key={event.id}>
                <Link
                  to={`/events/${encodeURIComponent(event.id)}?${scopeQuery}`}
                >
                  {when(event.at)} · {event.service} · {event.action}
                  {event.route === undefined ? "" : ` · ${event.route}`}
                  {event.rule === undefined ? "" : ` · ${event.rule}`}
                </Link>
              </li>
            ))}
          </ul>
          {eventsLink === undefined ? null : (
            <Link to={eventsLink}>All the subject's events before it</Link>
          )}
        </>
      )}
      {otherBans.length === 0 ? null : (
        <>
          <h2>Bans in other scopes</h2>
          <ul data-testid="ban-others">
            {otherBans.map((other) => (
              <li key={other.id}>
                <Link
                  to={`/bans/${encodeURIComponent(other.id)}?${scopeQuery}`}
                >
                  {scopeLabel(other.scope)}:{" "}
                  {other.active ? "in force" : "not in force"}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
