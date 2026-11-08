/**
 * The `unauthorized` option's shared types, re-exported from the kit
 * (`lib/kit/browser/unauthorized.ts`), which `docsUi()` uses too, as it does
 * the code both run: validation and the shell's `303` (`lib/kit/unauthorized`),
 * and the browser's redirect (`app/kit/unauthorized`). Types only, so
 * `lib/jobs/browser` stays free of runtime imports.
 */
export type {
  UiUnauthorized,
  UiUnauthorizedStatus,
} from "../../kit/browser/unauthorized";
