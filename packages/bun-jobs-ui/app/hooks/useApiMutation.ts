import type {
  QueryKey,
  UseMutationOptions,
  UseMutationResult,
} from "@tanstack/react-query";
import type { ProblemIssueDto } from "../api/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { isApiError } from "../api/errors";
import { useToast } from "../components/toast";

/** Field errors of a failed form submit: issue path (target stripped) → first message. */
export type FieldErrors = Record<string, string>;

/**
 * Turns `VALIDATION` issues into a field → message map. The key is the
 * issue's path within its target, so `body.opts.delay` is `"opts.delay"`
 * and a root-level `body` issue (empty path) is `"body"`. The first issue
 * per key wins.
 */
export function issuesToFieldErrors(
  issues: readonly ProblemIssueDto[],
): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const key = issue.path === "" ? issue.target : issue.path;
    if (!(key in errors)) {
      errors[key] = issue.message;
    }
  }
  return errors;
}

/** Whether an error is a `VALIDATION` problem carrying issues (shown as field errors, not a toast). */
function isFieldValidation(error: unknown): boolean {
  return (
    isApiError(error) && error.code === "VALIDATION" && error.issues.length > 0
  );
}

/** Options of {@link useApiMutation}. */
export interface UseApiMutationOptions<
  TData,
  TVariables,
  TOnMutateResult = unknown,
> extends Omit<
  UseMutationOptions<TData, Error, TVariables, TOnMutateResult>,
  "mutationFn" | "onSuccess" | "onError"
> {
  /** The request, usually an `ApiClient` call; it rejects with an `ApiError`. */
  mutationFn: (variables: TVariables) => Promise<TData>;
  /** A success toast: a fixed message, or one built from the result (return `null` for none). No toast when omitted. */
  successMessage?:
    | string
    | ((data: TData, variables: TVariables) => string | null | undefined);
  /** Query keys to invalidate on success (prefix match, as TanStack does), or a function choosing them from the result. */
  invalidate?:
    | readonly QueryKey[]
    | ((data: TData, variables: TVariables) => readonly QueryKey[]);
  /** The error toast's headline, e.g. "Could not pause queue". Defaults to the problem's title. */
  errorTitle?: string;
  /** Toast failures (other than field validation). Defaults to `true`; turn off when the screen shows the error itself. */
  toastErrors?: boolean;
  /** Runs after a success, after invalidation has started. */
  onSuccess?: (data: TData, variables: TVariables) => unknown;
  /** Runs after a failure (including a validation failure). */
  onError?: (error: Error, variables: TVariables) => unknown;
}

/** What {@link useApiMutation} returns: TanStack's mutation, plus the field errors. */
export type UseApiMutationResult<
  TData,
  TVariables,
  TOnMutateResult = unknown,
> = UseMutationResult<TData, Error, TVariables, TOnMutateResult> & {
  /** From the last failure's `VALIDATION` issues (see {@link issuesToFieldErrors}); `{}` otherwise. Cleared by the next `mutate` or `reset`. */
  fieldErrors: FieldErrors;
};

/**
 * TanStack's `useMutation` with the app's conventions: on success it toasts
 * `successMessage` and invalidates `invalidate`; on failure it toasts the
 * problem's title and detail, except a `VALIDATION` problem with issues,
 * which becomes `fieldErrors` for the form to show beside its inputs.
 */
export function useApiMutation<
  TData,
  TVariables = void,
  TOnMutateResult = unknown,
>({
  mutationFn,
  successMessage,
  invalidate,
  errorTitle,
  toastErrors = true,
  onSuccess,
  onError,
  ...options
}: UseApiMutationOptions<
  TData,
  TVariables,
  TOnMutateResult
>): UseApiMutationResult<TData, TVariables, TOnMutateResult> {
  const queryClient = useQueryClient();
  const toast = useToast();
  const mutation = useMutation<TData, Error, TVariables, TOnMutateResult>({
    ...options,
    mutationFn,
    onSuccess: async (data, variables) => {
      const keys =
        typeof invalidate === "function"
          ? invalidate(data, variables)
          : (invalidate ?? []);
      const message =
        typeof successMessage === "function"
          ? successMessage(data, variables)
          : successMessage;
      if (message) {
        toast.success(message);
      }
      await onSuccess?.(data, variables);
      // Not awaited: the mutation settles now; the refetches follow.
      for (const queryKey of keys) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
    onError: async (error, variables) => {
      if (toastErrors && !isFieldValidation(error)) {
        if (isApiError(error)) {
          const title = errorTitle ?? error.title;
          const detail =
            error.detail && error.detail !== title ? error.detail : undefined;
          toast.error(title, {
            description: errorTitle && !detail ? error.title : detail,
          });
        } else {
          toast.error(errorTitle ?? "Something went wrong", {
            description: error.message || undefined,
          });
        }
      }
      await onError?.(error, variables);
    },
  });
  const { error } = mutation;
  const fieldErrors = useMemo(
    () =>
      isApiError(error) && isFieldValidation(error)
        ? issuesToFieldErrors(error.issues)
        : {},
    [error],
  );
  return { ...mutation, fieldErrors };
}
