/**
 * The child half of the security store kit's two-process pass (storage.md
 * §9): `runSecurityStoreConformance` spawns this file with a JSON job; it
 * builds the same store the kit tests — from the job's module path, export
 * and options — connects it, prints `{"ready":true}`, and waits at the start
 * barrier (its stdin closing), so its side and the kit's start together.
 * Then it races the kit for the same document and the same policy's head,
 * retrying each refused write, and prints what it won as one JSON line.
 *
 * Not a public API: it runs at load, which is why `package.json`'s
 * `sideEffects` lists it.
 */
import type { SecurityStoreDriver } from "../store/types";
import process from "node:process";
import { raceStore } from "./race";

/** The job the kit passes on the command line. */
export interface StoreCrossProcessJob {
  /** The absolute path of the module the store's factory lives in. */
  readonly module: string;
  /** The factory's export; default `"default"`. */
  readonly export?: string;
  /** What the factory is called with. */
  readonly options?: unknown;
  /** The document both sides race to write. */
  readonly docId: string;
  /** The policy both sides race to append to. */
  readonly policyId: string;
  /** How many writes and appends to win. */
  readonly count: number;
  /** This side's label, in the version ids it appends. */
  readonly side: string;
}

/** Prints one JSON line on stdout, flushed before it resolves. */
async function emit(value: unknown): Promise<void> {
  await Bun.write(Bun.stdout, `${JSON.stringify(value)}\n`);
}

/** Builds the store, waits at the barrier, races, and prints what it won. */
async function main(): Promise<void> {
  const job = JSON.parse(process.argv[2] ?? "{}") as StoreCrossProcessJob;
  const mod = (await import(job.module)) as Record<string, unknown>;
  const factory = mod[job.export ?? "default"] as (
    options?: unknown,
  ) => SecurityStoreDriver;
  const store = factory(job.options ?? {});
  try {
    await store.connect();
    await emit({ ready: true });
    await Bun.stdin.text();
    await emit(await raceStore(store, job));
  } finally {
    await store.close();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    // A failed child exits non-zero with its error on stderr; the kit reports both.
    console.error(error);
    process.exit(1);
  });
}
