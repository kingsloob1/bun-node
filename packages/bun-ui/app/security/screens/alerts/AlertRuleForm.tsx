/**
 * An alert rule, made or changed (`PUT /alerts/rules/:id`, `revision: null`
 * to make it): its id (when new), title, scope, severity, what it watches
 * (the condition's fields by kind), its channels and whether it is on.
 * Read-only without `alerts:write` on the rule's scope; **Delete** with it.
 * A rule changed elsewhere meanwhile is a `409`, said so.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../../kit/components/Button";
import { ConfirmDialog } from "../../../kit/components/ConfirmDialog";
import { Spinner } from "../../../kit/components/Spinner";
import { dataOf } from "../../api/client";
import { isApiError } from "../../api/errors";
import { ErrorView } from "../../components/ErrorView";
import { useSecurityClient } from "../../context";
import { useScopeCan } from "../../meta/useScopeCan";
import { Link } from "../../router";
import { useNavigate } from "../../routing";
import { isScope } from "../../scope/scope";
import type { AlertRuleDto } from "./alertQueries";
import { alertKeys, ruleCondition } from "./alertQueries";
import type { ConditionFields, ConditionType } from "./conditionForm";
import {
  CONDITION_LABELS,
  CONDITION_TYPES,
  conditionOf,
  emptyCondition,
  fieldsOf,
} from "./conditionForm";

/** The condition's fields typed as free text. */
type TextField = Exclude<keyof ConditionFields, "type" | "source">;

/** An alert rule's or channel's id. */
const ALERT_ID = /^[a-z\d][\w.-]{0,63}$/i;

/** Props of {@link AlertRuleForm}. */
export interface AlertRuleFormProps {
  /** The id in the path, or `new`. */
  id: string;
  /** The scope on screen: a new rule watches it by default. */
  scope: string;
}

/** See the module's description. */
export function AlertRuleForm({ scope, id }: AlertRuleFormProps) {
  const fresh = id === "new";
  const { client } = useSecurityClient();
  const rule = useQuery({
    queryKey: alertKeys.rule(id),
    enabled: !fresh,
    queryFn: ({ signal }) =>
      dataOf(client.get("/alerts/rules/:id", { params: { id }, signal })),
  });
  const back = (
    <p>
      <Link to={`/alerts/rules?scope=${encodeURIComponent(scope)}`}>
        Alert rules
      </Link>
    </p>
  );
  if (!fresh && rule.isPending) return <Spinner label="Loading the rule" />;
  if (!fresh && rule.isError) {
    return (
      <div className="screen">
        {back}
        <ErrorView
          headingLevel={1}
          error={rule.error}
          title="The alert rule could not be read"
          onRetry={() => void rule.refetch()}
        />
      </div>
    );
  }
  return (
    <div
      className="screen"
      data-testid="alert-rule-form"
    >
      {back}
      <RuleEditor
        key={rule.data?.revision ?? "new"}
        scope={scope}
        rule={fresh ? null : (rule.data ?? null)}
      />
    </div>
  );
}

