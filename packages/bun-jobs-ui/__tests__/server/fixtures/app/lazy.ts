/** A lazily imported module, so the fixture build has a split chunk. */
export function markLazy(): void {
  (globalThis as { bunJobsUiFixtureLazy?: boolean }).bunJobsUiFixtureLazy =
    true;
}
