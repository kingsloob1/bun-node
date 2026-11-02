/**
 * `@kingsleyweb/bun-client`: a typed HTTP client for the bun-node servers
 * (typed-client plan, `docs/plans/typed-client/`, PR-C1, PR-C4).
 *
 * Browser-safe: this entry imports nothing at run time but its checks
 * module, loaded with `import()` only when a call validates (that module
 * brings `@kingsleyweb/bun-contract`'s guards). `__tests__/bundleSafety.test.ts`
 * proves a browser bundle of it carries nothing of a server, and its entry
 * chunk nothing of bun-contract.
 */
export { createClient } from "./client";
export {
  ClientError,
  HttpError,
  NetworkError,
  TimeoutError,
  UnexpectedStatusError,
  ValidationError,
} from "./errors";
export type { ValidationErrorIssue } from "./errors";
export type { Jsonify } from "./jsonify";
export type {
  AuthConfig,
  CallConfig,
  Client,
  ClientConfig,
  ClientFlags,
  ClientMiddleware,
  FailureMode,
  PartValidation,
  RequestContext,
  Result,
  RetryConfig,
  RouteConfig,
  RouteEntry,
  RouteManifest,
  RouteMap,
  RouteSchemas,
  SchemaSource,
  ValidationConfig,
} from "./types";
