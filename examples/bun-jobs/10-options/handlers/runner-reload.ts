/**
 * Returns an id minted when the module was imported, so
 * `inProcess.reloadOnEachRun` can be seen re-importing it: the same id on
 * every run without it, a new one per run with it.
 */
import { defineHandler } from "@kingsleyweb/bun-jobs";

/** Minted once per module instance. */
const loadedAs = Bun.randomUUIDv7();

export default defineHandler<unknown, string>(() => {
  return loadedAs;
});
