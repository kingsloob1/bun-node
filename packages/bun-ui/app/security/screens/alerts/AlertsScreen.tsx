/**
 * The alerts (ui.md §8, README §9.3), one tab each, its path in the URL:
 * the alerts open now (read-only), the rules, the channels, the delivery
 * log and the dead letters. The channels, log and dead letters are the
 * control plane's own (`global`): their tabs are absent without
 * `alerts:read` there. A control plane run without alerting (its `alerts`
 * option unset, every `/alerts/*` route a `404`) says so instead of tabs.
 */
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { dataOf } from "../../api/client";
import { useSecurityClient } from "../../context";
import { notConfigured } from "../agents/agentQueries";
import { alertKeys } from "./alertQueries";
import { Tabs } from "../../../kit/components/Tabs";
import { useGlobalCanFn } from "../../meta/hooks";
import { useRouter } from "../../routing";
import { scopeLabel } from "../../scope/scope";
import { AlertChannelForm } from "./AlertChannelForm";
import { AlertChannels } from "./AlertChannels";
import { DeadLetters, Deliveries } from "./AlertLog";
import { AlertRuleForm } from "./AlertRuleForm";
import { AlertRules } from "./AlertRules";
import { OpenAlerts } from "./OpenAlerts";

/** The tabs, by path under `/alerts`. */
const TABS = [
  { value: "", label: "Open", global: false },
  { value: "rules", label: "Rules", global: false },
  { value: "channels", label: "Channels", global: true },
  { value: "deliveries", label: "Delivery log", global: true },
  { value: "dead-letters", label: "Dead letters", global: true },
] as const;

/** A path segment decoded; a malformed one as it is. */
function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** A tab's path. */
type TabPath = (typeof TABS)[number]["value"];

/** Props of {@link AlertsScreen}. */
export interface AlertsScreenProps {
  /** The scope on screen. */
  scope: string;
}

/** See the module's description. */
export function AlertsScreen({ scope }: AlertsScreenProps) {
  const { location, navigate } = useRouter();
  const canGlobal = useGlobalCanFn()("alerts:read");
  const rest = (location.path ?? "/alerts").replace(/^\/alerts\/?/, "");
  const [first = "", second] = rest.split("/");
  const tabs = TABS.filter((tab) => !tab.global || canGlobal);
  const tab: TabPath = tabs.some((item) => item.value === first)
    ? (first as TabPath)
    : "";
  const scopeQuery = `scope=${encodeURIComponent(scope)}`;
  const { client } = useSecurityClient();
  // The open alerts' read (shared with the Open tab) tells whether alerting runs.
  const probe = useQuery({
    queryKey: alertKeys.open(),
    queryFn: ({ signal }) => dataOf(client.get("/alerts/open", { signal })),
  });
  if (probe.isError && notConfigured(probe.error)) {
    return (
      <div
        className="screen"
        data-testid="alerts"
      >
        <h1>Alerts: {scopeLabel(scope)}</h1>
        <p data-testid="alerts-off">
          This control plane runs no alerting (its <code>alerts</code> option is
          not set).
        </p>
      </div>
    );
  }
  let body: ReactNode;
  if (tab === "rules")
    body =
      second === undefined ? (
        <AlertRules scope={scope} />
      ) : (
        <AlertRuleForm
          scope={scope}
          id={decoded(second)}
        />
      );
  else if (tab === "channels")
    body =
      second === undefined ? (
        <AlertChannels scope={scope} />
      ) : (
        <AlertChannelForm
          scope={scope}
          id={decoded(second)}
        />
      );
  else if (tab === "deliveries") body = <Deliveries />;
  else if (tab === "dead-letters") body = <DeadLetters />;
  else body = <OpenAlerts scope={scope} />;
  return (
    <div
      className="screen"
      data-testid="alerts"
    >
      <h1>Alerts: {scopeLabel(scope)}</h1>
      <Tabs
        label="Alerts"
        tabs={tabs.map((item) => ({ value: item.value, label: item.label }))}
        value={tab}
        onChange={(value) =>
          navigate(`/alerts${value === "" ? "" : `/${value}`}?${scopeQuery}`)
        }
      >
        {body}
      </Tabs>
    </div>
  );
}
