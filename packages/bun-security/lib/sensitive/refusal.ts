/**
 * `SecurityRefusal` (plan §17): what `security.check()` throws for an
 * identifier or a password it refuses. Its message is generic on purpose:
 * the actor learns nothing of which rule matched (ConcaveHR's lesson,
 * layers.md L11.7), and `status` and `code` are what to answer with.
 */

/** A refusal `security.check()` throws; answer it as it says, never with which rule matched. */
export class SecurityRefusal extends Error {
  constructor(
    /** The generic message for the client. */
    message: string,
    /** The status to answer with (`400`). */
    readonly status: number,
    /** The problem code to answer with (`"invalid_identifier"`). */
    readonly code: string,
    /** The rule that refused it, for logs and `explain()`; never for the client. */
    readonly rule: string,
  ) {
    super(message);
    this.name = "SecurityRefusal";
  }
}
