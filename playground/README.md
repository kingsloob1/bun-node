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

It listens on `127.0.0.1` only. Its API allows **every** action to anyone who
can reach it, so never expose it.

## What is running

| Where | What |
|---|---|
| `/jobs` | the UI (Overview, Queues, Runners, Events, API docs) |
| `/jobs-api` | the management API, with its live-events socket on the same port |
| `/` | redirects to `/jobs` |

**Queues** (`simulation.ts`):

| Queue | Worker | What you see |
|---|---|---|
| `emails` | 3 at a time, 0.5–3 s each | logs, progress 0→100, ~15% fail and retry (3 attempts) |
| `reports` | 1 at a time, 6–15 s each | an object progress (`{ step, done, of }`), a backlog |
| `webhooks` | 2 at a time, rate-limited 20/min | retries with exponential backoff; `umbrella` always fails, so dead jobs pile up |
| `images` | none | a `waiting` backlog nothing consumes |

Also on `emails`: two repeat series (`weekly-digest`, `daily-summary`: try
Disable/Enable), a delayed `reminder-tomorrow`, and a flow
(`newsletter-2026-09`) waiting on two renders in `images`. A new job arrives
every `PLAYGROUND_INTERVAL_MS` (default 2000).

**Runners** (`runners.ts`, all running `handlers/work.ts` in-process):

| Runner | Schedule | What you see |
|---|---|---|
| `backup` | every 30 s | a growing history |
| `sync-crm` | every minute | fails about half the time (`lastError`) |
| `archive` | Sundays 04:30, Europe/London | paused (Resume…) |
| `reindex` | none | runs only when triggered; Trigger… may pass `{ "ms": 20000 }` for a long run to Kill…, or `{ "failRate": 1 }` |

## Things to try

- Pause `emails` and watch `waiting` grow, then Resume.
- Open a running `reports` job: the progress bar and logs update live.
- Retry-all on `webhooks` dead jobs; Fail… a waiting `images` job.
- Add job on `images`, then open the Events console on `queue/images`.
- Trigger `reindex` with `{ "ms": 30000 }`, then Kill… it.
- Try any operation from API docs → HTTP, and watch the screens follow.
- `PLAYGROUND_DRIVER=sqlite` and restart: everything is still there.

Ctrl+C stops it cleanly (it waits up to 2 s for a running report).
