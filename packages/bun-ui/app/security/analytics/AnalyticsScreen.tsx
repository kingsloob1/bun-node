/**
 * The analytics page (ui.md §7, PR-U2), the security UI's landing: the
 * scope's panels over a range picked in the URL (`?range=`), each a lazy
 * chunk in its own error boundary, each shown only with its read
 * permission (account subjects per event, never a sample: the server's
 * rules, CP5 and PR-AN). A range ending now refreshes as it goes.
 */
import type { ReactNode } from "react";
import { RangePicker } from "../../kit/components/RangePicker";
import { ScreenErrorBoundary } from "../components/ScreenErrorBoundary";
import { useCan, useGlobalCanFn } from "../meta/hooks";
import { scopeLabel } from "../scope/scope";
import { AnalyticsViewContext } from "./context";
import {
  ActivityFeedPanel,
  AgentHealthPanel,
  BanTimelinePanel,
  CredentialStuffingPanel,
  GeographyPanel,
  HeadlinePanel,
  IntelSourcesPanel,
  OutcomeMixPanel,
  PatternsPanel,
  RuleHitsPanel,
  ServicesRoutesPanel,
  TopOffendersPanel,
  TrafficPanel,
} from "./lazy";
import { ANALYTICS_RANGE } from "./range";
import { useRange } from "./useRange";
import "./analytics.css";

/** Props of {@link AnalyticsScreen}. */
export interface AnalyticsScreenProps {
  /** The scope on screen. */
  scope: string;
}

/** See the module's description. */
export function AnalyticsScreen({ scope }: AnalyticsScreenProps) {
  const { range, setRange } = useRange();
  const canBans = useCan("bans:read");
  const canAccounts = useCan("events:read");
  const canBan = useCan("bans:write");
  const canAllow = useCan("policy:draft");
  const canAgents = useGlobalCanFn()("agents:read");
  const key = `${scope}|${ANALYTICS_RANGE.writeRange(range) ?? ""}`;
  const boxed = (node: ReactNode) => (
    <ScreenErrorBoundary resetKey={key}>{node}</ScreenErrorBoundary>
  );
  return (
    <div
      className="screen analytics"
      data-testid="analytics"
    >
      <div className="analytics-head">
        <h1>Analytics: {scopeLabel(scope)}</h1>
        <RangePicker
          model={ANALYTICS_RANGE}
          range={range}
          onChange={setRange}
          label="Analytics range"
        />
      </div>
      <AnalyticsViewContext value={{ scope, range }}>
        <div className="analytics-grid">
          {boxed(<HeadlinePanel canBans={canBans} />)}
          {boxed(<TrafficPanel />)}
          {boxed(<OutcomeMixPanel />)}
          {boxed(
            <TopOffendersPanel
              canAccounts={canAccounts}
              canBans={canBans}
              canBan={canBan}
              canAllow={canAllow}
            />,
          )}
          {boxed(<ActivityFeedPanel />)}
          {boxed(<RuleHitsPanel />)}
          {boxed(<ServicesRoutesPanel />)}
          {boxed(<GeographyPanel />)}
          {canBans ? boxed(<BanTimelinePanel />) : null}
          {boxed(<CredentialStuffingPanel />)}
          {boxed(<PatternsPanel />)}
          {canAgents ? boxed(<AgentHealthPanel />) : null}
          {canAgents ? boxed(<IntelSourcesPanel />) : null}
        </div>
      </AnalyticsViewContext>
    </div>
  );
}
