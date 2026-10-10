# Spike: a minimal SWR core plus a React binding

```bash
cd docs/plans/evidence/typed-client && bun test swr-core
```

Throwaway evidence for the typed-client plan, not product code. It asks one
question: how much does an SWR-style data layer with the behaviours the plan
needs cost to write ourselves, with no runtime dependencies, and does it work
under React's `useSyncExternalStore` and `<Suspense>`?

## What it proves

`core.ts` (no imports) implements, and `core.test.ts` asserts with an injected
clock and manual timers (no real sleeps):

| Behaviour | How the test checks it |
|---|---|
| Stable key hashing | `{a,b}` and `{b,a}` hash the same at every depth; array order still matters |
| In-flight dedupe | two concurrent `fetchQuery` calls return the same promise and make one call |
| Negative control | with `dedupe: false`, the same two calls make two fetches |
| `dedupeMs` window | a call 1 ms inside the window is served from cache, one at the edge fetches |
| Snapshot identity | `getSnapshot()` returns the same object until a change, then a new one |
| Stale-while-revalidate | a subscriber to stale data sees it at once with `fetchStatus: "fetching"`, then the new data; fresh data (inside `staleTime`) does not refetch |
| Focus / online | an injected `focusSource.emit()` refetches stale *observed* entries only; `refetchOnFocus: false` opts out of focus but not reconnect |
| `refetchInterval` | polls while subscribed, stops on unsubscribe |
| Retries | `computeBackoff` is exponential, capped and jittered within ±jitter; a fetch failing twice is retried at exactly +100 ms and +200 ms, and exhausted retries end in `status: "error"` |
| Abort | `abortOnUnsubscribe` aborts the fetch's signal when the last subscriber leaves; the default does not |
| `setQueryData` | updater form, subscribers notified |
| `invalidate` | by key prefix: observed matches refetch, unobserved matches go stale (a later subscribe refetches despite `staleTime: Infinity`), non-matches untouched; by tags likewise |
| Mutations | an optimistic value shows at once and rolls back when the mutation rejects; success invalidates tags and the observed query refetches |
| Garbage collection | an unobserved entry is dropped exactly at `gcTime`; an observed one is kept until its last subscriber leaves plus `gcTime` |
| Dehydrate / hydrate | round-trips through `JSON.stringify`; a hydrated fresh entry does not refetch, tags and `updatedAt` survive |
| Conditional revalidation | the fetcher receives the previous ETag; `{ notModified: true }` keeps the data's identity and bumps `updatedAt` (an HTTP 304) |
| Structural sharing | `replaceEqualDeep` keeps unchanged subtrees; a refetch returning equal JSON keeps the snapshot's data identity |
| Infinite (minimal) | pages append through `getNextPageParam`, `hasNextPage` turns false, a refetch reloads every loaded page in order |

`react.test.tsx` renders with `react-dom/client` into happy-dom (registered in
that file only, `react-dom` imported dynamically after it) and asserts:
pending then success, with **at most 3 renders and none after settling** (no
`useSyncExternalStore` loop); two components with the same key make **one**
fetch; a `<Suspense>` boundary shows its fallback, then the data, with one
fetch; an optimistic `useMutation` shows the new value, then rolls back on error.

Each core guard was mutation-checked: removing in-flight dedupe, structural
sharing, `abortOnUnsubscribe`, the rollback, the invalidated flag or the
staleness check on focus each fails exactly one test.

### One finding worth carrying into the plan

The first Suspense run fetched **twice**: the thrown promise resolves, React
re-renders, *then* `useSyncExternalStore` subscribes — and with the default
`staleTime: 0` that subscribe sees just-fetched data as stale and revalidates.
TanStack Query has the same hazard and forces a 1 s minimum `staleTime` for
suspense queries; `react.ts` now does the same (`Math.max(staleTime, 1000)`).
Any binding that suspends has to make the same choice.

## Size

| File | Lines |
|---|---|
| `core.ts` | 465 |
| `react.ts` | 74 |
| `core.test.ts` | 402 |
| `react.test.tsx` | 124 |

Minified for the browser, the core is 7,425 B (2,982 B gzip) and core + React
binding 7,759 B (3,206 B gzip), against 39,600 B (11,571 B gzip) for
`@tanstack/react-query` — see `../bundle-size/`.

## What it deliberately leaves out, against `@tanstack/query-core`

Being honest about the gap, since a size comparison is meaningless without it:

- **No observer reconciliation.** `setOptions` swaps the fetcher and options a
  store fetches with, but changing `refetchInterval`, `staleTime` or `enabled`
  on a mounted store does not reschedule timers or re-evaluate staleness.
  TanStack's `QueryObserver.setOptions` diffs and reacts.
