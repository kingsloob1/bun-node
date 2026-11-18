/**
 * One agent (ui.md §8, control-plane.md §7): its key (made, by whom,
 * rotated, revoked), its health and what its last heartbeat said — the
 * bundle and signing key it verified, the bans it holds, its warnings,
 * its IP feeds and the ban reports it dropped. With `agents:write` on its
 * service: **Rotate** (a step-up; the new secret shown once, the old one
 * accepted until the agent first uses the new one, or 24 hours) and
 * **Revoke** (at once).
 */
import { Table } from "../../../kit/components/Table";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "../../../kit/components/Badge";
import { Button } from "../../../kit/components/Button";
import { ConfirmDialog } from "../../../kit/components/ConfirmDialog";
import { Spinner } from "../../../kit/components/Spinner";
import { dataOf } from "../../api/client";
import { isApiError } from "../../api/errors";
import { ErrorView } from "../../components/ErrorView";
import { SecretOnce } from "../../components/SecretOnce";
import { when } from "../../components/urlParams";
import { useSecurityClient } from "../../context";
import { useScopeCan } from "../../meta/useScopeCan";
import { Link } from "../../router";
import { useParams } from "../../routing";
import { withStepUp } from "../../stepUp";
import { agentKeys, STATUS } from "./agentQueries";

/** Props of {@link AgentDetail}. */
export interface AgentDetailProps {
  /** The scope on screen (links keep it). */
  scope: string;
}

