/**
 * A request rule made or changed (`/rules/new`, `/rules/edit/:id`): the
 * editor over the scope's own rule, saved into the scope's draft at the
 * revision read (U3's draft pieces, through step-up); a draft changed
 * meanwhile is said so and read again. A rule inherited from above is not
 * this scope's to change here.
 */
import { Spinner } from "../../../kit/components/Spinner";
import { useToast } from "../../../kit/components/toast";
import { isApiError } from "../../api/errors";
import { ErrorView } from "../../components/ErrorView";
import { useCan } from "../../meta/hooks";
import { Link } from "../../router";
import { useNavigate, useParams } from "../../routing";
import { scopeLabel } from "../../scope/scope";
import { isConflict, useSaveDraft } from "../lists/policy";
import { putRule } from "./ruleModel";
import { RuleEditorForm } from "./RuleEditor";
import { useRulesPolicy } from "./rulesPolicy";

/** Props of {@link RuleEdit}. */
export interface RuleEditProps {
  /** The scope on screen. */
  scope: string;
}

/** See the module's description. */
export function RuleEdit({ scope }: RuleEditProps) {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const canDraft = useCan("policy:draft");
  const data = useRulesPolicy(scope, false);
  const save = useSaveDraft(scope);
  const scopeQuery = `scope=${encodeURIComponent(scope)}`;
  const back = (
    <p>
      <Link to={`/rules?${scopeQuery}`}>Request rules</Link>
    </p>
  );
  if (data.pending) return <Spinner label="Loading the rule" />;
  if (data.error !== null && data.error !== undefined) {
    return (
      <div className="screen">
        {back}
        <ErrorView
          headingLevel={1}
          error={data.error}
          title="The rules could not be read"
        />
      </div>
    );
  }
  const previous =
    id === undefined ? null : (data.own.find((rule) => rule.id === id) ?? null);
  if (id !== undefined && previous === null) {
    const inherited = data.inherited.find((item) => item.rule.id === id);
    return (
      <div className="screen">
        {back}
        <p role="alert">
          {inherited === undefined
            ? `${scopeLabel(scope)} has no rule “${id}”.`
            : `“${id}” comes from ${scopeLabel(inherited.origin)}: change it there.`}
        </p>
      </div>
    );
  }
  const draft = data.policy?.draft ?? null;
  return (
    <div
      className="screen"
      data-testid="rule-edit"
    >
      {back}
      <h1>
        {previous === null
          ? "New request rule"
          : `Rule “${String(previous.id)}”`}
        : {scopeLabel(scope)}
      </h1>
      <RuleEditorForm
        rule={previous}
        canLock={!scope.startsWith("service:")}
        disabled={!canDraft}
        onCancel={() => navigate(`/rules?${scopeQuery}`)}
        onSave={async (rule) => {
          const next = putRule(
            data.base,
            previous === null ? null : String(previous.id),
            rule,
          );
          if (!next.ok) throw new Error(next.error);
          try {
            await save(next.policy, draft?.revision ?? null);
          } catch (error) {
            if (isConflict(error)) {
              await data.reload();
              throw new Error(
                "The draft changed meanwhile: it was read again. Save once more to apply your rule over it.",
              );
            }
            throw new Error(
              isApiError(error)
                ? (error.detail ?? error.title)
                : "The draft was not saved.",
            );
          }
          toast.success(`Rule “${String(rule.id)}” saved in the draft`);
          navigate(`/rules?${scopeQuery}`);
        }}
      />
    </div>
  );
}
