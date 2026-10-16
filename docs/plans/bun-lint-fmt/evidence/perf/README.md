# Timings: ESLint and Prettier against `bun lint` and `bun fmt`

Measured 2026-10-16 on Bun 1.4.4-canary.1+5f5799ed1, ESLint 10.5.0, Prettier
3.8.4, 16 cores, shared with other sessions: the 1-minute load average was
2.2 to 8.5 during the runs (median 5.3), recorded before and after every run
in [`perf.tsv`](perf.tsv). Three runs of every cell, interleaved (each
round runs every tool on every directory before the next round), by
[`../tools/perf.sh`](../tools/perf.sh); GNU `time` for wall and
user+system CPU; `CI=1` throughout. Summarised by
[`../tools/perf-summary.ts`](../tools/perf-summary.ts). Medians:

| scope | eslint | bunlint-eslintcfg | bunlint-native | bunlint-hybrid | bunlint-native-regexp | prettier-3.8.4-check | bunfmt-check |
|---|---|---|---|---|---|---|---|
| packages/bun-common | 11.51 s (20.63 CPU) | 7.77 s (25.47 CPU) | 0.06 s (0.30 CPU) | 2.54 s (4.75 CPU) | 0.82 s (1.44 CPU) |  |  |
| packages/bun-nest | 6.06 s (10.97 CPU) | 5.55 s (9.80 CPU) | 0.02 s (0.10 CPU) | 1.50 s (1.61 CPU) | 0.45 s (0.48 CPU) |  |  |
| packages/bun-jobs | 46.33 s (72.54 CPU) | 19.04 s (147.57 CPU) | 0.16 s (1.22 CPU) | 5.92 s (28.11 CPU) | 1.79 s (7.74 CPU) |  |  |
| packages/bun-jobs-ui | 22.64 s (37.80 CPU) | 12.89 s (55.11 CPU) | 0.07 s (0.65 CPU) | 4.15 s (8.12 CPU) | 1.24 s (2.34 CPU) |  |  |
| scripts | 3.40 s (6.10 CPU) | 3.92 s (6.26 CPU) | 0.01 s (0.02 CPU) | 1.02 s (1.09 CPU) | 0.39 s (0.42 CPU) |  |  |
| playground | 3.37 s (6.03 CPU) | 3.92 s (5.98 CPU) | 0.01 s (0.06 CPU) | 0.88 s (0.92 CPU) | 0.28 s (0.30 CPU) |  |  |
| templates/compute-provider | 2.57 s (4.05 CPU) | 3.24 s (4.48 CPU) | 0.01 s (0.03 CPU) | 0.72 s (0.76 CPU) | 0.29 s (0.32 CPU) |  |  |
| examples/bun-common | 6.94 s (12.79 CPU) | 6.04 s (10.15 CPU) | 0.02 s (0.14 CPU) | 1.95 s (2.09 CPU) | 0.62 s (0.65 CPU) |  |  |
| examples/bun-nest | 4.58 s (8.45 CPU) | 4.76 s (8.30 CPU) | 0.01 s (0.10 CPU) | 1.42 s (1.51 CPU) | 0.43 s (0.46 CPU) |  |  |
| examples/bun-jobs | 10.69 s (18.30 CPU) | 6.58 s (20.79 CPU) | 0.02 s (0.24 CPU) | 3.36 s (3.56 CPU) | 1.03 s (1.07 CPU) |  |  |
| examples/bun-jobs-ui | 7.73 s (13.72 CPU) | 5.93 s (18.14 CPU) | 0.03 s (0.14 CPU) | 1.75 s (3.14 CPU) | 0.61 s (1.05 CPU) |  |  |
| ALL-root |  |  | 0.26 s (2.67 CPU) |  |  |  | 0.15 s (2.03 CPU) |
| scope-1651 |  |  |  |  |  | 28.38 s (45.94 CPU) | 0.10 s (1.16 CPU) |

The tools:

- **eslint**: `bunx eslint .`, the gate today.
- **bunlint-eslintcfg**: `bun lint` reading our unchanged `eslint.config.mjs`
  (98 rules native, 182 in JavaScript; `prettier/prettier` in JavaScript too,
  because Prettier 3.8.4 is not the 3.9 that `bun fmt` matches).
- **bunlint-native**: `bun lint` with
  [`../rules/bunfig.native.toml`](../rules/bunfig.native.toml), no JavaScript
  plugin (includes `bun/format`).
- **bunlint-native-regexp**: the same plus `eslint-plugin-regexp` as a JS
  plugin ([`../rules/bunfig.native-regexp.toml`](../rules/bunfig.native-regexp.toml)),
  the recommended configuration.
- **bunlint-hybrid**: native plus every JS plugin our `.ts` files use except
  `@eslint-react` ([`../rules/bunfig.hybrid.toml`](../rules/bunfig.hybrid.toml)).
- **prettier-3.8.4-check**: `prettier --check --single-attribute-per-line`
  on the 1,651 code files in the lint scope, standing in for the
  `prettier/prettier` rule's share of ESLint's time.
- **bunfmt-check**: `bun fmt --check` on the same list (it exited 2 because
  the list names the 10 `eslint.config.mjs` files the native clone had
  deleted; the other 1,641 were checked) and on the whole repository from the
  root (2,256 files).

Totals over the 11 directories, per run (wall / CPU seconds):

```text
eslint: 126.23/212.13, 131.79/220.18, 123.13/205.65  median wall 126.23 s, CPU 212.13 s
bunlint-eslintcfg: 77.69/305.39, 83.95/327.12, 76.72/298.28  median wall 77.69 s, CPU 305.39 s
bunlint-native: 0.44/2.98, 0.48/3.19, 0.42/2.89  median wall 0.44 s, CPU 2.98 s
bunlint-hybrid: 25.27/55.70, 25.62/57.04, 24.58/53.16  median wall 25.27 s, CPU 55.70 s
bunlint-native-regexp: 8.09/16.52, 8.14/16.71, 7.74/15.40  median wall 8.09 s, CPU 16.52 s
```

Reading it:

- Native `bun lint` lints the 11 directories in **0.44 s** against ESLint's
  **126 s**: about 290 times faster in wall time, 70 times less CPU. One
  `bun lint` from the root over the whole repository takes 0.26 s.
- **JavaScript plugins dominate as soon as there is one**: `eslint-plugin-regexp`
  alone takes the run from 0.44 s to 8.1 s (still 15 times faster than ESLint),
  every plugin to 25 s. Each Bun thread loads the plugin (`docs/lint/plugins.mdx`,
  Notes), which is why CPU grows faster than wall time.
- Pointing `bun lint` at today's ESLint config buys little: 78 s instead of
  126 s, for **more** CPU (305 s against 212 s), because 182 rules and
  `prettier/prettier` still run in JavaScript on every thread.
- `bun fmt --check` checks the whole repository in **0.15 s**; Prettier 3.8.4
  needs **28.4 s** for the 1,651 code files.
- Editor path, separately: `bun lint --stdin` on the 5,948-line
  `packages/bun-common/lib/BunRouter.ts` (native config) 0.02 s per call,
  five calls; `bun fmt --stdin-filepath` on it under 0.01 s.
