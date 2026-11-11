import type { FormEvent } from "react";
import type { RepeatableDto } from "../../../api/types";
import type { JsonEditorState } from "../../../../kit/components/jsonParse";
import { useId, useState } from "react";
import { isApiError } from "../../../api/errors";
import { mutationInvalidations, updateRepeatable } from "../../../api/queues";
import { Button } from "../../../../kit/components/Button";
import { Dialog } from "../../../../kit/components/Dialog";
import { Field } from "../../../../kit/components/Field";
import { JsonEditor } from "../../../../kit/components/JsonEditor";
import { jsonEditorState } from "../../../../kit/components/jsonParse";
import { ProblemBanner } from "../../../components/ProblemBanner";
import { useApiClient } from "../../../context";
import { useApiMutation } from "../../../hooks/useApiMutation";
import { useMeta } from "../../../meta/hooks";
import { explainSeriesError, repeatableDataProblem } from "./repeatableErrors";

/** Props of {@link EditRepeatableDataDialog}. */
export interface EditRepeatableDataDialogProps {
  /** The queue the series belongs to. */
  queue: string;
  /** The series being edited, or `null` while the dialog is closed. Its current data seeds the editor. */
  series: RepeatableDto | null;
  /** Called to close it: cancel, Escape, or after a successful save. */
  onClose: () => void;
}

/**
 * Replaces a repeat series' payload (`PATCH /queues/:queue/repeatables/:key`,
 * `repeatables.update`): every occurrence from now on, and the one already
 * scheduled while it is still waiting, run with the new data. The schedule,
 * name and options stay as they are.
 */
export function EditRepeatableDataDialog(props: EditRepeatableDataDialogProps) {
  return props.series === null ? null : (
    <OpenEditRepeatableDataDialog
      {...props}
      series={props.series}
    />
  );
}

/** The mounted dialog; its state lives exactly as long as one opening. */
function OpenEditRepeatableDataDialog({
  queue,
  series,
  onClose,
}: EditRepeatableDataDialogProps & { series: RepeatableDto }) {
  const api = useApiClient();
  const { limits } = useMeta();
  const formId = useId();
  const maxBytes = limits.maxJobDataBytes;
  const [data, setData] = useState<JsonEditorState>(() =>
    jsonEditorState(JSON.stringify(series.data ?? null, null, 2), {
      maxBytes,
    }),
  );
  const [submitted, setSubmitted] = useState(false);
  const save = useApiMutation({
    mutationFn: async (value: unknown) => {
      try {
        return await updateRepeatable(api, queue, series.key, { data: value });
      } catch (error) {
        throw explainSeriesError(error, series.key);
      }
    },
    successMessage: `Saved the data of the repeat series ${series.key}`,
    invalidate: mutationInvalidations(queue),
    toastErrors: false,
    onSuccess: () => onClose(),
  });

  const clientError = submitted ? repeatableDataProblem(data) : undefined;
  // The body is only `data`, so every body issue belongs beside the editor: a
  // schema's issues arrive at their paths inside it (`data.to`), each shown
  // with the part of the payload it is about.
  const serverMessages = Object.entries(save.fieldErrors).map(
    ([path, message]) =>
      path.startsWith("data.") ? `${path.slice(5)}: ${message}` : message,
  );
  const dataError =
    clientError ??
    (serverMessages.length > 0 ? serverMessages.join(" ") : undefined);
  // A problem that is not a per-field VALIDATION issue is shown as a banner,
  // as is one with an issue no field shows.
  const bannerError =
    save.error &&
    !(
      isApiError(save.error) &&
      serverMessages.length > 0 &&
      save.unplacedIssues.length === 0
    )
      ? save.error
      : null;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    if (repeatableDataProblem(data) !== undefined) {
      return;
    }
    save.mutate(data.value);
  };

  const close = () => {
    if (!save.isPending) {
      onClose();
    }
  };

  return (
    <Dialog
      open
      onClose={close}
      title={`Edit the data of ${series.key}`}
      description="Every occurrence from now on runs with this data, and so does the one already scheduled, unless a worker has started it. The schedule stays as it is."
      size="lg"
      closeOnEscape={!save.isPending}
      closeOnBackdrop={!save.isPending}
      footer={
        <>
          <Button
            onClick={close}
            disabled={save.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            disabled={save.isPending}
            aria-busy={save.isPending || undefined}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="repeatable-edit-form"
        onSubmit={onSubmit}
        noValidate
      >
        <Field
          label="Data"
          hint="JSON; null is allowed."
          error={dataError}
        >
          <JsonEditor
            value={data.text}
            onChange={setData}
            maxBytes={maxBytes}
            rows={8}
          />
        </Field>
        {bannerError && <ProblemBanner error={bannerError} />}
      </form>
    </Dialog>
  );
}
