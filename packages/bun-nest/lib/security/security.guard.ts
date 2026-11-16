/**
 * `SecurityGuard`: bun-security's route stage as a Nest guard (plan §3.5).
 */
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type { SecurityProfileMetadata } from "./security.interface";
import { Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  SECURITY_PROFILE_METADATA,
  SKIP_SECURITY_METADATA,
} from "./security.constants";
import { challengeRefusal } from "./security.challenge";
import { SecurityRefusalException } from "./security.exception";
import { SecurityService } from "./security.service";

/**
 * The route stage of bun-security on a Nest application: for each HTTP
 * request that reaches a route, the route's `@SecurityProfile()` and
 * `@SkipSecurity()`, the caller from `identify(req)`, the limits and
 * counted rules keyed on the caller or the route, the lists' user and
 * API-key entries, bans of the caller, canary credentials, then the CSRF
 * check. A refusal is a `SecurityRefusalException` for Nest's exception
 * layer; a challenge, when the engine has a challenge flow, is a
 * `SecurityChallengeException` carrying the flow's page or descriptor.
 * Other contexts (WebSocket gateways, microservices) pass.
 *
 * `SecurityModule` provides it as `APP_GUARD` unless `globalGuard: false`.
 * Its constructor parameters are declared explicitly (`@Inject`), so
 * injection never rests on inherited or emitted metadata: a subclass of a
 * guard failing injection on a cold boot left ConcaveHR's pay-api
 * unthrottled (plan §3.5, write-up §8).
 */
@Injectable()
export class SecurityGuard implements CanActivate {
  constructor(
    /** The engine on the adapter, which runs the route stage. */
    @Inject(SecurityService) private readonly service: SecurityService,
    /** Reads the route's `@SecurityProfile()` and `@SkipSecurity()`. */
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  /** Runs the route stage for an HTTP request; passes any other context. */
  canActivate(context: ExecutionContext): Promise<boolean> | boolean {
    if (context.getType() !== "http") return true;
    const targets = [context.getHandler(), context.getClass()];
    const profile = this.reflector.getAllAndOverride<
      SecurityProfileMetadata | undefined
    >(SECURITY_PROFILE_METADATA, targets);
    const skip = this.reflector.getAllAndOverride<
      readonly string[] | undefined
    >(SKIP_SECURITY_METADATA, targets);
    const http = context.switchToHttp();
    const req = http.getRequest<BunRequest>();
    const res = http.getResponse<BunResponse>();
    return this.service
      .routeStage(req, res, profile, skip)
      .catch(async (error: unknown) => {
        // A challenge is answered with the flow's page or descriptor.
        throw error instanceof SecurityRefusalException
          ? await challengeRefusal(this.service.security, req, res, error)
          : error;
      });
  }
}
