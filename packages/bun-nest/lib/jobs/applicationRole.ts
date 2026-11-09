import type { SummonedArgs } from "@kingsleyweb/bun-jobs";
import type { DynamicModule, Type } from "@nestjs/common";
import { Module } from "@nestjs/common";

/**
 * Says an application was built by a helper rather than to serve: no worker, series
 * or runner starts by itself. Provided around the application's own module, so
 * nothing needs setting in it, and a module shared with the main process is the same
 * module here. A registered symbol, so two copies of the package agree on it.
 */
export const BUN_JOBS_APPLICATION_ROLE: unique symbol = Symbol.for(
  "@kingsleyweb/bun-nest/jobs:application-role",
);

/** What a helper built an application for. */
export interface BunJobsApplicationRole {
  /** This process's summon, for `runSummonedApplication`: its workers carry it. */
  readonly summon?: SummonedArgs;
}

/** The module {@link withApplicationRole} wraps an application's own in. */
class BunJobsRoleRoot {}
Module({})(BunJobsRoleRoot);

/** An application's module, with a role every module can see. */
export function withApplicationRole(
  /** The application's module. */
  module: Type<unknown> | DynamicModule,
  /** What it is for. */
  role: BunJobsApplicationRole,
): DynamicModule {
  return {
    module: BunJobsRoleRoot,
    global: true,
    imports: [module],
    providers: [{ provide: BUN_JOBS_APPLICATION_ROLE, useValue: role }],
    exports: [BUN_JOBS_APPLICATION_ROLE],
  };
}
