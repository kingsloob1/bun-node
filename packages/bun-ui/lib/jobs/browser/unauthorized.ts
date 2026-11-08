/**
 * The `unauthorized` option's shared types, re-exported from
 * `@kingsleyweb/bun-api-docs-ui`, which owns the option (its `docsUi()` takes
 * the same one) and the code both packages run: validation and the shell's
 * `303` (`lib/unauthorized`), and the browser's redirect (`./embed/unauthorized`).
 * Types only, so `lib/shared` stays free of runtime imports.
 */
export type {
  UiUnauthorized,
  UiUnauthorizedStatus,
} from "@kingsleyweb/bun-api-docs-ui/lib/shared/unauthorized";
