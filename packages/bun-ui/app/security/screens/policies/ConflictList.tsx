/**
 * The crawler conflicts a scope's agents report (layers.md L3.2, PR-AN2),
 * for the crawler tab and the publish dialog: each crawler with the entry
 * or ban covering one of its published ranges, and the services reporting
 * it. Only the agents hold the ranges, so the list is of what is
 * published: a draft's new conflicts appear only after it is published.
 */
import type { ConflictReport } from "./crawlers";
import { scopeLabel } from "../../scope/scope";

/** Props of {@link ConflictList}. */
export interface ConflictListProps {
  /** What the agents report. */
  report: ConflictReport;
  /** A test id. */
  testId?: string;
}

/** See the module's description. */
export function ConflictList({ report, testId }: ConflictListProps) {
  return (
    <div
      className="policy-conflicts"
      data-testid={testId}
      role={report.conflicts.length > 0 ? "alert" : undefined}
    >
      {report.agents === 0 ? (
        <p className="muted">
          No agent serves this scope: nothing reports conflicts.
        </p>
      ) : report.conflicts.length === 0 ? (
        <p data-testid="crawler-conflicts-none">
          No conflict reported by the {report.reporting.toLocaleString("en")}{" "}
          agent(s) that check.
        </p>
      ) : (
        <ul>
          {report.conflicts.map((conflict) => (
            <li
              key={`${conflict.crawler}:${conflict.entry ?? ""}:${conflict.ban ?? ""}`}
              data-testid="crawler-conflict"
            >
              <strong>{conflict.crawler}</strong>:{" "}
              {conflict.entry === undefined ? (
                <>
                  ban <code>{conflict.ban}</code>
                </>
              ) : (
                <>
                  list entry <code>{conflict.entry}</code>
                </>
              )}{" "}
              covers its range <code>{conflict.range}</code> (
              {conflict.services
                .map((s) => scopeLabel(`service:${s}`))
                .join(", ")}
              ). A verified {conflict.crawler} crawler is refused there, and the
              site may drop out of its index.
            </li>
          ))}
        </ul>
      )}
      {report.truncated ? (
        <p className="muted">An agent found more than it reports (32 each).</p>
      ) : null}
      <p
        className="muted"
        data-testid="crawler-conflicts-note"
      >
        These are the published policy&apos;s conflicts, as the services&apos;
        agents report them: only the agents hold the crawlers&apos; ranges, so a
        draft&apos;s new conflicts appear only after it is published.
      </p>
    </div>
  );
}