/** The form, for a rule read (or `null` for a new one). */
function RuleEditor({
  scope,
  rule,
}: {
  scope: string;
  rule: AlertRuleDto | null;
}) {
  const { client } = useSecurityClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [id, setId] = useState(rule?.id ?? "");
  const [title, setTitle] = useState(rule?.title ?? "");
  const [ruleScope, setRuleScope] = useState(rule?.scope ?? scope);
  const [severity, setSeverity] = useState<"info" | "warning" | "critical">(
    rule?.severity ?? "warning",
  );
  const [fields, setFields] = useState<ConditionFields>(
    rule === null ? emptyCondition() : fieldsOf(ruleCondition(rule)),
  );
  const [channels, setChannels] = useState<string[]>([
    ...(rule?.channels ?? []),
  ]);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const can = useScopeCan(rule?.scope ?? ruleScope);
  const canWrite = can("alerts:write");
  const choices = useQuery({
    queryKey: alertKeys.channelChoices(),
    staleTime: 60_000,
    queryFn: ({ signal }) =>
      dataOf(client.get("/alerts/channels", { query: { limit: 200 }, signal })),
  });
  const scopeQuery = `scope=${encodeURIComponent(scope)}`;
  const set = <K extends keyof ConditionFields>(
    key: K,
    value: ConditionFields[K],
  ) => setFields((old) => ({ ...old, [key]: value }));
  const save = async () => {
    setError(null);
    const ruleId = rule?.id ?? id.trim();
    if (!ALERT_ID.test(ruleId)) {
      setError(
        "An id is 1 to 64 letters, digits, _, . and -, starting with a letter or digit.",
      );
      return;
    }
    if (title.trim() === "") {
      setError("Give the rule a title.");
      return;
    }
    if (!isScope(ruleScope)) {
      setError("The scope is global, group:<id> or service:<id>.");
      return;
    }
    const condition = conditionOf(fields);
    if ("error" in condition) {
      setError(condition.error);
      return;
    }
    setBusy(true);
    try {
      await dataOf(
        client.put("/alerts/rules/:id", {
          params: { id: ruleId },
          body: {
            title: title.trim(),
            scope: ruleScope,
            severity,
            condition: condition.condition as unknown as Record<
              string,
              unknown
            >,
            channels,
            enabled,
            revision: rule?.revision ?? null,
          },
        }),
      );
      await queryClient.invalidateQueries({ queryKey: ["alerts"] });
      navigate(`/alerts/rules?${scopeQuery}`);
    } catch (failure) {
      setError(
        isApiError(failure)
          ? failure.status === 409
            ? "The rule changed meanwhile (or the id is taken): reload it."
            : (failure.detail ?? failure.title)
          : "The rule was not saved.",
      );
    } finally {
      setBusy(false);
    }
  };
  const field = (label: string, key: TextField, hint?: string) => (
    <label>
      {label}{" "}
      <input
        className="input"
        value={fields[key]}
        disabled={!canWrite}
        data-testid={`condition-${key}`}
        {...(hint === undefined ? {} : { placeholder: hint })}
        onChange={(e) => set(key, e.target.value)}
      />
    </label>
  );
  const metricFields = (
    <>
      {field("Metric", "metric", "requests")}
      {field("Dimensions", "dims", "action=block, rule=ladder")}
    </>
  );
  return (
    <>
      <h1>{rule === null ? "New alert rule" : rule.title}</h1>
      <form
        className="filters"
        aria-label="Alert rule"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {rule === null ? (
          <label>
            Id{" "}
            <input
              className="input"
              value={id}
              required
              data-testid="rule-id"
              onChange={(e) => setId(e.target.value)}
            />
          </label>
        ) : null}
        <label>
          Title{" "}
          <input
            className="input"
            value={title}
            disabled={!canWrite}
            data-testid="rule-title"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          Scope{" "}
          <input
            className="input"
            value={ruleScope}
            disabled={!canWrite}
            data-testid="rule-scope"
            onChange={(e) => setRuleScope(e.target.value.trim())}
          />
        </label>
        <label>
          Severity{" "}
          <select
            className="input"
            value={severity}
            disabled={!canWrite}
            data-testid="rule-severity"
            onChange={(e) =>
              setSeverity(e.target.value as "info" | "warning" | "critical")
            }
          >
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </label>
        <label>
          Watches{" "}
          <select
            className="input"
            value={fields.type}
            disabled={!canWrite}
            data-testid="condition-type"
            onChange={(e) =>
              setFields((old) => ({
                ...old,
                type: e.target.value as ConditionType,
              }))
            }
          >
            {CONDITION_TYPES.map((type) => (
              <option
                key={type}
                value={type}
              >
                {CONDITION_LABELS[type]}
              </option>
            ))}
          </select>
        </label>
        {fields.type === "threshold" || fields.type === "rate" ? (
          <>
            {metricFields}
            {field("Window (minutes)", "windowMinutes")}
            {field(fields.type === "rate" ? "Per minute" : "Total", "value")}
            {fields.type === "threshold" ? (
              <>
                {field("Each value of (optional)", "groupBy", "rule")}
                {field("Starting with (optional)", "prefix", "canary:")}
              </>
            ) : null}
          </>
        ) : null}
        {fields.type === "baseline" ? (
          <>
            {metricFields}
            {field("Out of metric", "totalMetric", "requests")}
            {field("Out of dimensions", "totalDims")}
            {field("Window (minutes)", "windowMinutes")}
            {field("Days of history", "baselineDays")}
            {field("Times its usual share", "factor")}
            {field("At least counted", "minimum")}
          </>
        ) : null}
        {fields.type === "sustained" ? (
          <>
            {metricFields}
            {field("Hours in a row (1–168)", "hours")}
            {field("Each value of (optional)", "groupBy", "crawler")}
          </>
        ) : null}
        {fields.type === "banStorm" ? (
          <>
            {field("Window (minutes)", "windowMinutes")}
            {field("Bans", "value")}
            <label>
              Source{" "}
              <select
                className="input"
                value={fields.source}
                disabled={!canWrite}
                data-testid="condition-source"
                onChange={(e) =>
                  set("source", e.target.value as "" | "auto" | "manual")
                }
              >
                <option value="">Any</option>
                <option value="auto">Automatic</option>
                <option value="manual">Manual</option>
              </select>
            </label>
          </>
        ) : null}
        {fields.type === "agentSilent"
          ? field("Silent for (minutes)", "afterMinutes")
          : null}
        {fields.type === "agentWarning" ? (
          <>
            {field("Warning kinds (* for any)", "kinds")}
            {field(
              "Heartbeat at most (minutes, optional)",
              "maxAgeMinutes",
              "5",
            )}
          </>
        ) : null}
        <fieldset disabled={!canWrite}>
          <legend>Channels</legend>
          {(choices.data?.items ?? []).length === 0 ? (
            <p className="muted">
              No channel to send to (the alert is still raised and logged).
            </p>
          ) : (
            (choices.data?.items ?? []).map((channel) => (
              <label key={channel.id}>
                <input
                  type="checkbox"
                  checked={channels.includes(channel.id)}
                  data-testid={`rule-channel-${channel.id}`}
                  onChange={(e) =>
                    setChannels((old) =>
                      e.target.checked
                        ? [...old, channel.id]
                        : old.filter((item) => item !== channel.id),
                    )
                  }
                />{" "}
                {channel.name} ({channel.type})
              </label>
            ))
          )}
        </fieldset>
        <label>
          <input
            type="checkbox"
            checked={enabled}
            disabled={!canWrite}
            data-testid="rule-enabled"
            onChange={(e) => setEnabled(e.target.checked)}
          />{" "}
          On
        </label>
        {canWrite ? (
          <div className="filters-actions">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={busy}
              data-testid="rule-save"
            >
              {busy ? "Saving…" : rule === null ? "Make the rule" : "Save"}
            </Button>
            {rule === null ? null : (
              <Button
                size="sm"
                variant="danger"
                data-testid="rule-delete"
                onClick={() => setDeleting(true)}
              >
                Delete
              </Button>
            )}
          </div>
        ) : null}
        {error === null ? null : <p role="alert">{error}</p>}
      </form>
      {rule !== null && canWrite ? (
        <ConfirmDialog
          open={deleting}
          onClose={() => setDeleting(false)}
          isApiError={isApiError}
          variant="danger"
          title={`Delete the rule “${rule.title}”`}
          confirmLabel="Delete"
          pendingLabel="Deleting…"
          onConfirm={async () => {
            await dataOf(
              client.delete("/alerts/rules/:id", {
                params: { id: rule.id },
                query: { revision: rule.revision },
              }),
            );
            await queryClient.invalidateQueries({ queryKey: ["alerts"] });
            navigate(`/alerts/rules?${scopeQuery}`);
          }}
        >
          <p>Its open alert, if any, closes; nothing more is raised.</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
