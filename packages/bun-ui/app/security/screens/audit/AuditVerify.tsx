/**
 * The chain's state (ui.md §8, control-plane.md §6.2): the latest signed
 * checkpoint, and on demand the verification (`GET /audit/verify`, which
 * recomputes every hash): checked or broken, the first problem first, the
 * external sinks, and intents with no done entry, reconciled.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "../../../kit/components/Badge";
import { Button } from "../../../kit/components/Button";
import { dataOf } from "../../api/client";
import { ErrorView } from "../../components/ErrorView";
import { when } from "../../components/urlParams";
import { useSecurityClient } from "../../context";
import { auditKeys } from "./auditQueries";

/** What the external sinks' state means, for people. */
const EXTERNAL: Record<string, string> = {
  "none-configured": "No external checkpoint sink is configured.",
  checked: "Checked against the external sinks' copies.",
  "write-only":
    "The external sinks are write-only: their copies could not be read back here.",
};

/** See the module's description. */
export function AuditVerify() {
  const { client } = useSecurityClient();
  const [asked, setAsked] = useState(false);
  const checkpoint = useQuery({
    queryKey: auditKeys.checkpoint(),
    queryFn: async ({ signal }) =>
      (
        await dataOf(
          client.get("/audit/checkpoints", { query: { limit: 1 }, signal }),
        )
      ).items[0] ?? null,
  });
  const verify = useQuery({
    queryKey: auditKeys.verify(),
    enabled: asked,
    staleTime: 0,
    gcTime: 0,
    queryFn: ({ signal }) => dataOf(client.get("/audit/verify", { signal })),
  });
  const result = verify.data;
  return (
    <section
      className="card"
      aria-label="The chain"
      data-testid="audit-chain"
    >
      <h2>The chain</h2>
      <p data-testid="audit-checkpoint">
        {checkpoint.data === undefined
          ? "Reading the latest checkpoint…"
          : checkpoint.data === null
            ? "No checkpoint signed yet."
            : `Latest checkpoint: entry ${checkpoint.data.n}, signed ${when(checkpoint.data.at)} with key ${checkpoint.data.keyId}.`}
      </p>
      <Button
        size="sm"
        data-testid="audit-verify"
        disabled={verify.isFetching}
        onClick={() => {
          if (asked) void verify.refetch();
          else setAsked(true);
        }}
      >
        {verify.isFetching ? "Verifying…" : "Verify the chain"}
      </Button>
      {verify.isError ? (
        <ErrorView
          error={verify.error}
          title="The chain could not be verified"
        />
      ) : null}
      {result === undefined ? null : (
        <div data-testid="audit-verdict">
          <p>
            {result.ok ? (
              <Badge tone="success">Intact</Badge>
            ) : (
              <Badge tone="danger">Broken</Badge>
            )}{" "}
            {result.checked.toLocaleString()} entries checked
            {result.first === null
              ? ""
              : ` (${result.first} to ${result.last ?? result.first})`}
            , {result.checkpoints.checked.toLocaleString()} checkpoints.
          </p>
          <p>{EXTERNAL[result.external] ?? result.external}</p>
          {result.problems.length === 0 ? null : (
            <ul data-testid="audit-problems">
              {result.problems.map((problem, index) => (
                <li key={`${problem.n}-${index}`}>
                  Entry {problem.n}: {problem.reason}, {problem.detail}
                  {problem.source === undefined
                    ? ""
                    : ` (checkpoint from ${problem.source})`}
                </li>
              ))}
            </ul>
          )}
          {result.unconfirmed.length === 0 ? null : (
            <>
              <h3>Intents with no done entry</h3>
              <ul data-testid="audit-unconfirmed">
                {result.unconfirmed.map((item) => (
                  <li key={item.n}>
                    Entry {item.n}, {item.action} on {item.scope}:{" "}
                    {item.status === "completed-unconfirmed"
                      ? "the change is there"
                      : "the change was not applied"}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
