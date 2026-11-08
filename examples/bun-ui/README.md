# `@kingsleyweb/bun-ui` examples

Runnable examples for [`@kingsleyweb/bun-ui`](../../packages/bun-ui), one
folder per UI, mirroring the package's subpaths:

| Folder | UI | Runner |
|---|---|---|
| [`jobs/`](./jobs/README.md) | `@kingsleyweb/bun-ui/jobs`: the bun-jobs management UI | `bun jobs/run-all.ts` |

The folders are one project: one `package.json`, one `tsconfig.json`
(checked by `bun scripts/typecheck.ts` from the repo root) and the root's
lint and format rules.

```bash
cd examples/bun-ui
bun jobs/run-all.ts        # every jobs example; prints ok / skip / FAIL
bun run lint && bun run format:check
```
