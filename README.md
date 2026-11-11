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

A monorepo of seven published packages, managed with Bun workspaces, lerna and
nx, released together at one version (lerna's fixed mode). Each package ships
its TypeScript source, which Bun runs as it is (`main` is `lib/index.ts`),
and declarations built into `dts/` when it is packed. Each has its own tests
(`bun:test`), `bun check` typecheck, and `bun lint` and `bun fmt` from the
root `bunfig.toml`. The packages
prefer Bun and native APIs over third-party dependencies.

## Packages

| Package | npm | Description |
|---|---|---|
| [bun-common](packages/bun-common/README.md) | `@kingsleyweb/bun-common` | An Express-like HTTP layer for `Bun.serve`: `BunRouter` with Express 5 semantics, `BunRequest`, `BunResponse`, `BunHttpAdapter`, validation with any Standard Schema, CORS, static files, compression, multipart uploads, WebSockets and structured logging. |
| [bun-contract](packages/bun-contract/README.md) | `@kingsleyweb/bun-contract` | bun-common's transport-agnostic contract core on its own: transports, contracts over any Standard Schema, guards, contract descriptions and channel contracts, with no dependency and safe in a browser. bun-common re-exports it as `@kingsleyweb/bun-common/contract`. |
| [bun-nest](packages/bun-nest/README.md) | `@kingsleyweb/bun-nest` | Run NestJS 11 or 12 on Bun: `BunHttpAdapter` in place of `@nestjs/platform-express`, multer-style file upload interceptors, and `BunWebSocketAdapter` for gateways over Bun's native WebSockets. |
| [bun-jobs](packages/bun-jobs/README.md) | `@kingsleyweb/bun-jobs` | Background work for Bun: `BunRunner` runs a JS/TS file on a schedule or on demand (child process, `Worker` or in-process), and `BunQueue` / `BunQueueWorker` process jobs across processes and services over memory, file, Redis, SQL and MongoDB drivers. |
| [bun-client](packages/bun-client/README.md) | `@kingsleyweb/bun-client` | A typed HTTP client for these servers, with no dependency and safe in a browser: one call per verb keyed by the server's own path literal, named operations, results discriminated by status, retries with `Retry-After`, timeouts, middleware and single-flight auth refresh; `./query` puts the routes on TanStack's query-core (an optional peer) with cache tags, `ETag` revalidation and optimistic updates. |
| [bun-cache](packages/bun-cache/README.md) | `@kingsleyweb/bun-cache` | Caching over pluggable drivers: one typed API (TTLs, tags, single-flight, stale-while-revalidate, counters, an L1 memory tier kept coherent by a bus) over memory, file, SQLite, Postgres, MySQL, MariaDB, Redis, MongoDB, S3, Azure Blob Storage and Cloudflare drivers, an HTTP response cache for bun-common and a Keyv store. |
| [bun-ui](packages/bun-ui/README.md) | `@kingsleyweb/bun-ui` | Every browser UI of the repo in one package, one subpath each: `@kingsleyweb/bun-ui/jobs` is the React management UI for bun-jobs' management API, served by a `jobsUi()` router that mounts beside `createJobsApi` (bun-jobs is an optional peer only that subpath needs); `@kingsleyweb/bun-ui/docs` is a self-hosted viewer for one OpenAPI 3.1 or AsyncAPI 3.0 document, served by a `docsUi()` handler under a strict self-only CSP. |

bun-nest, bun-jobs, bun-cache and bun-ui depend on
bun-common, which depends on bun-contract; bun-client depends on bun-contract
alone.

## Examples

Runnable, commented examples live in [`examples/`](examples/README.md), one
project per package. Each example is a single script you run with `bun`.

| Project | Covers |
|---|---|
| [`examples/bun-common`](examples/bun-common/README.md) | Routing, the HTTP adapter, requests and responses, validation, CORS, static files, compression, multipart uploads, WebSockets, logging and utilities, plus option tours |
| [`examples/bun-nest`](examples/bun-nest/README.md) | NestJS on Bun: the HTTP adapter, file upload interceptors and the WebSocket adapter, plus option tours |
| [`examples/bun-jobs`](examples/bun-jobs/README.md) | Queues, workers, the job registry, scheduling, flow control, failures, the runner, every driver and integrations, plus option tours |
| [`examples/bun-ui`](examples/bun-ui/README.md) | bun-ui, a folder per UI; `jobs/`: the management UI beside the management API: mounting, the shell and bundle with their security headers, a cross-origin API, plus an option tour |

```bash
bun install                 # at the repo root
cd examples/bun-nest
bun run-all.ts              # every example in the project; prints ok / skip / FAIL
```

[`examples/README.md`](examples/README.md) describes the conventions every
example follows.

## Requirements

- **Bun ≥ 1.4.2** to use the packages. Every package declares it in
  `engines.bun`. bun-jobs' Redis and SQL drivers use APIs that 1.4.2 is the
  first `bun-types` release to declare.
- **`@types/bun` ≥ 1.4.2**, an optional peer of every package.
- **Bun ≥ 1.4.3** to develop the repository, the first stable release with
  `bun check`, which runs every type check here. The root `package.json`
  declares it in `engines.bun` and pins `bun@1.4.3` as its package manager.
- **NestJS 11.1.20 or later, or NestJS 12** (`@nestjs/common`, `@nestjs/core`,
  `rxjs`; `@nestjs/websockets` for gateways) for bun-nest.

## Installation

Use [Bun](https://bun.sh/) to install the packages you need:

```bash
bun add @kingsleyweb/bun-common
bun add @kingsleyweb/bun-nest @nestjs/common @nestjs/core rxjs reflect-metadata
bun add @kingsleyweb/bun-jobs
```

**3.1.0** is on npm's `latest` tag, all seven packages at one version, so
the commands above install it. Coming from 2.2.0, read
[`CHANGELOG.md`](CHANGELOG.md) first: 3.0.0 is a major release, and its
entry starts with the change that can silently stop an authentication
middleware from guarding a path.

[`docs/releasing.md`](docs/releasing.md) is how a release is cut: the
version bump and its `CHANGELOG.md` entry in a PR, then `npm login`,
`bun scripts/publish.ts --dry-run` and `bun scripts/publish.ts` (one
one-time code for every package; it tags the commit and creates the GitHub
release at the end).

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

`scripts/typecheck.ts` checks every `tsconfig.json` in the repository with
`bun check` (`bun run check` at the root runs it too): the packages, their
nested bench and playground projects, `benchmarks/` and the example projects.
They all extend `tsconfig.base.json`, so a file is checked the same way
wherever it is checked from. Run it rather than `bun run check` in a single
package.

Then, in each affected package directory:

```bash
bun run check                     # bun check on the package's projects
bun run lint                      # bun lint over the whole package; 0 errors
bun run format:check              # bun fmt --check; clean (bun run format formats)
bun run test                      # type-checks the tests, then runs them; every test must pass
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
│   ├── bun-contract/      # the contract core, no dependency: lib/, __tests__/
│   ├── bun-nest/          # NestJS adapter: lib/, __tests__/
│   ├── bun-jobs/          # jobs and queues: lib/, __tests__/, bench/ (its own package)
│   └── bun-client/        # the typed HTTP client, no dependency: lib/, __tests__/
├── examples/
│   ├── bun-common/        # one runnable project per package
│   ├── bun-nest/
│   ├── bun-jobs/
│   └── bun-ui/            # jobs/, a folder per UI
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