/** See the module's description. */
export function AgentDetail({ scope }: AgentDetailProps) {
  const { id = "" } = useParams<{ id: string }>();
  const { client } = useSecurityClient();
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const agent = useQuery({
    queryKey: agentKeys.detail(id),
    refetchInterval: 15_000,
    queryFn: ({ signal }) =>
      dataOf(client.get("/agents/:id", { params: { id }, signal })),
  });
  const can = useScopeCan(
    agent.data === undefined ? undefined : `service:${agent.data.service}`,
  );
  const back = (
    <p>
      <Link to={`/agents?scope=${encodeURIComponent(scope)}`}>Agents</Link>
    </p>
  );
  if (agent.isPending) return <Spinner label="Loading the agent" />;
  if (agent.isError) {
    return (
      <div className="screen">
        {back}
        <ErrorView
          headingLevel={1}
          error={agent.error}
          title="The agent could not be read"
          onRetry={() => void agent.refetch()}
        />
      </div>
    );
  }
  const data = agent.data;
  const status = STATUS[data.status];
  const reported = data.reported;
  const canWrite = can("agents:write") && data.revokedAt === null;
  /** Reloads the agent and the list. */
  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: ["agents"] });
  };
  const rotate = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const answer = await withStepUp(() =>
        dataOf(
          client.post("/agents/:id/rotate", {
            params: { id },
            body: { revision: data.revision },
          }),
        ),
      );
      setSecret(answer.secret);
      await reload();
    } catch (error) {
      setMessage(
        isApiError(error)
          ? `Not rotated: ${error.detail ?? error.title}`
          : "Not rotated.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="screen"
      data-testid="agent-detail"
    >
      {back}
      <h1>
        {data.name} <Badge tone={status.tone}>{status.label}</Badge>
      </h1>
      {secret === null ? null : (
        <SecretOnce
          label="The agent's new secret"
          secret={secret}
          use={`Configure agent "${data.id}" with it; its old secret is accepted until the agent first uses this one, or 24 hours`}
          onDone={() => setSecret(null)}
        />
      )}
      <dl
        className="key-value"
        data-testid="agent-facts"
      >
        <dt>Id</dt>
        <dd>
          <code>{data.id}</code>
        </dd>
        <dt>Service</dt>
        <dd>{data.service}</dd>
        <dt>Key made</dt>
        <dd>
          {when(data.createdAt)} by {data.createdBy}
        </dd>
        <dt>Rotated</dt>
        <dd>
          {data.rotatedAt === null ? "never" : when(data.rotatedAt)}
          {data.previousAcceptedUntil === null
            ? null
            : `; the old secret is accepted until ${when(data.previousAcceptedUntil)} or its first use of the new one`}
        </dd>
        {data.revokedAt === null ? null : (
          <>
            <dt>Revoked</dt>
            <dd>{when(data.revokedAt)}</dd>
          </>
        )}
        <dt>Last heartbeat</dt>
        <dd>{when(data.lastSeen)}</dd>
      </dl>
      {reported === null ? (
        <p data-testid="agent-unreported">No heartbeat yet.</p>
      ) : (
        <section
          aria-label="Health"
          data-testid="agent-health"
        >
          <h2>What it reported</h2>
          <dl className="key-value">
            <dt>Agent version</dt>
            <dd>{reported.agentVersion}</dd>
            <dt>Bundle</dt>
            <dd>
              {reported.bundleVersion === null
                ? "none (on its host's own policy)"
                : `version ${reported.bundleVersion}, verified with key ${reported.bundleKeyId ?? "?"}`}
              {reported.bundleExpired ? " — expired, still enforced" : ""}
            </dd>
            <dt>Bans held</dt>
            <dd>
              {reported.banCount.toLocaleString()} (sequence {reported.banSeq})
            </dd>
            <dt>Signatures</dt>
            <dd>{reported.health === "ok" ? "OK" : "Failing"}</dd>
            {reported.lastError === undefined ? null : (
              <>
                <dt>Last error</dt>
                <dd>{reported.lastError}</dd>
              </>
            )}
            <dt>Ban reports dropped</dt>
            <dd data-testid="agent-bans-dropped">
              {reported.bansDropped === undefined
                ? "not reported (an older agent)"
                : reported.bansDropped === 0
                  ? "none since its previous heartbeat"
                  : `${reported.bansDropped.toLocaleString()} since its previous heartbeat (past its cap, or unsendable); its engine still enforces them`}
            </dd>
          </dl>
          <h3>Warnings</h3>
          {(reported.warnings ?? []).length === 0 ? (
            <p data-testid="agent-warnings-none">None in force.</p>
          ) : (
            <ul
              className="health-list"
              data-testid="agent-warnings"
            >
              {(reported.warnings ?? []).map((warning) => (
                <li key={warning.kind}>
                  <code>{warning.kind}</code> since {when(warning.since)}
                  {warning.share === undefined
                    ? ""
                    : `, ${Math.round(warning.share * 100)}% of requests`}
                </li>
              ))}
            </ul>
          )}
          <h3>IP feeds</h3>
          {(reported.intel?.feeds ?? []).length === 0 ? (
            <p data-testid="agent-feeds-none">None configured.</p>
          ) : (
            <Table
              label="IP feeds"
              testId="agent-feeds"
            >
              <thead>
                <tr>
                  <th scope="col">Feed</th>
                  <th scope="col">Entries</th>
                  <th scope="col">Refreshed</th>
                  <th scope="col">Last tried</th>
                  <th scope="col">Last failure</th>
                </tr>
              </thead>
              <tbody>
                {(reported.intel?.feeds ?? []).map((feed) => (
                  <tr key={feed.id}>
                    <td>{feed.id}</td>
                    <td>{feed.size.toLocaleString()}</td>
                    <td>{when(feed.refreshedAt)}</td>
                    <td>{when(feed.attemptedAt)}</td>
                    <td>{feed.error ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      )}
      {canWrite ? (
        <div className="ban-actions">
          <Button
            size="sm"
            data-testid="agent-rotate"
            disabled={busy}
            onClick={() => void rotate()}
          >
            Rotate its secret
          </Button>
          <Button
            size="sm"
            variant="danger"
            data-testid="agent-revoke"
            disabled={busy}
            onClick={() => setRevoking(true)}
          >
            Revoke
          </Button>
        </div>
      ) : null}
      {message === null ? null : <p role="alert">{message}</p>}
      {canWrite ? (
        <ConfirmDialog
          open={revoking}
          onClose={() => setRevoking(false)}
          isApiError={isApiError}
          variant="danger"
          title={`Revoke agent "${data.id}"`}
          confirmLabel="Revoke"
          pendingLabel="Revoking…"
          onConfirm={async () => {
            await dataOf(
              client.post("/agents/:id/revoke", {
                params: { id },
                body: { revision: data.revision },
              }),
            );
            await reload();
          }}
        >
          <p>
            Its key stops working at once: the agent keeps enforcing its last
            bundle and bans, but gets nothing new.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
