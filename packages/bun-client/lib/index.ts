/**
 * `@kingsleyweb/bun-client`: a typed, dependency-free HTTP client for the
 * bun-node servers (typed-client plan, `docs/plans/typed-client/`, PR-C1).
 *
 * Browser-safe: this entry imports nothing at run time, and
 * `__tests__/bundleSafety.test.ts` proves a browser bundle of it carries
 * nothing of a server.
 */
export { createClient } from "./client";
export {
  ClientError,
  HttpError,
  NetworkError,
  TimeoutError,
  UnexpectedStatusError,
} from "./errors";
export type { Jsonify } from "./jsonify";
export type {
  AuthConfig,
  CallConfig,
  Client,
  ClientConfig,
  ClientFlags,
  ClientMiddleware,
  RequestContext,
  Result,
  RetryConfig,
  RouteConfig,
  RouteEntry,
  RouteManifest,
  RouteMap,
} from "./types";
