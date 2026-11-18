/**
 * A UI's sections as data (embedding.md §2): the one list a UI's own nav
 * reads and a host's side menu is built from (`JOBS_SECTIONS`,
 * `SECURITY_SECTIONS`, `DOCS_SECTIONS`, each from its `/<ui>/browser`
 * entry), and {@link sectionsFor}, the permission filter both apply.
 * Browser-safe: types and a pure function.
 */

/**
 * One section of a UI. `P` is the UI's permission names; a list is spelled
 * with `as const`, so each `needs` keeps its literals.
 */
export interface UiSection<P extends string = string> {
  /** Its stable id (`"queues"`, `"bans"`). */
  readonly id: string;
  /** Its label, as the UI's nav shows it. */
  readonly label: string;
  /** Its path under the UI's `basePath`: `"/"` for the first screen. */
  readonly path: string;
  /**
   * What it needs: a permission; a list of them, any one being enough (the
   * jobs UI's Overview: `metrics.read` or `queues.list`; the user's decision,
   * 2026-11-18); or `null`, nothing beyond what reaching the UI takes.
   */
  readonly needs: P | readonly P[] | null;
}

/** The permissions a section of `S` can name: what `sectionsFor`'s `can` is asked about. */
export type SectionPermission<S extends UiSection> =
  NonNullable<S["needs"]> extends infer N
    ? N extends readonly (infer P)[]
      ? P
      : N
    : never;

/**
 * The sections a caller may use, in their order: those needing nothing,
 * those whose permission `can` grants, and those needing a list of which
 * `can` grants one. The UI's own nav filters with this and may then drop a
 * section the API does not serve (the jobs UI's mode and features); a host
 * that filters with it sees no section the caller lacks the permission for.
 */
export function sectionsFor<S extends UiSection>(
  sections: readonly S[],
  can: (permission: SectionPermission<S>) => boolean,
): S[] {
  return sections.filter((section) => {
    const needs: UiSection["needs"] = section.needs;
    if (needs === null) return true;
    const any: readonly string[] = typeof needs === "string" ? [needs] : needs;
    // Each is one of S's own permissions: `needs` is typed by S.
    return any.some((permission) => can(permission as SectionPermission<S>));
  });
}
