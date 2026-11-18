/**
 * The events filters (ui.md §7): a form whose values go into the URL when
 * applied, back on the first page, so back/forward and a shared link land
 * on the same list. Typing changes nothing until "Apply" (a list read per
 * keystroke would page an operator through half-typed filters). The
 * account-key filters are offered only to an operator who may read
 * accounts (`events:read`): filtering by an account is reading it.
 */
import type { FormEvent } from "react";
import type { EventFilters, FilterField } from "./eventFilters";
import { useState } from "react";
import { Button } from "../../../kit/components/Button";
import { Field } from "../../../kit/components/Field";
import {
  DateTimeInput,
  NumberInput,
  Select,
  TextInput,
} from "../../../kit/components/inputs";
import { Link } from "../../router";
import { EVENT_ACTIONS } from "./eventFilters";

/** Props of {@link EventFiltersForm}. */
export interface EventFiltersFormProps {
  /** The filters in the URL (the form's starting values). */
  filters: EventFilters;
  /** The fields offered. */
  fields: readonly FilterField[];
  /** Whether the operator may filter by an account (`events:read`); without it those fields are absent. */
  canFilterAccounts: boolean;
  /** Applies the filters (the screen puts them in the URL). */
  onApply: (filters: EventFilters) => void;
  /** Where "Clear" goes (the screen without filters), or `undefined` when nothing is filtered. */
  clearTo: string | undefined;
}

/** The dry-run choice's values. */
type DryRunChoice = "" | "true" | "false";

/** A text field's value, trimmed. */
const trim = (value: string) => value.trim();

/** See the module's description. */
export function EventFiltersForm({
  filters,
  fields,
  canFilterAccounts,
  onApply,
  clearTo,
}: EventFiltersFormProps) {
  const [draft, setDraft] = useState<EventFilters>(filters);
  const [timeProblems, setTimeProblems] = useState<{
    from?: string;
    to?: string;
  }>({});
  const offered = new Set(fields);
  const set = <K extends keyof EventFilters>(name: K, value: EventFilters[K]) =>
    setDraft((current) => ({ ...current, [name]: value }));
  const rangeWrong =
    draft.from !== undefined &&
    draft.to !== undefined &&
    draft.to <= draft.from;
  const blocked =
    timeProblems.from !== undefined ||
    timeProblems.to !== undefined ||
    rangeWrong;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked) return;
    onApply({
      ...draft,
      action: trim(draft.action),
      rule: trim(draft.rule),
      route: trim(draft.route),
      ip: trim(draft.ip),
      country: trim(draft.country).toUpperCase(),
      // Without events:read the account filters are not the operator's to set.
      user: canFilterAccounts ? trim(draft.user) : filters.user,
      apiKey: canFilterAccounts ? trim(draft.apiKey) : filters.apiKey,
      username: canFilterAccounts ? trim(draft.username) : filters.username,
    });
  };
  const actionOptions = [
    { value: "", label: "Any" },
    ...EVENT_ACTIONS.map((action) => ({ value: action })),
    // A value the URL holds that this build does not know stays choosable.
    ...(draft.action === "" ||
    (EVENT_ACTIONS as readonly string[]).includes(draft.action)
      ? []
      : [{ value: draft.action }]),
  ];
  return (
    <form
      className="filters events-filters"
      aria-label="Filters"
      data-testid="events-filters"
      onSubmit={submit}
    >
      {offered.has("time") ? (
        <>
          <Field
            label="From"
            error={timeProblems.from}
          >
            <DateTimeInput
              value={draft.from}
              onChange={(value) => set("from", value)}
              onProblem={(problem) =>
                setTimeProblems((current) => ({ ...current, from: problem }))
              }
              data-testid="filter-from"
            />
          </Field>
          <Field
            label="To"
            error={
              timeProblems.to ??
              (rangeWrong ? "The end must be after the start" : undefined)
            }
          >
            <DateTimeInput
              value={draft.to}
              onChange={(value) => set("to", value)}
              onProblem={(problem) =>
                setTimeProblems((current) => ({ ...current, to: problem }))
              }
              data-testid="filter-to"
            />
          </Field>
        </>
      ) : null}
      {offered.has("action") ? (
        <Field label="Action">
          <Select
            placeholder="Choose an action"
            options={actionOptions}
            value={draft.action}
            onChange={(value) => set("action", value)}
            data-testid="filter-action"
          />
        </Field>
      ) : null}
      {offered.has("rule") ? (
        <Field label="Rule">
          <TextInput
            placeholder="e.g. rule:no-admin"
            value={draft.rule}
            onChange={(value) => set("rule", value)}
            data-testid="filter-rule"
          />
        </Field>
      ) : null}
      {offered.has("route") ? (
        <Field label="Route">
          <TextInput
            value={draft.route}
            onChange={(value) => set("route", value)}
            placeholder="POST /login"
            data-testid="filter-route"
          />
        </Field>
      ) : null}
      {offered.has("ip") ? (
        <Field label="Address">
          <TextInput
            placeholder="e.g. 203.0.113.7 or 198.51.100.0/24"
            value={draft.ip}
            onChange={(value) => set("ip", value)}
            data-testid="filter-ip"
          />
        </Field>
      ) : null}
      {offered.has("country") ? (
        <Field label="Country">
          <TextInput
            value={draft.country}
            onChange={(value) => set("country", value)}
            placeholder="NG"
            maxLength={2}
            data-testid="filter-country"
          />
        </Field>
      ) : null}
      {offered.has("asn") ? (
        <Field label="ASN">
          <NumberInput
            placeholder="e.g. 64500"
            value={draft.asn}
            onChange={(value) =>
              set(
                "asn",
                value === undefined || !Number.isInteger(value) || value < 0
                  ? undefined
                  : value,
              )
            }
            min={0}
            data-testid="filter-asn"
          />
        </Field>
      ) : null}
      {offered.has("dryRun") ? (
        <Field label="Dry run">
          <Select<DryRunChoice>
            placeholder="Choose dry run or enforced"
            options={[
              { value: "", label: "Both" },
              { value: "true", label: "Dry run only" },
              { value: "false", label: "Enforced only" },
            ]}
            value={
              draft.dryRun === undefined ? "" : draft.dryRun ? "true" : "false"
            }
            onChange={(value) =>
              set("dryRun", value === "" ? undefined : value === "true")
            }
            data-testid="filter-dryRun"
          />
        </Field>
      ) : null}
      {offered.has("accounts") && canFilterAccounts ? (
        <>
          <Field label="User key">
            <TextInput
              placeholder="e.g. 9f86d081884c7d659a2feaa0c55ad015"
              value={draft.user}
              onChange={(value) => set("user", value)}
              data-testid="filter-user"
            />
          </Field>
          <Field label="API key key">
            <TextInput
              placeholder="e.g. 9f86d081884c7d659a2feaa0c55ad015"
              value={draft.apiKey}
              onChange={(value) => set("apiKey", value)}
              data-testid="filter-apiKey"
            />
          </Field>
          <Field label="Username key">
            <TextInput
              placeholder="e.g. 9f86d081884c7d659a2feaa0c55ad015"
              value={draft.username}
              onChange={(value) => set("username", value)}
              data-testid="filter-username"
            />
          </Field>
        </>
      ) : null}
      <div className="filters-actions">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={blocked}
          data-testid="filters-apply"
        >
          Apply
        </Button>
        {clearTo === undefined ? null : (
          <Link
            to={clearTo}
            data-testid="filters-clear"
          >
            Clear filters
          </Link>
        )}
      </div>
    </form>
  );
}
