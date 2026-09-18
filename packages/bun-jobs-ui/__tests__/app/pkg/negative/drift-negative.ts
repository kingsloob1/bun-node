/**
 * Negative control for `../drift.ts`: each assertion here is WRONG and must
 * fail to compile. `typecheck.test.ts` asserts it yields exactly one error per
 * line marked `@expect-error-line`, proving the drift check can fail.
 */
import type * as Pkg from "@kingsleyweb/bun-jobs";
import type * as Ui from "../../../../app/api/types";
import type { Equal } from "../drift";
import { assertType } from "../drift";

// A field missing from one side.
assertType<Equal<Ui.MetaDto, Omit<Pkg.MetaDto, "publishing">>>(); // @expect-error-line
// An optional field only on one side (mutual assignability would miss this).
assertType<Equal<Ui.QueueSummaryDto, Pkg.QueueSummaryDto & { extra?: 1 }>>(); // @expect-error-line
// A nested field's type changed.
// (The error is reported on the type argument's line, so the marker sits there.)
assertType<
  Equal<Ui.WorkerDto, Omit<Pkg.WorkerDto, "pid"> & { pid?: string }> // @expect-error-line
>();
