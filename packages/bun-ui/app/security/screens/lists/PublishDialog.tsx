/**
 * Publishing the scope's draft (ui.md §3): `POST /policies/:scope/publish`
 * at the head read (`expectedHead`; another publish since is a `409`),
 * through step-up (a `401 step_up_required` opens the host's popup and
 * retries once). A dangerous change without two-person approvals is
 * refused `428 confirmation_required` until the operator types the scope's
 * name, which the dialog then asks for; under approvals the answer is a
 * `202` with the approval opened, which the screen shows. The impact
 * estimate (`POST /policies/:scope/impact`) is offered first to an
 * operator with `rules:test`. With `rollbackTo`, the same dialog rolls the
 * scope back to an earlier version instead (`POST /policies/:scope/rollback`,
 * a new publish of that version's content, under the same rules). A screen
 * can add a `notice` above the message (the crawler conflicts the agents
 * report).
 */
import type { Routes } from "../../api/routes.gen";
import { useMutation } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useState } from "react";
import { Button } from "../../../kit/components/Button";
import { ConfirmDialog } from "../../../kit/components/ConfirmDialog";
import { Field } from "../../../kit/components/Field";
import { TextInput } from "../../../kit/components/inputs";
import { ProblemBanner } from "../../../kit/components/ProblemBanner";
import { dataOf } from "../../api/client";
import { isApiError } from "../../api/errors";
import { useSecurityClient } from "../../context";
import { scopeLabel } from "../../scope/scope";
import { withStepUp } from "../../stepUp";
import { isConflict } from "./policy";

/** A publish's `202`: the approval opened. */
export type ApprovalDto =
  Routes["POST /policies/:scope/publish"]["responses"][202];

/** What a publish did. */
export type PublishOutcome =
  | { readonly kind: "published"; readonly number: number }
  | { readonly kind: "approval"; readonly approval: ApprovalDto };

/** The impact estimate's answer. */
type ImpactDto = Routes["POST /policies/:scope/impact"]["responses"][200];

/** Props of {@link PublishDialog}. */
export interface PublishDialogProps {
  /** Whether it is showing. */
  open: boolean;
  /** Closes it. */
  onClose: () => void;
  /** The scope. */
  scope: string;
  /** The head read (`null` before the first publish). */
  expectedHead: string | null;
  /** What the draft changes, in a sentence. */
  summary: string;
  /** Whether the operator may run the impact estimate (`rules:test`). */
  canEstimate: boolean;
  /** Called with what the publish did. */
  onPublished: (outcome: PublishOutcome) => void;
  /** Called when another publish (or draft save) went first: a `409`. */
  onConflict: () => void;
  /** Shown above the message: what the screen wants read before publishing. */
  notice?: ReactNode;
  /** Roll back to this version instead of publishing the draft. */
  rollbackTo?: { readonly id: string; readonly number: number };
}

/** See the module's description. */
export function PublishDialog(props: PublishDialogProps) {
  return props.open ? <OpenPublishDialog {...props} /> : null;
}

/** The impact estimate in a few lines. */
function ImpactSummary({ impact }: { impact: ImpactDto }) {
  const changed = impact.transitions.filter((item) => item.from !== item.to);
  return (
    <div
      className="lists-impact"
      data-testid="lists-impact"
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

/** The mounted dialog: its state lasts one opening. */
function OpenPublishDialog({
  onClose,
  scope,
  expectedHead,
  summary,
  canEstimate,
  onPublished,
  onConflict,
  notice,
  rollbackTo,
}: PublishDialogProps) {
  const { client } = useSecurityClient();
  const [message, setMessage] = useState("");
  const [typedConfirm, setTypedConfirm] = useState(false);
  const [dangerous, setDangerous] = useState<readonly string[]>([]);
  const impact = useMutation({
    mutationFn: () =>
      dataOf(
        client.post("/policies/:scope/impact", { params: { scope }, body: {} }),
      ),
  });
  const publish = async () => {
    const body = {
      expectedHead,
      ...(message.trim() === "" ? {} : { message: message.trim() }),
      ...(typedConfirm ? { confirm: scope } : {}),
    };
    try {
      const result = await withStepUp(() =>
        rollbackTo === undefined
          ? client.post("/policies/:scope/publish", { params: { scope }, body })
          : client.post("/policies/:scope/rollback", {
              params: { scope },
              body: { ...body, versionId: rollbackTo.id },
            }),
      );
      if (!result.ok) throw new Error(`HTTP ${result.status}`);
      onPublished(
        result.status === 202
          ? { kind: "approval", approval: result.data }
          : { kind: "published", number: result.data.version.number },
      );
    } catch (error) {
      // A dangerous change: ask for the scope's name, then publish again.
      if (isApiError(error) && error.code === "confirmation_required") {
        setTypedConfirm(true);
        const why = error.context.dangerous;
        setDangerous(Array.isArray(why) ? (why as string[]) : []);
      } else if (isConflict(error)) {
        onConflict();
        return;
      }
      throw error;
    }
  };
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={
        rollbackTo === undefined
          ? `Publish the draft of ${scopeLabel(scope)}?`
          : `Roll ${scopeLabel(scope)} back to version ${rollbackTo.number}?`
      }
      description={`${summary} Every service under ${scopeLabel(scope)} gets it.`}
      confirmLabel={rollbackTo === undefined ? "Publish" : "Roll back"}
      pendingLabel={rollbackTo === undefined ? "Publishing…" : "Rolling back…"}
      onConfirm={publish}
      isApiError={isApiError}
      {...(typedConfirm
        ? {
            confirmText: scope,
            confirmTextLabel: (
              <>
                This change is dangerous: type <code>{scope}</code> to publish
                it
                {dangerous.length === 0 ? null : (
                  <ul data-testid="lists-dangerous">
                    {dangerous.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
              </>
            ),
          }
        : {})}
    >
      {notice}
      <Field
        label="Message"
        hint="Optional: why, for the version history."
      >
        <TextInput
          value={message}
          onChange={setMessage}
          maxLength={1000}
        />
      </Field>
      {canEstimate && rollbackTo === undefined ? (
        <div className="lists-impact-block">
          <Button
            size="sm"
            onClick={() => impact.mutate()}
            disabled={impact.isPending}
          >
            {impact.isPending ? "Estimating…" : "Estimate impact"}
          </Button>
          {impact.data === undefined ? null : (
            <ImpactSummary impact={impact.data} />
          )}
          {impact.error === null ? null : (
            <ProblemBanner
              error={impact.error}
              title="Could not estimate the impact"
              isApiError={isApiError}
            />
          )}
        </div>
      ) : null}
    </ConfirmDialog>
  );
}
