# bun-node

Bun-first libraries for building servers: an Express-like HTTP layer for
`Bun.serve`, a NestJS adapter built on it, and background jobs and queues.

## Table of contents

- [What this repository is](#what-this-repository-is)
- [Packages](#packages)
- [Examples](#examples)
- [Requirements](#requirements)
- [Installation](#installation)
- [Development](#development)
  - [Typecheck, lint and test](#typecheck-lint-and-test)
  - [Database servers](#database-servers)
  - [Benchmarks](#benchmarks)
- [Repository layout](#repository-layout)
- [Contributing](#contributing)
- [License](#license)

## What this repository is

A monorepo of three published packages, managed with Bun workspaces, lerna and
nx. Each package ships its TypeScript source (`main` and `types` point at
`lib/index.ts`), so there is no build step. Each has its own tests
(`bun:test`), `tsc --noEmit` typecheck and ESLint configuration. The packages
prefer Bun and native APIs over third-party dependencies.

## Packages

| Package | npm | Description |
|---|---|---|
| [bun-common](packages/bun-common/README.md) | `@kingsleyweb/bun-common` | An Express-like HTTP layer for `Bun.serve`: `BunRouter` with Express 5 semantics, `BunRequest`, `BunResponse`, `BunHttpAdapter`, validation with any Standard Schema, CORS, static files, compression, multipart uploads, WebSockets and structured logging. |
| [bun-nest](packages/bun-nest/README.md) | `@kingsleyweb/bun-nest` | Run NestJS 11 on Bun: `BunHttpAdapter` in place of `@nestjs/platform-express`, multer-style file upload interceptors, and `BunWebSocketAdapter` for gateways over Bun's native WebSockets. |
| [bun-jobs](packages/bun-jobs/README.md) | `@kingsleyweb/bun-jobs` | Background work for Bun: `BunRunner` runs a JS/TS file on a schedule or on demand (child process, `Worker` or in-process), and `BunQueue` / `BunQueueWorker` process jobs across processes and services over memory, file, Redis, SQL and MongoDB drivers. |

bun-nest and bun-jobs both depend on bun-common.

## Examples

Runnable, commented examples live in [`examples/`](examples/README.md), one
project per package. Each example is a single script you run with `bun`.

| Project | Covers |
|---|---|
| [`examples/bun-common`](examples/bun-common/README.md) | Routing, the HTTP adapter, requests and responses, validation, CORS, static files, compression, multipart uploads, WebSockets, logging and utilities, plus option tours |
| [`examples/bun-nest`](examples/bun-nest/README.md) | NestJS on Bun: the HTTP adapter, file upload interceptors and the WebSocket adapter, plus option tours |
| [`examples/bun-jobs`](examples/bun-jobs/README.md) | Queues, workers, the job registry, scheduling, flow control, failures, the runner, every driver and integrations, plus option tours |
| [`examples/bun-jobs-ui`](examples/bun-jobs-ui/README.md) | The management UI beside the management API: mounting, the shell and bundle with their security headers, a cross-origin API, plus an option tour |

```bash
bun install                 # at the repo root
cd examples/bun-nest
bun run-all.ts              # every example in the project; prints ok / skip / FAIL
```

[`examples/README.md`](examples/README.md) describes the conventions every
example follows.

## Requirements

- **Bun ≥ 1.4.2.** The root and every package declare it in `engines.bun`, and
  the repository pins `bun@1.4.2` as its package manager. bun-jobs' Redis and
  SQL drivers use APIs that 1.4.2 is the first `bun-types` release to declare.
- **`@types/bun` ≥ 1.4.2**, an optional peer of every package.
- **NestJS 11** (`@nestjs/common`, `@nestjs/core`, `rxjs`; `@nestjs/websockets`
  for gateways) for bun-nest.

## Installation

Use [Bun](https://bun.sh/) to install the packages you need:

```bash
bun add @kingsleyweb/bun-common
bun add @kingsleyweb/bun-nest @nestjs/common @nestjs/core rxjs reflect-metadata
bun add @kingsleyweb/bun-jobs
```

## Development

```bash
git clone https://github.com/kingsloob1/bun-node.git
cd bun-node
bun install
```

### Typecheck, lint and test

```bash
bun scripts/typecheck.ts          # every project in the repo; must be clean
bun scripts/typecheck.ts --list   # just name them
```

`scripts/typecheck.ts` checks every `tsconfig.json` in the repository: the
packages, their nested bench and playground projects, `benchmarks/` and the
example projects. They all extend `tsconfig.base.json`, so a file is checked
the same way wherever it is checked from. Run it rather than `tsc` in a single
package.

Then, in each affected package directory:

```bash
bunx eslint .                     # the whole package, READMEs included; 0 errors
bun test                          # every test must pass
```

After changing bun-common, run bun-nest's and bun-jobs' checks too.

bun-common's typed route overloads, which bun-nest carries too, are generated:

```bash
cd packages/bun-common
bun scripts/generate-verb-overloads.ts          # rewrite both packages
bun scripts/generate-verb-overloads.ts --check  # fail if stale
```

### Database servers

bun-jobs' integration suites need Redis, Postgres, MariaDB, MySQL and MongoDB.
They skip visibly when their URL is unset. `scripts/setup-databases.ts`
provides the servers. It never reinstalls an existing server, configures one
only when a connection with the expected credentials fails, and never drops or
resets anything.

```bash
bun scripts/setup-databases.ts                 # system packages
bun scripts/setup-databases.ts --docker        # containers instead
bun scripts/setup-databases.ts --dry-run       # print the plan, change nothing
bun scripts/setup-databases.ts --only=mongodb  # one server
bun scripts/setup-databases.ts --print-env     # the env vars for the suites
```

### Benchmarks

The benchmark projects are separate, unpublished packages with their own
`package.json` and `node_modules`, so third-party comparators never reach a
published package's dependency tree.

| Project | Measures |
|---|---|
| [`benchmarks/`](benchmarks/README.md) | `BunRouter` throughput against Express 5, `Bun.serve` routes, Elysia and Hono |
| [`packages/bun-jobs/bench/`](packages/bun-jobs/bench/README.md) | `BunQueue` against BullMQ, bee-queue, node-resque, pg-boss, graphile-worker and Agenda; `BunRunner` against Bree, Agenda and cron timers |
| [`packages/bun-common/bench/`](packages/bun-common/bench/README.md) | `parseXmlToObject` against fast-xml-parser, htmlparser2 and `HTMLRewriter` |

Install a project's comparators inside its own directory before running or
type-checking it:

```bash
(cd benchmarks && bun install)
(cd packages/bun-jobs/bench && bun install)
(cd packages/bun-common/bench && bun install)
```

The bun-jobs benchmarks double as a regression guard:

```bash
cd packages/bun-jobs/bench
bun install
bun queue.ts --compare          # fails if a figure regressed or a rival overtook
bun runner.ts --compare
bun queue.ts --save-baseline    # re-record after a deliberate change
```

## Repository layout

```text
bun-node/
├── packages/
│   ├── bun-common/        # HTTP layer: lib/, __tests__/, bench/, playground/, scripts/
│   ├── bun-nest/          # NestJS adapter: lib/, __tests__/
│   └── bun-jobs/          # jobs and queues: lib/, __tests__/, bench/ (its own package)
├── examples/
│   ├── bun-common/        # one runnable project per package
│   ├── bun-nest/
│   ├── bun-jobs/
│   └── bun-jobs-ui/
├── benchmarks/            # router benchmarks (its own package)
├── scripts/
│   ├── typecheck.ts       # type-checks every project
│   └── setup-databases.ts # provisions the database servers for the tests
├── tsconfig.base.json     # compiler options every tsconfig.json extends
├── tsconfig.json
├── lerna.json
├── nx.json
└── package.json           # Bun workspaces for the three packages
```

## Contributing

Pull requests are welcome. For major changes, please open an issue first
to discuss what you would like to change.

Please make sure to update tests as appropriate, and keep typecheck, lint and
tests clean.

## License

[MIT](https://choosealicense.com/licenses/mit/)
