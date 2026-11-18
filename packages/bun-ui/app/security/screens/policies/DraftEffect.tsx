/**
 * A draft's effect on each service under its scope (PR-U4F, ui.md §3):
 * `GET /policies/:scope/draft/effect` — each service's effective policy as
 * published against with the draft in its place, as their differences, for
 * the services the operator may read (at most 200; the rest counted). A
 * service the draft would not compile for says why; one it leaves
 * unchanged says so; the services skipped are named with the reason. It
 * shares the impact estimate's per-operator budget: a `429` shows as a
 * notice with **Try again**, not as an error, and is never retried by
 * itself (each try spends the budget).
 */
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../../kit/components/Button";
import { ProblemBanner } from "../../../kit/components/ProblemBanner";
import { Spinner } from "../../../kit/components/Spinner";
import { dataOf } from "../../api/client";
import { isApiError } from "../../api/errors";
import { useSecurityClient } from "../../context";
import { scopeLabel } from "../../scope/scope";
import { listsKeys } from "../lists/policy";

/** Props of {@link DraftEffect}. */
export interface DraftEffectProps {
  /** The draft's scope. */
  scope: string;
  /** The draft's revision (a new one reads again). */
  revision: number;
}

/** A value in a change, for people. */
function shown(value: unknown): string {
  return JSON.stringify(value);
}

/** See the module's description. */
export function DraftEffect({ scope, revision }: DraftEffectProps) {
  const { client } = useSecurityClient();
  const effect = useQuery({
    queryKey: [...listsKeys.all(scope), "draft-effect", revision],
    // Each try spends the operator's estimate budget: no retry by itself.
    retry: false,
    queryFn: ({ signal }) =>
      dataOf(
        client.get("/policies/:scope/draft/effect", {
          params: { scope },
          signal,
        }),
      ),
  });
  if (effect.isError && isApiError(effect.error) && effect.error.status === 429)
    return (
      <div
        className="notice"
        role="status"
        data-testid="draft-effect-limited"
      >
        <p>
          Too many estimates this minute (they share a budget with the impact
          estimate): try again in a minute.
        </p>
        <Button
          size="sm"
          data-testid="draft-effect-retry"
          onClick={() => void effect.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  if (effect.isError)
    return (
      <ProblemBanner
        error={effect.error}
        title="Could not compare the services' effective policies"
        isApiError={isApiError}
      />
    );
  if (effect.data === undefined)
    return <Spinner label="Comparing the services' effective policies" />;
  const { services, skipped, notCompared } = effect.data;
  const changed = services.filter(
    (s) => s.changes.length > 0 || s.error !== undefined,
  );
  return (
    <div
      className="policy-effect"
      data-testid="draft-effect"
    >
      <p data-testid="draft-effect-summary">
        {services.length.toLocaleString("en")} service(s) compared:{" "}
        {changed.length.toLocaleString("en")} change(s) or would break.
      </p>
      {changed.map((service) => (
        <details
          key={service.service}
          data-testid={`draft-effect-${service.service}`}
          open={changed.length <= 3}
        >
          <summary>
            {scopeLabel(`service:${service.service}`)}
            {service.error === undefined
              ? `: ${service.changes.length + service.more} change(s)`
              : ": the draft does not compile for it"}
          </summary>
          {service.error === undefined ? (
            <ul className="policy-changes">
              {service.changes.map((change) => (
                <li
                  key={change.path}
                  data-testid="draft-effect-change"
                >
                  <code>{change.path}</code>:{" "}
                  {change.before === undefined
                    ? `added ${shown(change.after)}`
                    : change.after === undefined
                      ? `removed (was ${shown(change.before)})`
                      : `${shown(change.before)} → ${shown(change.after)}`}
                </li>
              ))}
              {service.more > 0 ? (
                <li className="muted">
                  and {service.more.toLocaleString("en")} more
                </li>
              ) : null}
            </ul>
          ) : (
            <p
              className="field-error"
              data-testid="draft-effect-error"
            >
              {service.error}
            </p>
          )}
        </details>
      ))}
      {services.length > changed.length ? (
        <p className="muted">
          Unchanged:{" "}
          {services
            .filter((s) => !changed.includes(s))
            .map((s) => s.service)
            .join(", ")}
          .
        </p>
      ) : null}
      {skipped.length > 0 ? (
        <p
          className="muted"
          data-testid="draft-effect-skipped"
        >
          Not shown:{" "}
          {skipped.map((s) => `${s.service} (${s.reason})`).join(", ")}.
        </p>
      ) : null}
      {notCompared > 0 ? (
        <p
          className="muted"
          data-testid="draft-effect-not-compared"
        >
          {notCompared.toLocaleString("en")} more service(s) not compared (200
          at most).
        </p>
      ) : null}
    </div>
  );
}
