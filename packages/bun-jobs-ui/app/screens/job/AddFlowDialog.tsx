import type { FormEvent } from "react";
import type { AddFlowResultDto } from "../../api/types";
import type {
  FlowField,
  FlowLimits,
  FlowNode,
  FlowNodePatch,
} from "./addFlowForm";
import type { AddJobField, AddJobForm } from "./addJobForm";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { isApiError } from "../../api/errors";
import { addFlow, flowInvalidation, jobScreenPath } from "../../api/jobs";
import { queryKeys } from "../../api/queryKeys";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { EmptyState } from "../../components/EmptyState";
import { Field } from "../../components/Field";
import { Checkbox, Select, TextInput } from "../../components/inputs";
import { ProblemBanner } from "../../components/ProblemBanner";
import { useApiClient } from "../../context";
import { useApiMutation } from "../../hooks/useApiMutation";
import { useFieldProblems } from "../../hooks/useFieldProblems";
import { canPerform, useCan, useMeta } from "../../meta/hooks";
import { Link } from "../../router";
import {
  addChildBlocked,
  addFlowChild,
  checkFlowQueue,
  findFlowNode,
  flowBody,
  flowNode,
  flowProblemErrors,
  flowQueues,
  hasFlowErrors,
  placeFlow,
  removeFlowNode,
  updateFlowNode,
  validateFlow,
} from "./addFlowForm";
import { emptyAddForm } from "./addJobForm";
import { friendlyJobError } from "./jobErrors";
import { JobDataField, JobNameField, JobOptionsFields } from "./JobFormFields";
import "./job.css";

/** Props of {@link AddFlowDialog}: the same contract as `AddJobDialogProps`. */
export interface AddFlowDialogProps {
  /** The queue the top job is added to (the screen's). */
  queue: string;
  /** Whether the dialog is open. */
  open: boolean;
  /** Called to close it: Cancel, Escape, or Done once the result is shown. */
  onClose: () => void;
}

/** A select value no queue can have (queue names are `[\w.-]+`): "type another queue". */
const OTHER_QUEUE = "\u0000other";

/** How long the queues typed into the flow settle before their permissions are asked, ms. */
const PERMISSION_CHECK_DELAY_MS = 250;

/** The option fields, which open the node's options when one has an error. */
const OPTION_FIELDS: readonly AddJobField[] = [
  "opts.jobId",
  "opts.priority",
  "opts.delay",
  "opts.runAt",
  "opts.attempts",
  "opts.backoff",
  "opts.timeout",
];

/** Where focus goes after the tree changes: a node's first field, or its Add child button. */
interface FocusRequest {
  /** The node. */
  key: string;
  /** `"first"` for its first field (a new node), `"add"` for its Add child button (after a child went). */
  target: "first" | "add";
}

/** What every node editor shares: the tree's operations, its errors and what it may offer. */
interface FlowEditor {
  /** The screen's queue, which the top job goes in. */
  topQueue: string;
  /** `MetaDto.addableNames`: `null` for any name. */
  addableNames: string[] | null;
  /** `limits.maxJobDataBytes`. */
  maxBytes: number;
  /** The queues the caller may list, for a child's queue select; `null` when it may not list them. */
  listedQueues: string[] | null;
  /** Queues whose own permissions refuse `jobs.add` (the pre-check; the API decides). */
  refusedQueues: ReadonlySet<string>;
  /** The error on a node's field, if any. */
  errorOf: (key: string, field: FlowField) => string | undefined;
  /** Why a node cannot take another child, or `null`. */
  blockedReason: (key: string) => string | null;
  /** Changes a node's own fields. */
  patch: (key: string, patch: FlowNodePatch) => void;
  /** Appends an empty child to a node. */
  addChild: (key: string) => void;
  /** Removes a node and everything below it. */
  remove: (key: string, parent: string) => void;
  /** Records or clears a node's run-time input problem. */
  reportRunAt: (key: string, problem: string | undefined) => void;
  /** A pending focus move, or `null`. */
  focus: FocusRequest | null;
  /** Called once a node has taken the focus it was asked to. */
  focused: () => void;
}

