# `bun-common` benchmarks

**`xml.ts`** measures `parseXmlToObject` (from `lib/utils/native.ts`) against
**fast-xml-parser**, **htmlparser2** (a DOM build and a SAX build) and Bun's
native **`HTMLRewriter`**.

This directory is a separate, unpublished package with its own `package.json`,
lockfile and `node_modules`, so the comparators never reach
`@kingsleyweb/bun-common`'s dependency tree.

## Setup

```bash
cd packages/bun-common/bench
bun install
```

Without the install the script still runs. It skips the two third-party
comparators with a note and measures only `parseXmlToObject` and
`HTMLRewriter`.

## Run

```bash
bun xml.ts          # or: bun run xml
```

## What it measures

Each contender turns a generated `<catalog>` of `<book>` records into the
**same plain object**: root-keyed, `@_`-prefixed attributes, repeated children
collected into arrays, and numeric and boolean text coerced. The figure
reflects parsing and object building, not differences in output shape.

The document sizes are 10, 100, 1,000, 5,000 and 20,000 records. For each size
the script prints ms/op, ops/sec, MB/s and the ratio to `parseXmlToObject`.

`HTMLRewriter` applies HTML semantics. It doesn't decode XML entities and isn't
XML-correct, so it is there only as a throughput reference.
