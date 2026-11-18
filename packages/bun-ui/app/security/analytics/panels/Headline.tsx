/**
 * Headline totals (ui.md §7, PR-U2): active bans and bans made in the range
 * (`bans:read`); refused requests, distinct refused addresses, request-rule
 * and Tor refusals, challenges passed and failed (`analytics:read`).
 */
import type { ReactNode } from "react";
import { formatCount } from "../../../kit/charts/chart";
import {
  readBanTimeline,
  readDistinct,
  readSeries,
  readTop,
  sumBy,
} from "../api";
import { isPatternRule, isTorRule, REFUSING } from "../actions";
import { Panel } from "../Panel";
import { usePanelQuery } from "../usePanelQuery";

/** Props of {@link Headline}. */
export interface HeadlineProps {
  /** Whether the operator reads bans on the scope. */
  canBans: boolean;
}

/** One tile. */
function Tile({
  label,
  value,
  testId,
}: {
  label: string;
  value: ReactNode;
  testId: string;
}) {
  return (
    <div className="headline-tile">
      <dt>{label}</dt>
      <dd data-testid={testId}>{value}</dd>
    </div>
  );
}

/** See the module's description. */
export function Headline({ canBans }: HeadlineProps) {
  const requests = usePanelQuery("headline.requests", (c) =>
    readSeries(c, "requests"),
  );
  const distinct = usePanelQuery("headline.distinct", (c) =>
    readDistinct(c, "refused.hourly", { kind: "ip" }, "hour"),
  );
  const rules = usePanelQuery("headline.rules", (c) =>
    readTop(c, "rules", { dryRun: "false" }, 100),
  );
  const challenges = usePanelQuery("headline.challenges", (c) =>
    readSeries(c, "challenges"),
  );
  const bans = usePanelQuery("headline.bans", readBanTimeline, {
    enabled: canBans,
  });
  // The ban tiles are extras: a deployment without the ban log keeps the rest.
  const states = [requests, distinct, rules, challenges];
  return (
    <Panel
      title="Headline"
      testId="panel-headline"
      states={states}
    >
      {() => {
        const byAction = sumBy(requests.data!, "action");
        const refused = [...byAction].reduce(
          (sum, [action, value]) => sum + (REFUSING.has(action) ? value : 0),
          0,
        );
        const refusing = rules.data!.rows.filter((row) =>
          REFUSING.has(row.dims.action ?? ""),
        );
        const sum = (keep: (rule: string) => boolean) =>
          refusing.reduce(
            (total, row) => total + (keep(row.dims.rule ?? "") ? row.value : 0),
            0,
          );
        const outcomes = sumBy(challenges.data!, "outcome");
        const created = bans.data?.points.reduce(
          (total, point) =>
            total + Object.values(point.created).reduce((a, b) => a + b, 0),
          0,
        );
        return (
          <dl className="headline">
            {canBans && bans.data !== undefined ? (
              <>
                <Tile
                  label="Active bans"
                  value={formatCount(bans.data.active)}
                  testId="headline-active-bans"
                />
                <Tile
                  label="Bans made"
                  value={formatCount(created ?? 0)}
                  testId="headline-bans-made"
                />
              </>
            ) : null}
            <Tile
              label="Refused requests"
              value={formatCount(refused)}
              testId="headline-refused"
            />
            <Tile
              label="Refused addresses"
              value={`${formatCount(distinct.data!.count)}${distinct.data!.other ? "+" : ""}`}
              testId="headline-refused-addresses"
            />
            <Tile
              label="Request-rule refusals"
              value={formatCount(sum(isPatternRule))}
              testId="headline-rule-refusals"
            />
            <Tile
              label="Tor refusals"
              value={formatCount(sum(isTorRule))}
              testId="headline-tor-refusals"
            />
            <Tile
              label="Challenges passed"
              value={formatCount(outcomes.get("passed") ?? 0)}
              testId="headline-challenges-passed"
            />
            <Tile
              label="Challenges failed"
              value={formatCount(outcomes.get("failed") ?? 0)}
              testId="headline-challenges-failed"
            />
          </dl>
        );
      }}
    </Panel>
  );
}
