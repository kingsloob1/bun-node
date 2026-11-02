# `bun-client watch`: edit a route, time until the generated file changes

```bash
cd docs/plans/typed-client/evidence/watch && bun e2e.ts     # ~30 s; ITER=10 by default
```

Backs `../../README.md` §3.3 for PR-C3, as `../sync/` backed it for the
2026-10-10 spike. Unlike the spike, both halves are the shipped code: the
server is bun-common's `devTypes()` on a `BunHttpAdapter`, and the watcher is
the `bun-client` bin (`packages/bun-client/lib/codegen/cli.ts watch`),
finding the server through its token file.

| Mode | Server | What an edit does |
|---|---|---|
| `watch` | `bun --watch server.ts`; the adapter listens | the process restarts: the channel closes, the watcher reconnects (backoff from 50 ms), re-reads the token file (a new token per process), fetches and writes |
| `hot` | `bun --hot server.ts`; one `Bun.serve()` kept on `globalThis`, delegating to the latest evaluation's adapter, which never listens (a re-evaluated `listen()` fails with `EADDRINUSE`, the open follow-up) | the module re-evaluates; `devTypes()`'s hub keeps the socket, and its route poll (every 100 ms) announces `changed` |

Each edit rewrites `routes.ts` with a new field name, 300–400 ms apart
(jittered, so the edits do not lock into phase with the 100 ms poll), and
times until `api.gen.ts` contains it. `evaluatedToFileMs` is from the
server's evaluation finishing (its log line) to the file: what the
announcement and the watcher add to Bun's own reload. `results.txt` is the
last run.

## Results (`results.txt`, 2026-11-02, Bun 1.4.4-canary.1+11c367163, linux-x64, run exclusively through the heavy-run wrapper)

| Mode | Edit → file, median / p90 | Evaluation → file, median | The 2026-10-10 spike (`../sync/`) |
|---|---|---|---|
| `bun --watch` | **170 ms / 178 ms** | 79 ms | 160 ms / 163 ms |
| `bun --hot` | **139 ms / 146 ms** (min 73) | 95 ms | 49 ms / 68 ms |

- **`--watch` matches the spike** (+10 ms): the restart dominates; the
  watcher's part is the reconnect backoff (50 ms), re-reading the token file,
  and a fetch and regeneration of 14 ms median (the restarted server builds
  its documents on that first request).
- **`--hot` is slower than the spike, and the difference is the server's,
  not the watcher's.** A probe (a channel client timing frames against the
  server's evaluation log, 8 jittered edits) split it: Bun's re-evaluation
  42–50 ms after the edit, then **4–97 ms until `changed`**, which is
  `devTypes()`'s 100 ms route poll: a re-evaluated `devTypes()` takes over
  the hub without rebuilding at once, so the change is announced on the next
  tick. The watcher's own regeneration is 1 ms median. The spike's server
  announced on evaluation, hence its 49 ms. Announcing on take-over (a
  bun-common change) would bring `--hot` back to about Bun's reload time.
- An earlier run, with the wrapper choosing to run it beside other jobs (load
  7.5), gave 436 ms (`--watch`) and 183 ms (`--hot`): the figures need a quiet
  machine, hence `HEAVY_EXCLUSIVE=1`.
