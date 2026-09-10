/**
 * The job Bree executes, matched to `handler.ts` as closely as Bree's contract
 * allows: post one message so the parent can time the start, then the "done"
 * message Bree needs in order to consider the worker finished.
 */
import { parentPort } from "node:worker_threads";

parentPort?.postMessage({ startedAt: Date.now() });
parentPort?.postMessage("done");
