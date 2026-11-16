/**
 * Compile-time checks for `./security` (checked by `bun run check`; `bun
 * test` never reads a `*.type-test.ts`).
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import type { DynamicModule } from "@nestjs/common";
import type { BunBeforeReadHook } from "../lib/index";
import { createSecurity } from "@kingsleyweb/bun-security";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import {
  SecurityModule,
  SecurityProfile,
  SecurityRefusalException,
  SkipSecurity,
} from "../lib/security/index";

// Options built from createSecurity's, with the settings beside them.
export const fromOptions: DynamicModule = SecurityModule.forRoot({
  policy: { limits: [{ id: "ip", limit: 10, window: "1m" }] },
  identify: (req: BunRequest) => ({
    user: req.request.headers.get("x-user") ?? undefined,
  }),
  headers: { frameOptions: false },
  csrf: false,
  scrub: "always",
  globalGuard: true,
});

// An engine made elsewhere, typed for bun-common's request.
export const fromEngine: DynamicModule = SecurityModule.forRoot({
  security: createSecurity<BunRequest>({ policy: {} }),
});

// A factory with typed injections.
export const fromFactory: DynamicModule = SecurityModule.forRootAsync({
  inject: ["LIMIT"],
  useFactory: (limit: number) => ({
    policy: { limits: [{ id: "ip", limit, window: "1m" }] },
  }),
});

// @ts-expect-error an engine typed for a plain Request would read the wrong object in identify()
SecurityModule.forRoot({ security: createSecurity<Request>({ policy: {} }) });
// @ts-expect-error scrub is "production", "always" or false
SecurityModule.forRoot({ policy: {}, scrub: "never" });

export const profile: ClassDecorator & MethodDecorator =
  SecurityProfile("login");
export const skip: ClassDecorator & MethodDecorator = SkipSecurity(
  "csrf",
  "limit:per-user",
);
export const status: number = new SecurityRefusalException({
  action: "block",
  hits: [],
  tags: [],
  risk: 1,
  subject: {},
}).getStatus();

// The adapter's before-read hook, as bun-common's.
const hook: BunBeforeReadHook = (request) =>
  request.method === "TRACE" ? new Response(null, { status: 405 }) : undefined;
export const remove: () => void = new BunHttpAdapter().addBeforeReadHook(hook);
// @ts-expect-error an answer is a Response, never a status
new BunHttpAdapter().addBeforeReadHook(() => 403);
