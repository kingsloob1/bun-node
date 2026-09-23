# Plan evidence

The measurements, probes and source surveys the three plan documents in
`docs/plans/` rest on. They are kept because a plan that says "measured" is
only worth as much as the ability to re-run the measurement — and because
several conclusions here were **reversed** once someone re-read the source,
which is the strongest argument for keeping the workings rather than the
summary.

Nothing here is part of any published package. No `tsconfig.json` in this tree
is in `scripts/typecheck.ts`'s `PROJECTS` list, and no directory is in the root
`workspaces`, so none of it is built, typechecked or linted by the repo's own
tooling. That is deliberate: the spikes contain **intentional type errors**.

| Directory | Backs | What it is |
|---|---|---|
| `opentelemetry/` | `../opentelemetry.md` | A standalone Bun project measuring OTel span cost and Bun's `AsyncLocalStorage` behaviour |
| `api-docs/` | `../api-docs-generation.md` | TypeScript spikes for response contracts, decorators and inference |
| `worker-runtimes/` | `../worker-runtimes.md` | A 14-system prior-art survey read from pinned primary sources |

## Provenance, and why it is marked

Every factual row in the survey, and every number in the OTel plan, is tagged
as **measured here**, **read from a primary source at a pinned version**, or
**unverified**. Treat that marking as load-bearing. Three claims in the
worker-runtimes plan were withdrawn or re-attributed after a second reading,
and in each case the failure was the same shape: a plausible inference from a
secondary source that nobody had checked against the code it described.

A conclusion in these files is as old as the file. Re-run before relying.
