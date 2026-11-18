/**
 * An impact estimate in a few lines (`POST /policies/:scope/impact`, and
 * an approval's, `POST /approvals/:id/impact`): how many stored events
 * were replayed on how many services, and each decision class that would
 * change, with its count.
 */
import type { Routes } from "../api/routes.gen";

/** The impact estimate's answer. */
export type ImpactDto =
  Routes["POST /policies/:scope/impact"]["responses"][200];

/** Props of {@link ImpactSummary}. */
export interface ImpactSummaryProps {
  /** The estimate. */
  impact: ImpactDto;
  /** Its test id. */
  testId: string;
  /** Its class. */
  className?: string;
}

/** See the module's description. */
export function ImpactSummary({
  impact,
  testId,
  className,
}: ImpactSummaryProps) {
  const changed = impact.transitions.filter((item) => item.from !== item.to);
  return (
    <div
      {...(className === undefined ? {} : { className })}
      data-testid={testId}
    >
      <p>
        Replayed {impact.events.read.toLocaleString("en")} stored events
        {impact.services.replayed.length > 0
          ? ` on ${impact.services.replayed.length} service(s)`
          : ""}
        .
      </p>
      {changed.length === 0 ? (
        <p>No decision would change.</p>
      ) : (
        <ul>
          {changed.map((item) => (
            <li key={`${item.from}-${item.to}`}>
              {item.count.toLocaleString("en")}: {item.from} → {item.to}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
