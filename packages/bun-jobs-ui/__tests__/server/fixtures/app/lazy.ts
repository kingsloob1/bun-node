/**
 * A lazily imported module, so the fixture build has a split chunk, with a
 * stylesheet of its own (the app's screens import theirs the same way).
 */
import "./lazy.css";

export function markLazy(): void {
  (globalThis as { bunJobsUiFixtureLazy?: boolean }).bunJobsUiFixtureLazy =
    true;
}
