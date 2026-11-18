# `@kingsleyweb/bun-ui/security` examples

Runnable examples for the security UI of
[`@kingsleyweb/bun-ui`](../../../packages/bun-ui/guides/security.md): the
management UI and analytics page for
[`@kingsleyweb/bun-security`](../../../packages/bun-security)'s control plane.

Each file is a script that checks what it shows with
[`../jobs/shared/check.ts`](../jobs/shared/check.ts), so a wrong answer fails
it.

```bash
cd examples/bun-ui/security
bun 01-screens/permissions.ts   # what each element needs, checked
bun run-all.ts                  # every example; prints ok / FAIL
```

No install step: the packages resolve from the repo's root `node_modules`,
and the memory store keeps everything in the process.

| Example | What it shows |
|---|---|
| [`01-screens/permissions.ts`](./01-screens/permissions.ts) | The guide's table "What each element needs", parsed and checked: every row has a gate, every permission it names is one the API checks, the nav gates as it says, and each element that makes one call is refused by the API without its permission (and taken with it), with negative controls for each kind of drift |
