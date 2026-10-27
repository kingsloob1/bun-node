/**
 * A small history router scoped under the mount's `basePath` — the package's
 * (`@kingsleyweb/bun-api-docs-ui/embed/routing`), re-exported so the app and
 * the embedded docs references share the ONE router context (two copies would
 * read two contexts, and the references' links would not navigate).
 *
 * The app's routes are flat and few, so this replaces a router library: it
 * tracks `location.pathname`/`search` relative to `basePath`, intercepts
 * plain left-clicks on its `Link`s, matches `:param` and trailing `*`
 * patterns, and keeps URL-addressable state in the query string. A path
 * outside `basePath` matches nothing and renders the 404.
 */
export * from "@kingsleyweb/bun-api-docs-ui/embed/routing";
