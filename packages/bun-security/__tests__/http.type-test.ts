/**
 * Compile-time checks for `./http` (checked by `bun run check`; `bun test`
 * never reads a `*.type-test.ts`).
 */
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import type { BunRequest } from "@kingsleyweb/bun-common";
import { createSecurity } from "../lib/index";
import type { EvaluationStage } from "../lib/index";
import {
  csrf,
  installSecurity,
  securityHeaders,
  securityMiddleware,
  securityProfile,
} from "../lib/http/index";
import type {
  RequestSecurity,
  requestSecurity,
  SecurityInstallation,
} from "../lib/http/index";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const assertType = <T extends true>(_?: T) => _;

const security = createSecurity<BunRequest>({
  policy: {},
  identify: (req) => ({ user: req.request.headers.get("x-user") ?? undefined }),
});

// An adapter with its own WebSocket data is accepted.
const app = new BunHttpAdapter<{ room: string }>();
export const installed: Promise<SecurityInstallation> = installSecurity(
  app,
  security,
  {
    headers: { crossOriginResourcePolicy: "cross-origin" },
    csrf: { origins: ["https://app.example"] },
    scrub: "always",
  },
);

// A profile and a guard sit among a route's callbacks.
app.post("/login", securityProfile("login"), (_req, res) => res.send("ok"));
const guard = csrf({ token: { secret: "x".repeat(32) } });
app.get("/form", guard, (req, res) => res.send(guard.token(req, res)));
app.use(securityMiddleware(security, { router: app }));
app.addBeforeWriteHook(securityHeaders());

assertType<
  Equal<ReturnType<typeof requestSecurity>, RequestSecurity | undefined>
>();
assertType<Equal<EvaluationStage, "early" | "route">>();

// Negative controls: an engine typed for a plain Request, whose identify()
// would read the wrong object, and an unknown scrub mode.
const plain = createSecurity<Request>({ policy: {} });
// @ts-expect-error installSecurity's engine identifies a BunRequest
void installSecurity(app, plain);
// @ts-expect-error scrub is "production", "always" or false
void installSecurity(app, security, { scrub: "never" });
