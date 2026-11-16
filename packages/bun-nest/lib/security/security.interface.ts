/**
 * The options of `@kingsleyweb/bun-nest/security`'s `SecurityModule`.
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import type {
  CreateSecurityOptions,
  Security,
} from "@kingsleyweb/bun-security";
import type {
  CsrfGuard,
  CsrfOptions,
  RefusalOptions,
  ScrubMode,
  SecurityHeadersOptions,
} from "@kingsleyweb/bun-security/http";
import type {
  InjectionToken,
  ModuleMetadata,
  OptionalFactoryDependency,
} from "@nestjs/common";

/** Where the engine comes from: one made elsewhere, or `createSecurity`'s options. */
export type SecuritySource =
  | {
      /** An engine made elsewhere; the module neither builds nor closes it. */
      readonly security: Security<BunRequest>;
    }
  | CreateSecurityOptions<BunRequest>;

/** What the module does around the engine, beside where the engine comes from. */
export interface SecurityModuleSettings extends RefusalOptions {
  /**
   * The security headers (layers.md L13.1) on every answer the request's
   * handlers produce (a route's, Nest's not-found and exception answers):
   * their options, or `false` for none. Default on, with
   * `securityHeaders()`'s defaults.
   */
  readonly headers?: SecurityHeadersOptions | false;
  /**
   * The CSRF check (layers.md L13.2), run by `SecurityGuard` once the route
   * stage admits the request: its options, a guard from `csrf()`, or
   * `false` for none. Default on, with `csrf()`'s defaults (Fetch Metadata
   * and `Origin`, for requests carrying cookies).
   */
  readonly csrf?: CsrfOptions | CsrfGuard | false;
  /**
   * Replace a `5xx` answer whose buffered body carries a stack trace with a
   * bare problem+json (layers.md L13.3): `"production"` while `NODE_ENV` is
   * `production`, `"always"`, or `false`. Default `"production"`.
   */
  readonly scrub?: ScrubMode | false;
  /**
   * Run the boot self-test when the application bootstraps (plan §3.3,
   * D25): one marked request through the adapter, which the early stage
   * and the head middleware must see, and a check that `SecurityGuard` is
   * installed. Default `true`.
   */
  readonly selfTest?: boolean;
}

/** `SecurityModule.forRoot()`'s options: the engine's source and the settings. */
export type SecurityModuleOptions = SecuritySource &
  SecurityModuleSettings & {
    /**
     * Provide `SecurityGuard` as a global guard (`APP_GUARD`). Default
     * `true`; with `false`, apply it yourself (`@UseGuards(SecurityGuard)`
     * or your own `APP_GUARD`), which the self-test checks.
     */
    readonly globalGuard?: boolean;
    /** Make the module global, so `@InjectSecurity()` works in every module. Default `true`. */
    readonly isGlobal?: boolean;
  };

/** `SecurityModule.forRootAsync()`'s options. */
export interface SecurityModuleAsyncOptions extends Pick<
  ModuleMetadata,
  "imports"
> {
  /** Provide `SecurityGuard` as a global guard (`APP_GUARD`). Default `true`. */
  readonly globalGuard?: boolean;
  /** Make the module global. Default `true`. */
  readonly isGlobal?: boolean;
  /** Providers injected into {@link useFactory}. */
  readonly inject?: (InjectionToken | OptionalFactoryDependency)[];
  /** Builds the engine's source and the settings with whatever {@link inject} resolved. */
  readonly useFactory: (
    ...args: never[]
  ) =>
    | (SecuritySource & SecurityModuleSettings)
    | Promise<SecuritySource & SecurityModuleSettings>;
}

/** What `@SecurityProfile()` records on a route. */
export interface SecurityProfileMetadata {
  /** The profile's name. */
  readonly name: string;
  /** Whether the route takes cross-site requests on purpose (CSRF). */
  readonly crossSite: boolean;
}