/** A node's label: "Top job", or "Child 1.2" for the second child of the first child. */
function nodeLabel(indices: readonly number[]): string {
  return indices.length === 0
    ? "Top job"
    : `Child ${indices.map((index) => index + 1).join(".")}`;
}

/**
 * Adds a flow (`POST /queues/:queue/flows`): a top job in the screen's queue
 * and the jobs it waits on, each in its parent's queue or one of its own.
 * Loaded on demand: the queue screen renders `AddFlowDialog` from `../lazy`.
 */
export function AddFlowDialog(props: AddFlowDialogProps) {
  return props.open ? <OpenAddFlowDialog {...props} /> : null;
}

/** The mounted dialog; its state lives exactly as long as one opening. */
function OpenAddFlowDialog({ queue, onClose }: AddFlowDialogProps) {
  const api = useApiClient();
  const meta = useMeta();
  const canListQueues = useCan("queues.list");
  const formId = useId();
  const maxBytes = meta.limits.maxJobDataBytes;
  const addableNames = meta.addableNames;
  const nothingAddable = addableNames !== null && addableNames.length === 0;
  const limits: FlowLimits = {
    maxNodes: meta.limits.maxFlowNodes,
    maxDepth: meta.limits.maxFlowDepth,
  };
  const newForm = (): AddJobForm => emptyAddForm({ addableNames, maxBytes });
  const [root, setRoot] = useState<FlowNode>(() => flowNode(newForm()));
  const [submitted, setSubmitted] = useState(false);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const times = useFieldProblems<string>();

  const add = useApiMutation({
    mutationFn: (sent: FlowNode) => addFlow(api, queue, flowBody(sent, queue)),
    invalidate: (_result: AddFlowResultDto, sent: FlowNode) =>
      flowInvalidation(flowQueues(sent, queue)),
    toastErrors: false,
  });

  const placed = placeFlow(root, queue);
  const count = placed.length;

  // The pre-check: each other queue the flow writes to, asked about once
  // its name has settled, through the same targeted map a queue screen uses.
  const otherQueues = [...new Set(placed.map((entry) => entry.queue))]
    .filter((name) => name !== queue && checkFlowQueue(name) === undefined)
    .sort()
    .join("\n");
  const [checkedQueues, setCheckedQueues] = useState("");
  useEffect(() => {
    const timer = setTimeout(
      setCheckedQueues,
      PERMISSION_CHECK_DELAY_MS,
      otherQueues,
    );
    return () => clearTimeout(timer);
  }, [otherQueues]);
  const toCheck = checkedQueues === "" ? [] : checkedQueues.split("\n");
  const permissions = useQueries({
    queries: toCheck.map((name) => ({
      queryKey: queryKeys.permissions({ queue: name }),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.getPermissions({ queue: name }, signal),
      retry: false,
    })),
  });
  const refusedQueues = new Set(
    toCheck.filter((_name, index) => {
      const answer = permissions[index]?.data;
      return answer !== undefined && !canPerform(answer, "jobs.add");
    }),
  );

  const listing = useQuery({
    queryKey: queryKeys.queues(""),
    queryFn: ({ signal }) => api.listQueues("", signal),
    enabled: canListQueues,
  });
  const listedQueues =
    canListQueues && !listing.isError
      ? (listing.data?.items.map((item) => item.name) ?? [])
      : null;

  const clientErrors = submitted ? validateFlow(root, queue, limits) : {};
  const apiError = isApiError(add.error) ? add.error : null;
  const sent = add.variables;
  const server = useMemo(
    () => (apiError && sent ? flowProblemErrors(apiError, sent, queue) : null),
    [apiError, sent, queue],
  );
  const bannerError =
    add.error && (server === null || server.unplaced)
      ? friendlyJobError(add.error, "add")
      : null;
  const liveKeys = new Set(placed.map((entry) => entry.node.key));
  const timesBlocked = Object.keys(times.problems).some((key) =>
    liveKeys.has(key),
  );

  const editor: FlowEditor = {
    topQueue: queue,
    addableNames,
    maxBytes,
    listedQueues,
    refusedQueues,
    errorOf: (key, field) =>
      (field === "opts.runAt" ? times.problems[key] : undefined) ??
      clientErrors[key]?.[field] ??
      server?.errors[key]?.[field],
    blockedReason: (key) => addChildBlocked(root, key, limits),
    patch: (key, patch) =>
      setRoot((current) => updateFlowNode(current, key, patch)),
    addChild: (key) => {
      if (addChildBlocked(root, key, limits) !== null) {
        return;
      }
      const child = flowNode(newForm());
      setRoot((current) => addFlowChild(current, key, child));
      setFocus({ key: child.key, target: "first" });
    },
    remove: (key, parent) => {
      const gone = findFlowNode(root, key);
      if (gone) {
        for (const entry of placeFlow(gone, "")) {
          times.report(entry.node.key, undefined);
        }
      }
      setRoot((current) => removeFlowNode(current, key));
      setFocus({ key: parent, target: "add" });
    },
    reportRunAt: times.report,
    focus,
    focused: () => setFocus(null),
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    if (
      nothingAddable ||
      timesBlocked ||
      hasFlowErrors(validateFlow(root, queue, limits))
    ) {
      return;
    }
    add.mutate(root);
  };

  const close = () => {
    if (!add.isPending) {
      onClose();
    }
  };

  const result = add.isSuccess ? add.data : undefined;

  return (
    <Dialog
      open
      onClose={close}
      title={
        <>
          Add a flow to <code>{queue}</code>
        </>
      }
      description="A flow is a job and the jobs it waits on: they are added first, and it runs once they have all completed."
      size="lg"
      closeOnEscape={!add.isPending}
      closeOnBackdrop={!add.isPending}
      footer={
        result ? (
          <Button
            variant="primary"
            onClick={close}
          >
            Done
          </Button>
        ) : (
          <>
            <Button
              onClick={close}
              disabled={add.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              form={formId}
              disabled={add.isPending || nothingAddable || timesBlocked}
              aria-busy={add.isPending || undefined}
            >
              {add.isPending ? "Adding…" : "Add flow"}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <FlowResult
          queue={queue}
          result={result}
        />
      ) : nothingAddable ? (
        <EmptyState
          title="No flow can be added here"
          description="This API accepts no job names: adding jobs is switched off (the jobs.add action is not enabled, or the API is read-only), or no name is allowed. Ask whoever runs it to list the names in addableNames."
        />
      ) : (
        <form
          id={formId}
          className="job-form flow-form"
          onSubmit={onSubmit}
          noValidate
        >
          <p
            className="flow-count"
            data-testid="flow-count"
            aria-live="polite"
          >
            {count} of {limits.maxNodes} jobs
            {count >= limits.maxNodes
              ? ": the most one flow may hold."
              : `, nested at most ${limits.maxDepth} levels.`}
          </p>
          <ol
            className="flow-tree"
            aria-label="Flow"
          >
            <FlowNodeEditor
              node={root}
              indices={[]}
              level={1}
              parent={null}
              parentQueue={null}
              editor={editor}
            />
          </ol>
          {bannerError !== null && <ProblemBanner error={bannerError} />}
        </form>
      )}
    </Dialog>
  );
}

/** Props of {@link FlowNodeEditor}. */
interface FlowNodeEditorProps {
  /** The node. */
  node: FlowNode;
  /** Its position under the top job, `[]` for the top job itself (see {@link nodeLabel}). */
  indices: readonly number[];
  /** Its level, the top job being 1. */
  level: number;
  /** Its parent's key; `null` for the top job. */
  parent: string | null;
  /** The queue its parent goes in; `null` for the top job. */
  parentQueue: string | null;
  /** The shared operations and state. */
  editor: FlowEditor;
}

/** One job of the flow: its fields and actions, then the jobs it waits on. */
function FlowNodeEditor({
  node,
  indices,
  level,
  parent,
  parentQueue,
  editor,
}: FlowNodeEditorProps) {
  const { key } = node;
  const label = nodeLabel(indices);
  const isTop = parent === null;
  const queue = isTop
    ? editor.topQueue
    : node.queue === ""
      ? parentQueue!
      : node.queue;
  const fieldsetRef = useRef<HTMLFieldSetElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const reasonId = useId();
  const optionsId = useId();
  const [showOptions, setShowOptions] = useState(false);
  const errorOf = (field: FlowField) => editor.errorOf(key, field);
  const optionError = OPTION_FIELDS.some((field) => errorOf(field));
  const optionsShown = showOptions || optionError;
  const blocked = editor.blockedReason(key);
  const refused = editor.refusedQueues.has(queue);
  const nodeError =
    errorOf("node") ?? (isTop ? errorOf("opts.ignoreFailure") : undefined);
  const queueError =
    errorOf("queue") ??
    (refused
      ? `You may not add jobs to “${queue}”: the API will refuse this flow.`
      : undefined);

  const { focus, focused } = editor;
  useEffect(() => {
    if (focus?.key !== key) {
      return;
    }
    const target =
      focus.target === "add" && addRef.current && !addRef.current.disabled
        ? addRef.current
        : fieldsetRef.current?.querySelector<HTMLElement>(
            "input, select, textarea",
          );
    target?.focus();
    focused();
  }, [focus, key, focused]);

  const patchForm = (next: Partial<AddJobForm>) =>
    editor.patch(key, { form: { ...node.form, ...next } });

  return (
    <li className="flow-item">
      <fieldset
        ref={fieldsetRef}
        className="flow-node"
        data-refused={refused || undefined}
        data-testid="flow-node"
      >
        <legend>{label}</legend>
        {nodeError && (
          <p
            className="field-error job-form-error"
            role="alert"
          >
            {nodeError}
          </p>
        )}
        <JobNameField
          value={node.form.name}
          onChange={(name) => patchForm({ name })}
          error={errorOf("name")}
          addableNames={editor.addableNames}
        />
        <JobDataField
          value={node.form.data.text}
          onChange={(data) => patchForm({ data })}
          error={errorOf("data")}
          maxBytes={editor.maxBytes}
          rows={4}
        />
        {isTop ? (
          <div className="flow-node-queue">
            <p className="field-label">
              Queue: <code>{queue}</code>
            </p>
            {queueError && <p className="field-error">{queueError}</p>}
          </div>
        ) : (
          <FlowQueueField
            value={node.queue}
            onChange={(next) => editor.patch(key, { queue: next })}
            parentQueue={parentQueue!}
            listed={editor.listedQueues}
            error={queueError}
          />
        )}
        {!isTop && (
          <div>
            <Checkbox
              checked={node.ignoreFailure}
              onChange={(ignoreFailure) => editor.patch(key, { ignoreFailure })}
              label="Parent carries on if this fails"
              hint="Its failure is recorded for the parent to read, instead of failing it."
            />
            {errorOf("opts.ignoreFailure") && (
              <p className="field-error">{errorOf("opts.ignoreFailure")}</p>
            )}
          </div>
        )}
        <div className="flow-node-actions">
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={optionsShown}
            aria-controls={optionsShown ? optionsId : undefined}
            onClick={() => setShowOptions(!optionsShown)}
          >
            Options
            <span className="visually-hidden"> of {label}</span>
          </Button>
          <Button
            ref={addRef}
            size="sm"
            onClick={() => editor.addChild(key)}
            disabled={blocked !== null}
            aria-describedby={blocked !== null ? reasonId : undefined}
          >
            Add child
            <span className="visually-hidden"> to {label}</span>
          </Button>
          {parent !== null && (
            <Button
              size="sm"
              variant="danger"
              onClick={() => editor.remove(key, parent)}
            >
              Remove
              <span className="visually-hidden"> {label}</span>
            </Button>
          )}
          {blocked !== null && (
            <p
              id={reasonId}
              className="field-hint flow-node-blocked"
            >
              {blocked}
            </p>
          )}
        </div>
        {optionsShown && (
          <div id={optionsId}>
            <JobOptionsFields
              form={node.form}
              patch={patchForm}
              fieldError={(field) => errorOf(field)}
              onRunAtProblem={(problem) => editor.reportRunAt(key, problem)}
            />
          </div>
        )}
      </fieldset>
      {node.children.length > 0 && (
        <ol
          className="flow-tree flow-children"
          aria-label={`Jobs ${label} waits on`}
        >
          {node.children.map((child, index) => (
            <FlowNodeEditor
              key={child.key}
              node={child}
              indices={[...indices, index]}
              level={level + 1}
              parent={key}
              parentQueue={queue}
              editor={editor}
            />
          ))}
        </ol>
      )}
    </li>
  );
}

/** Props of {@link FlowQueueField}. */
interface FlowQueueFieldProps {
  /** The child's own queue; `""` for its parent's. */
  value: string;
  /** Called with a new queue (`""` for its parent's). */
  onChange: (queue: string) => void;
  /** The queue its parent goes in, which `""` means. */
  parentQueue: string;
  /** The queues the caller may list; `null` when it may not, and the queue is typed. */
  listed: string[] | null;
  /** The error to show under it. */
  error: string | undefined;
}

/**
 * A child's queue: its parent's by default, one the caller can list, or any
 * other name typed in (a queue need not exist before a job is added to it).
 */
function FlowQueueField({
  value,
  onChange,
  parentQueue,
  listed,
  error,
}: FlowQueueFieldProps) {
  const [typing, setTyping] = useState(
    () => value !== "" && listed !== null && !listed.includes(value),
  );
  if (listed === null) {
    return (
      <Field
        label="Queue"
        hint={`Leave empty for its parent's, ${parentQueue}.`}
        error={error}
      >
        <TextInput
          value={value}
          onChange={onChange}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
    );
  }
  const freeText = typing || (value !== "" && !listed.includes(value));
  return (
    <>
      <Field
        label="Queue"
        error={freeText ? undefined : error}
      >
        <Select
          options={[
            { value: "", label: `Its parent's (${parentQueue})` },
            ...listed.map((name) => ({ value: name })),
            { value: OTHER_QUEUE, label: "Another queue…" },
          ]}
          value={freeText ? OTHER_QUEUE : value}
          onChange={(chosen) => {
            if (chosen === OTHER_QUEUE) {
              setTyping(true);
              onChange("");
            } else {
              setTyping(false);
              onChange(chosen);
            }
          }}
        />
      </Field>
      {freeText && (
        <Field
          label="Another queue"
          hint="A queue need not exist yet. Leave empty for its parent's."
          error={error}
        >
          <TextInput
            value={value}
            onChange={onChange}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      )}
    </>
  );
}

/** Props of {@link FlowResult}. */
interface FlowResultProps {
  /** The screen's queue, which the top job went in. */
  queue: string;
  /** What the API answered. */
  result: AddFlowResultDto;
}

/** Every job of a result in body order (each before its children). */
function resultJobs(result: AddFlowResultDto): AddFlowResultDto[] {
  return [result, ...result.children.flatMap(resultJobs)];
}

/** What the flow came to: every job added, linked to its screen, or the top job that already existed. */
function FlowResult({ queue, result }: FlowResultProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const top = result.job;
  const jobs = resultJobs(result).filter((entry) => entry.added);
  return (
    <div
      ref={ref}
      className="flow-result"
      tabIndex={-1}
      role="status"
      data-testid="flow-result"
    >
      {result.added ? (
        <>
          <p>
            Added {jobs.length} {jobs.length === 1 ? "job" : "jobs"}. The top
            job,{" "}
            <Link to={jobScreenPath(top.queue || queue, top.id)}>
              {top.name} ({top.id})
            </Link>
            , runs once the jobs it waits on have completed.
          </p>
          <ul className="flow-result-list">
            {jobs.map(({ job }) => (
              <li key={`${job.queue}:${job.id}`}>
                <Link to={jobScreenPath(job.queue, job.id)}>{job.name}</Link>{" "}
                <span className="muted">
                  in <code>{job.queue}</code>, id <code>{job.id}</code>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>
          The top job already existed, so nothing was added:{" "}
          <Link to={jobScreenPath(top.queue || queue, top.id)}>
            view {top.name} ({top.id})
          </Link>
          .
        </p>
      )}
    </div>
  );
}
