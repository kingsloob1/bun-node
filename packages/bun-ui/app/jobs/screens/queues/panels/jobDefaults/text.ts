/**
 * Sentences the job-defaults panel and its dialogs share, and the tests
 * assert: said once, so the panel, the editor and the apply dialog cannot
 * disagree.
 */

/** What the "code" values are (`JobDefaultsDto.codeSource` `"api"`). */
export const CODE_SOURCE_HINT =
  "“Code” is what this API's own service is configured with. A producer in another service may be configured differently; a stored value replaces them all alike.";

/** Beside Reset: what a reset cannot undo. */
export const RESET_CANNOT_RESTORE =
  "Resetting changes jobs added from now on. It cannot restore jobs already rewritten by Apply to pending jobs: they keep the values written to them.";

/** Whether the apply action is reversible. */
export const APPLY_IRREVERSIBLE =
  "This rewrites the jobs in place and cannot be undone: their previous values are not kept, so a later reset does not restore them.";

/** What `includeUnmarked` means, under its checkbox. */
export const INCLUDE_UNMARKED_HINT =
  "Jobs added before this version of bun-jobs did not record which options their add() passed explicitly. Left unticked, they are skipped and counted. Ticked, every option of theirs is treated as a default, so a value their add() did pass may be replaced.";

/** What lowering `attempts` does to a job that has used them up. */
export const EXHAUSTED_WARNING =
  "Attempts is being lowered. A job that has already made at least the new number of attempts is not dropped: it gets ONE final attempt, and dies if that fails.";
