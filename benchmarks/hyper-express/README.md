# hyper-express for the router benchmark

[hyper-express](https://github.com/kartikk221/hyper-express) runs on
[uWebSockets.js](https://github.com/uNetworking/uWebSockets.js), a native
addon, so `../bench.ts` runs it as a process of its own (`server.mjs`, the
same routes as every other entry) under two runtimes:

| Entry | Runtime |
|---|---|
| `hyper-express-node` | Node.js (22, 24 or 26: uWebSockets.js supports no other) |
| `hyper-express-bun` | Bun — **does not load**: uWebSockets.js is built against V8's C++ API, not Node-API, so Bun reports `symbol 'napi_register_module_v1' not found` and the benchmark skips the entry with that error |

## Setup

```bash
cd benchmarks/hyper-express
npm run setup   # clones uWebSockets.js v20.69.0 into vendor/, then npm install
```

hyper-express depends on uWebSockets.js through a GitHub ref. Where GitHub's
tarball API is not reachable (it answers 403 through some proxies) neither
`bun install` nor `npm install` can fetch that ref, but `git clone` can, so the
clone goes to `vendor/` and `overrides` points the dependency there. npm, not
Bun: Bun ignores `overrides`/`resolutions` for a GitHub-ref dependency.

Without this install, `bench.ts` skips both entries and says to run it.

## Caveat

Every other entry serves from the benchmark's own process, which also runs
autocannon's coordinator; hyper-express has a process to itself. On a small
machine that is a small advantage to it.
