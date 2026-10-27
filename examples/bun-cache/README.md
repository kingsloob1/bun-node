# `@kingsleyweb/bun-cache` examples

Runnable examples for
[`@kingsleyweb/bun-cache`](../../packages/bun-cache): caching over pluggable
drivers — TTLs, tags, single-flight `getOrSet`, staleness, counters, events
and stats, typed keys, and runtime-checked reads.

Each file is a script. Its opening comment says what it shows and how to run
it; its output narrates what happened, and the `✓` lines are assertions (a
failed one exits non-zero, so `run-all.ts` reports it).

```bash
cd examples/bun-cache
bun 01-core/basics.ts              # start here
bun run-all.ts                     # every example; prints ok / skip / FAIL
bun run-all.ts 01 03               # only folders 01-* and 03-*
```

No install step: the examples use the workspace package through the repo's
root `node_modules`; `03-typed` uses zod from the same place.

| Folder | What it shows |
|---|---|
| `01-core` | `basics.ts` — set/get/has/delete, `getEntry`, TTL expiry, tags, counters, namespaces, events, stats |
| `02-loading` | `getorset.ts` — the single-flight under a burst, `wrap`, stale-while-revalidate, stale-if-error, negative caching |
| `03-typed` | `validated.ts` — a typed schema, and `validate` (V10): a failing value is a miss with an `error` event |
| `04-drivers` | `file.ts` — the file driver: durability across instances, stamp-mode tags, the sweeper and its caps |
