import { useCallback, useState } from "react";

/** What {@link useFieldProblems} returns. */
export interface FieldProblems<K extends string> {
  /** The current problem of each field that has one. */
  problems: Partial<Record<K, string>>;
  /** A field's `onProblem`: records or clears its problem. */
  report: (field: K, problem: string | undefined) => void;
  /** Whether any field has a problem: the form must not be sent. */
  blocked: boolean;
}

/**
 * Collects the problems fields report as they change (`DateTimeInput`'s
 * `onProblem`), for a form to show on each field and to disable its submit
 * button while any remains.
 */
export function useFieldProblems<K extends string>(): FieldProblems<K> {
  const [problems, setProblems] = useState<Partial<Record<K, string>>>({});
  const report = useCallback(
    (field: K, problem: string | undefined) =>
      setProblems((current) => {
        if (current[field] === problem) {
          return current;
        }
        const next = { ...current };
        if (problem === undefined) {
          delete next[field];
        } else {
          next[field] = problem;
        }
        return next;
      }),
    [],
  );
  return { problems, report, blocked: Object.keys(problems).length > 0 };
}
