/**
 * The example application's controllers: a public page, a sign-in marked
 * with its profile, a health check the route stage skips, and a page that
 * reads the engine's decision through `@InjectSecurity()`.
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import type { Security } from "@kingsleyweb/bun-security";
import { requestSecurity } from "@kingsleyweb/bun-security/http";
import {
  InjectSecurity,
  SecurityProfile,
  SkipSecurity,
} from "@kingsleyweb/bun-nest/security";
import { Controller, Get, Post, Req } from "@nestjs/common";

@Controller()
export class AppController {
  /**
   * @param security The engine `SecurityModule` created, injected for
   * `explain()` and `signal()`.
   */
  constructor(
    @InjectSecurity() private readonly security: Security<BunRequest>,
  ) {}

  /** `GET /`: a public page. */
  @Get()
  home(): string {
    return "home";
  }

  /** `GET /health`: never stopped by the route stage (the early stage still runs). */
  @Get("health")
  @SkipSecurity()
  health(): string {
    return "ok";
  }

  /** `POST /login`: marked `login`, so the sign-in presets count here. */
  @Post("login")
  @SecurityProfile("login")
  login(@Req() req: BunRequest): { profile: string | null } {
    return { profile: requestSecurity(req)?.profile ?? null };
  }

  /** `GET /why`: how the engine resolved this request's client, from `explain()`. */
  @Get("why")
  async why(@Req() req: BunRequest): Promise<{ client: string | undefined }> {
    const facts = requestSecurity(req)?.facts;
    if (facts === undefined) return { client: undefined };
    const explanation = await this.security.explain(facts);
    return { client: explanation.client.address };
  }
}
