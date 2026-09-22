# bun-node playground

A place to try things by hand and see how they look: `bun-jobs`, its
management API (`createJobsApi`) and the `bun-jobs-ui` app on one
`BunHttpAdapter`, with a small simulation that keeps every screen moving.

```bash
bun playground/index.ts                              # then open http://localhost:4000/jobs
cd playground && bun run dev                         # the same, restarting on file changes
PORT=3000 bun playground/index.ts                    # another port
PLAYGROUND_DRIVER=sqlite bun playground/index.ts     # keeps its state in playground/.data/
PLAYGROUND_DRIVER=redis PLAYGROUND_URL=redis://localhost:6379/12 bun playground/index.ts
PLAYGROUND_INTERVAL_MS=0 bun playground/index.ts     # seed only, no new jobs
```

**Restart it after changing the UI.** The playground passes `dev: true`, so
`jobsUi()` builds the browser app from the source in memory on the first
request — never from a prebuilt `dist/`, which packing the package leaves
behind — **once per process**, and serves that build for as long as the
process runs. A playground started before a UI
change keeps serving the old screens, whatever the browser reloads. If you
use `bun run dev` and a UI change does not show, the same applies: stop it,
start it again, then reload.

It listens on `127.0.0.1` only. Its API allows **every** action to anyone who
can reach it, so never expose it.

## What is running

| Where | What |
|---|---|
| `/jobs` | the UI (Overview, Queues, Workers, Runners, Events, API docs) |
| `/jobs-api` | the management API, with its live-events socket on the same port |
| `/` | redirects to `/jobs` |

**Services and workers.** Two `BunJobs` contexts share one driver instance,
so the Workers page has two services to group (`index.ts`, `mailer.ts`):

| Service | Worker (stable key) | What you see |
|---|---|---|
| `api` | `api.emails.transactional`, `api.reports.monthly`, `api.webhooks.delivery` | the simulation's own workers; the emails one sets `stopPersistenceOverridable`, so its Stop dialog offers "until somebody starts it again" |
| `mailer` | `mailer.emails.bulk`, `mailer.images.thumbs` | a second deployment on the same queues; `thumbs` slowly eats the `images` backlog, so pausing it is visible |

A worker's **settings** are keyed by that stable key, so a change from the UI
survives a restart of the playground and reaches every replica carrying it.

**Queues** (`simulation.ts`):

| Queue | Worker | What you see |
|---|---|---|
| `emails` | 3 at a time, 0.5–3 s each | logs, progress 0→100, ~15% fail and retry (3 attempts) |
| `reports` | 1 at a time, 6–15 s each | an object progress (`{ step, done, of }`), a backlog |
| `webhooks` | 2 at a time, rate-limited 20/min | retries with exponential backoff; `umbrella` always fails, so dead jobs pile up |
| `images` | none in `api` — its only worker is `mailer.images.thumbs` (see above) | a backlog that drains slowly, one job at a time; pause that worker and it only grows |

Also on `emails`: two repeat series (`weekly-digest`, `daily-summary`: try
Disable/Enable), a delayed `reminder-tomorrow`, and a flow
(`newsletter-2026-09`) that waits (`waiting-children`) on two renders in
`images` until `mailer.images.thumbs` reaches them behind the thumbnail
backlog — pause that worker and it waits for good. A new job arrives
every `PLAYGROUND_INTERVAL_MS` (default 2000).

**Runners** (`runners.ts`, all running `handlers/work.ts`). `backup` and
`reindex` run in a child process; `sync-crm`, `archive` and `ping` run
in-process. Every run's log carries its `stdout`/`stderr` as well as its
`ctx.log()` lines either way: a spawned run's from its pipes, an in-process
run's because capture attributes each `console` call to the run that made it
(the output still reaches the playground's terminal too):

| Runner | Schedule | What you see |
|---|---|---|
| `backup` | every 30 s | spawned: runs in a child process |
| `sync-crm` | every minute | fails about half the time (`lastError`) |
| `archive` | Sundays 04:30, Europe/London | paused (Resume…) |
| `reindex` | none | spawned; runs only when triggered; Trigger… may pass `{ "ms": 20000 }` for a long run to Kill…, or `{ "failRate": 1 }` |
| `ping` | every 10 s, 5 s timeout | its 2–8 s of work times out about half the time, and one run in five that finishes in time throws; the Overview's Runners section counts the throws as Failed and the timeouts apart, under "Timed out / killed" |

## Things to try

- Open the Overview after a minute: Jobs, Queues, Runners and Workers all show real numbers over the range.
- On the Overview, pick "Last 10 minutes": the sections say they were answered in minute buckets, since per-second numbers are not kept that far back.
- Pause `emails` and watch `waiting` grow, then Resume.
- Open a running `reports` job: the progress bar and logs update live.
- Retry-all on `webhooks` dead jobs; Fail… a waiting `images` job.
- Add job on `images`, then open the Events console on `queue/images`.
- Trigger `reindex` with `{ "ms": 30000 }`, then Kill… it.
- Open Workers: pause `mailer.images.thumbs` and watch the `images` backlog stop falling, then resume it.
- Stop `api.emails.transactional`, watch `emails` slow to the mailer's pace, then start it again.
- Settings… on a worker: raise its concurrency and watch the queue drain faster; Reset to code values puts it back.
- Events console → "Every worker": worker state, config and control events as you drive the buttons.
- Open a `backup` run and read its log: `ctx.log()` lines, its stdout steps, and stderr when it fails.
- Open a `sync-crm` or `ping` run, which is in-process: its `console.warn` ("upstream slow on step 2…") is on `stderr` in its own log, and filtering the log to `stderr` shows just that line (and the failure, when it failed).
- In any run's log, the first `stdout` line prints `apiKey=pk_demo_…`; the stored line has that value redacted.
- Watch a running run's log on the runner screen: new lines appear as the runner announces them on the live socket, not on a timer.
- Try any operation from API docs → HTTP, and watch the screens follow.
- `PLAYGROUND_DRIVER=sqlite` and restart: everything is still there.

Ctrl+C stops it cleanly (it waits up to 2 s for a running report).
