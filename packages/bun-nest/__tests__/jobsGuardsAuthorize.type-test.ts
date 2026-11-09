/**
 * Compile-time checks on `guardsAuthorize` and the API module's `context`, read by
 * `bun run check`.
 */
import type {
  JobsApiAuthorize,
  JobsApiAuthorizeContext,
} from "@kingsleyweb/bun-jobs";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type { ModuleRef } from "@nestjs/core";
import {
  BunJobsApiModule,
  guardsAuthorize,
  jobsApiContextOf,
} from "../lib/jobs/index";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

declare const moduleRef: ModuleRef;
declare const context: ExecutionContext;
declare class Guard implements CanActivate {
  canActivate(context: ExecutionContext): boolean;
}

/** The jobs UI's `authorize`, by shape: bun-nest does not name bun-ui. */
type UiAuthorize = (
  req: Parameters<JobsApiAuthorize>[0],
  context: { asset: boolean; path: string },
) => ReturnType<JobsApiAuthorize>;

const built = guardsAuthorize(moduleRef, [Guard, new Guard()]);
export const forTheApi: JobsApiAuthorize = built;
export const forTheUi: UiAuthorize = built;

export const told = jobsApiContextOf(context);
export const toldUi = jobsApiContextOf<{ asset: boolean }>(context);
export type _Told = Expect<
  Equal<typeof told, JobsApiAuthorizeContext | undefined>
>;
export type _ToldUi = Expect<
  Equal<typeof toldUi, { asset: boolean } | undefined>
>;

class Policy {
  read() {}
  mutate() {}
}
class NotAPolicy {
  read() {}
}
guardsAuthorize(moduleRef, [Guard], { policy: Policy });
// @ts-expect-error a policy has read and mutate
guardsAuthorize(moduleRef, [Guard], { policy: NotAPolicy });
// @ts-expect-error a guard has canActivate
guardsAuthorize(moduleRef, [class {}]);

BunJobsApiModule.forRoot({
  context: "other",
  basePath: "/jobs",
  allowUnauthenticated: true,
});
BunJobsApiModule.forRootAsync({
  context: "other",
  useFactory: () => ({ basePath: "/jobs", allowUnauthenticated: true }),
});
