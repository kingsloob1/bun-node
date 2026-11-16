/**
 * `@kingsleyweb/bun-nest/security`: bun-security on a Nest application
 * (plan §3.5). Needs `@kingsleyweb/bun-security` (an optional peer of
 * bun-nest, needed by this subpath only).
 *
 * ```ts
 * @Module({ imports: [SecurityModule.forRoot({ policy, identify })] })
 * export class AppModule {}
 *
 * @Post("login") @SecurityProfile("login") login() {}
 * ```
 */
export {
  BUN_SECURITY,
  BUN_SECURITY_OPTIONS,
  SECURITY_PROFILE_METADATA,
  SKIP_SECURITY_METADATA,
} from "./security.constants";
export {
  InjectSecurity,
  SecurityProfile,
  SkipSecurity,
} from "./security.decorator";
export { SecurityChallengeException } from "./security.challenge";
export { SecurityRefusalException } from "./security.exception";
export { SecurityGuard } from "./security.guard";
export type {
  SecurityModuleAsyncOptions,
  SecurityModuleOptions,
  SecurityModuleSettings,
  SecurityProfileMetadata,
  SecuritySource,
} from "./security.interface";
export { SecurityModule } from "./security.module";
export { SECURITY_SELF_TEST_PATH, SecurityService } from "./security.service";
