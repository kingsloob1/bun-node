# Examples

Runnable, commented examples for the packages in this repo. One folder per
package; each example is a single script you run with `bun`, reading from top
to bottom as usage rather than as a test.

| Package | Folder | Status |
|---|---|---|
| [`@kingsleyweb/bun-jobs`](../packages/bun-jobs) | [`bun-jobs/`](./bun-jobs) | 51 examples: queues, workers (with search, paging and a worker/throughput dashboard), the job registry (with saved drafts and registry polling), scheduling, flow control, failures, the runner, every driver, integrations, the management API (mounting, live events, its documents and a client typed by its contract) — plus 20 option tours that assert every option works as documented |
| [`@kingsleyweb/bun-common`](../packages/bun-common) | [`bun-common/`](./bun-common) | 35 examples: routing, the HTTP adapter, requests and responses (request bodies in gzip, deflate, br and zstd, stacked or dictionary-compressed), validation, CORS, static files (precompressed or compressed on the fly), response compression (gzip, deflate, br, zstd and `dcb`/`dcz` dictionaries), multipart uploads, WebSockets, logging, utilities — plus 12 option tours |
| [`@kingsleyweb/bun-nest`](../packages/bun-nest) | [`bun-nest/`](./bun-nest) | 12 examples: NestJS on Bun with the HTTP adapter, file upload interceptors, the WebSocket adapter, the bun-jobs management API module and the jobs UI mounted beside it — plus 4 option tours |
| [`@kingsleyweb/bun-jobs-ui`](../packages/bun-jobs-ui) | [`bun-jobs-ui/`](./bun-jobs-ui) | 15 examples: the management UI beside the management API — quick start, the shell, bundle and security headers checked without a socket, a cross-origin API, the queue, runner, Events and API docs screens' deep links and the permissions they are drawn from, a live seeded demo of queues, workers and runners to click through, a browser pausing a queue, retrying a job and pausing a runner, a browser reading the API docs and trying their operations, a browser watching the live badge and the Events console, a browser failing a job, disabling a repeat series and reading its progress, a browser checking the keyboard shortcuts, skip link, headings, announcements and error boundary, and a browser driving the Overview's range, the Workers screens, the runner and job tools (settings, run logs, the clear actions) and a queue's Job defaults panel — plus an option tour; each asserts what it shows |

## Conventions

Every package's examples follow the same shape, so moving between them is
cheap:

- **Import by package name** (`@kingsleyweb/bun-jobs`), never a path into
  `lib/`. The name resolves to the workspace package through the root
  `node_modules`, so an example only uses what a consumer can.
- **Numbered folders** go from first contact to production concerns; within a
  folder, files are independent.
- **Each file starts with a comment** saying what it shows, how to run it, and
  the one or two things worth knowing that the code alone does not say.
- **Examples finish on their own** and exit `0`, waiting on what they
  demonstrate rather than on guessed sleeps. Anything that needs a server
  skips itself when that server's URL is unset.
- **Each folder is its own project**, with a `tsconfig.json` checked by
  `bun scripts/typecheck.ts` and an `eslint.config.mjs` that reuses the
  package's rules.

```bash
bun scripts/typecheck.ts              # from the repo root: includes the examples
cd examples/bun-jobs && bunx eslint . # lint
cd examples/bun-jobs && bun run-all.ts
```