- **No `enabled`, `select` (or its memo), `placeholderData`, `initialData`,
  `keepPreviousData`**, no `notifyOnChangeProps` / tracked-props render
  optimisation (every state change re-renders every subscriber of the key).
- **No offline/paused state.** Retries do not pause while offline, and
  `networkMode` does not exist; `online` only triggers revalidation.
- **Mutations are fire-and-run**: no mutation cache, no scoping/serialisation
  of mutations, no `useMutationState`, no retries for mutations.
- **Cancellation is coarse.** `snapshot()` cancels the key's in-flight fetch;
  there is no `cancelQueries` by filter, and `invalidate` cancels-then-refetches
  rather than offering `cancelRefetch: false`.
- **Infinite queries are minimal**: forward only (no `getPreviousPageParam`,
  `maxPages`), not wired into React (`useInfiniteQuery` absent), and a refetch
  of N pages is sequential with no per-page structural sharing.
- **No `useQueries`, prefetch helpers, `ensureQueryData`, query defaults by key,
  devtools, persisters, or a cache-level event stream.**
- **No SSR streaming / `HydrationBoundary`** — `dehydrate`/`hydrate` are the
  primitives only, and `hydrate` keeps whichever side is newer by `updatedAt`.
- **Errors are not reset** by an error boundary (`QueryErrorResetBoundary`).
- **Dehydrated data must already be JSON-safe**; nothing serialises `Date`,
  `Map` or `bigint`.

## Captured output

`results.txt` (`bun test swr-core`, Bun 1.4.3, run with `CLAUDECODE`
unset so Bun prints the passing tests too — with it set, as in an agent
session, Bun prints only failures and the summary):

```
bun test v1.4.3-canary.1 (bbdc5a519)

swr-core/react.test.tsx:
(pass) useQuery > renders pending, then success, with a bounded render count [20.88ms]
(pass) useQuery > two components with the same key cause one fetch [4.21ms]
(pass) useQuery > suspense: the boundary shows its fallback, then the data [7.19ms]
(pass) useMutation > an optimistic mutation shows the new value, then rolls back on error [9.70ms]

swr-core/core.test.ts:
(pass) keys > stable stringify sorts object keys at every depth; array order still matters [0.09ms]
(pass) dedupe > two concurrent fetches share one promise and one call [0.33ms]
(pass) dedupe > negative control: with dedupe disabled, two calls make two fetches [0.14ms]
(pass) dedupe > dedupeMs: a settled fetch satisfies calls inside the window, not after it [0.43ms]
(pass) store > getSnapshot is identity-stable between changes and changes on update [0.15ms]
(pass) stale-while-revalidate > a subscriber to stale data sees it at once while a background refetch runs [0.20ms]
(pass) stale-while-revalidate > fresh data (inside staleTime) does not refetch on subscribe [0.17ms]
(pass) revalidation triggers > focus refetches stale observed entries only, and respects refetchOnFocus: false [0.48ms]
(pass) revalidation triggers > refetchInterval polls while subscribed and stops after [0.23ms]
(pass) retries > computeBackoff: exponential, capped, jittered within ±jitter [0.11ms]
(pass) retries > retries with backoff then succeeds; exhausted retries end in error [0.42ms]
(pass) abort > abortOnUnsubscribe aborts when the last subscriber leaves; the default does not [0.15ms]
(pass) cache writes > setQueryData with an updater notifies subscribers [0.13ms]
(pass) cache writes > invalidate by key prefix: observed matches refetch, unobserved matches go stale, others untouched [0.51ms]
(pass) cache writes > invalidate by tags [0.35ms]
(pass) mutations > optimistic update shows at once and rolls back on error [0.22ms]
(pass) mutations > success invalidates tags and the observed query refetches [0.21ms]
(pass) garbage collection > unobserved entries are dropped after gcTime; observed ones are kept [0.24ms]
(pass) dehydrate / hydrate > round-trips through JSON; fresh hydrated data does not refetch [0.36ms]
(pass) conditional revalidation > the fetcher sees the previous ETag; notModified keeps the data identity and bumps updatedAt [0.21ms]
(pass) structural sharing > replaceEqualDeep keeps unchanged subtrees [0.11ms]
(pass) structural sharing > a refetch returning equal JSON keeps the snapshot's data identity [0.13ms]
(pass) infinite > pages append via getNextPageParam; a refetch reloads every loaded page [0.50ms]

 27 pass
 0 fail
 82 expect() calls
Ran 27 tests across 2 files. [178.00ms]
```

Also clean under `bun test swr-core --randomize --seed=1|2|3`, and the four
files type-check strict (`tsc --ignoreConfig --noEmit --strict
--moduleResolution bundler --jsx react-jsx --lib dom,esnext --types bun
--skipLibCheck swr-core/*.ts swr-core/*.tsx`, TypeScript 7.0.2).
