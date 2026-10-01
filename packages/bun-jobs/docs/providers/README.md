# Compute providers

A **compute provider** is a package that teaches bun-jobs to start compute on
a platform. A [`SummonController`](../../README.md#summoning-a-worker) watches
a queue, and when the queue has work and no worker it asks the provider to
start one: an ECS task, a Fly Machine, a Cloud Run job, a unit on a host of
your own. The worker it starts is an ordinary bun-jobs worker, run with
`runSummoned`.

These pages ship in the package, so the copy in
`node_modules/@kingsleyweb/bun-jobs/docs/providers/` always matches the
version installed.

## Which page to read

| You are | Read |
| --- | --- |
| using a provider someone else wrote | [the user guide](./user-guide.md) |
| writing a provider for a platform | [the author guide](./author-guide.md) |
| looking up a type or a member | [the API reference](./reference.md) |
| deciding whether to trust one, or reviewing one | [the security page](./security.md) |

## What a provider is

A provider is made with `defineComputeProvider` from
`@kingsleyweb/bun-jobs/provider`. It is a function: call it with a config and
it answers a **configured provider**, which is what `SummonPolicy.summoner`
accepts. It declares:

- **an identity**: its package `name`, `version`, a short `kind`, and the
  plugin API versions it was written against (`apiVersion`);
- **a config schema**: any [Standard Schema](https://standardschema.dev), and
  the paths in the config that hold **secrets**;
- **facets**: what it can do. This version has one, **summon**: starting
  compute for a queue. Its `capabilities` say how the platform behaves, and
  the controller reads them instead of knowing platforms by name.

There is no registry: a provider is an import, passed in where it is used.

One provider ships with bun-jobs: **`localCompute`**, which summons workers
as child processes on the host the controller runs on. See
[Summoning on this host](./user-guide.md#summoning-on-this-host-localcompute).

A plain function also works, through `defineSummoner` from
`@kingsleyweb/bun-jobs/summon`: the same thing without the ceremony, for code
you own. A provider plugin is for code you publish.

## Status

**Experimental.** The plugin API is versioned per facet, and both versions
are `0.1` (`COMPUTE_PROVIDER_API`): any `0.x` minor may change it, and the
first controller handed a provider logs one `warn` per process saying so
(never for `defineSummoner`, which is your own code). Only the summon facet
exists; there is no execute facet yet, and a definition that declares one is
refused.

## Elsewhere

- [Summoning a worker](../../README.md#summoning-a-worker), in the package
  README: the controller, the policy and the provider errors.
- [Summoned workers: `runSummoned`](../../README.md#summoned-workers-runsummoned):
  the worker's side of a summon.
- [The starter template](https://github.com/kingsloob1/bun-node/tree/develop/templates/compute-provider):
  a complete provider for a fictional platform, its fake and a green
  conformance test, to copy.
- [A custom provider, as an example](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/02-queues/custom-provider.ts):
  a provider defined, tested with the conformance kit and used by a
  controller, in one runnable file.
