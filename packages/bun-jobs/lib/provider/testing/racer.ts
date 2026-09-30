import type { DriverConfig } from "../../drivers/index";
import type { SummonCapabilities } from "../define";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { createDriver } from "../../drivers/index";
import { SummonController } from "../../summon/controller";
import { defineSummoner } from "../../summon/define";
import { runScript } from "./spawn";

/**
 * One of the two processes the conformance kit's compare-and-set check races
 * (plugins §12.2, "the CAS"): a real `SummonController` over the shared
 * driver, whose summoner forwards every call to the kit, which calls the
 * provider under test. So both controllers race on the real marker, and
 * every call that wins reaches the real provider and its fake.
 *
 * Waits for the agreed start time so both check at the same instant, runs a
 * few checks back to back, and prints one JSON line per check.
 *
 * Runs only as a script (`import.meta.main`).
 */

/** The environment variables the kit sets for a racer. */
export const RACER_ENV = {
  /** The driver config, as JSON. */
  driver: "BUN_JOBS_CONFORMANCE_DRIVER",
  /** The namespace. */
  namespace: "BUN_JOBS_CONFORMANCE_NAMESPACE",
  /** The queue. */
  queue: "BUN_JOBS_CONFORMANCE_QUEUE",
  /** Epoch ms to start checking at. */
  startAt: "BUN_JOBS_CONFORMANCE_START_AT",
  /** How many checks to run. */
  checks: "BUN_JOBS_CONFORMANCE_CHECKS",
  /** The kit's forwarding endpoint. */
  forward: "BUN_JOBS_CONFORMANCE_FORWARD",
  /** The provider's kind and capabilities, as JSON. */
  provider: "BUN_JOBS_CONFORMANCE_PROVIDER",
} as const;

/** This file, for the spawner. */
export const RACER = import.meta.path;

/** What the kit tells a racer about the provider. */
export interface RacerProvider {
  /** The provider's kind. */
  kind: string;
  /** Its declared capabilities. */
  capabilities: SummonCapabilities;
}

/** Posts one call to the kit and answers its JSON, or throws what the kit reported. */
async function forward(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${process.env[RACER_ENV.forward]}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const answer = (await response.json()) as {
    result?: unknown;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(answer.error ?? `forwarding failed: ${response.status}`);
  }
  return answer.result;
}

/** Races: checks at the agreed instant, prints each result. */
async function main(): Promise<never> {
  const driver = createDriver(
    JSON.parse(process.env[RACER_ENV.driver]!) as DriverConfig,
  );
  await driver.connect();
  const { kind, capabilities } = JSON.parse(
    process.env[RACER_ENV.provider]!,
  ) as RacerProvider;
  const controller = new SummonController({
    driver,
    namespace: process.env[RACER_ENV.namespace]!,
    queue: process.env[RACER_ENV.queue]!,
    summoner: defineSummoner({
      kind,
      style: capabilities.style,
      passes: capabilities.passes,
      dedupe: capabilities.dedupe,
      bootBudget: capabilities.bootBudgetMs,
      shutdown: capabilities.shutdown,
      invoke: async (request) =>
        (await forward("/summon", request)) as Awaited<
          ReturnType<Parameters<typeof defineSummoner>[0]["invoke"]>
        >,
      ...(capabilities.style === "scale"
        ? {
            release: async (request) => {
              await forward("/release", request);
            },
          }
        : {}),
    }),
    triggers: { onAdd: false, events: false, poll: false },
    cooldown: 0,
    logger: noopLogger,
  });

  await Bun.sleep(
    Math.max(0, Number(process.env[RACER_ENV.startAt]) - Date.now()),
  );
  const checks = Number(process.env[RACER_ENV.checks] ?? 3);
  for (let index = 0; index < checks; index++) {
    const result = await controller.check();
    process.stdout.write(
      `${JSON.stringify({
        action: result.action,
        reason: "reason" in result ? result.reason : null,
      })}\n`,
    );
  }
  await controller.close();
  await driver.close();
  process.exit(0);
}

if (import.meta.main) {
  runScript(main);
}
