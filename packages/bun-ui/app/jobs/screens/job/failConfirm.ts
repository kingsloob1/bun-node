/** Longest job id typed in full to confirm; a longer one is confirmed by its tail. */
export const FAIL_CONFIRM_FULL_ID_MAX = 40;

/** Characters of a long id's tail typed to confirm. */
export const FAIL_CONFIRM_TAIL_LENGTH = 8;

/** What the fail dialog asks to be typed, and how it says so. */
export interface FailConfirmation {
  /** The exact text to type. */
  text: string;
  /** Whether `text` is the whole id (`false`: its last characters). */
  whole: boolean;
}

/**
 * The typed confirmation for failing job `id`: the id itself, as the other
 * danger dialogs ask for a queue's or runner's name, unless it is longer than
 * {@link FAIL_CONFIRM_FULL_ID_MAX} characters (ids run to 1024). Then it is
 * the id's last {@link FAIL_CONFIRM_TAIL_LENGTH} characters, counted in code
 * points so a surrogate pair is never split.
 */
export function failConfirmation(id: string): FailConfirmation {
  const chars = Array.from(id);
  if (chars.length <= FAIL_CONFIRM_FULL_ID_MAX) {
    return { text: id, whole: true };
  }
  return {
    text: chars.slice(-FAIL_CONFIRM_TAIL_LENGTH).join(""),
    whole: false,
  };
}
