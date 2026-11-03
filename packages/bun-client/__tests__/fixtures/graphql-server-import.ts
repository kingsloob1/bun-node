/**
 * The `./graphql` bundle-safety check's negative control: the GraphQL
 * entry beside a value from bun-common, which a browser bundle must never
 * carry. Built by `bundleSafety.test.ts`, never imported by a test.
 */
import { BunRouter } from "@kingsleyweb/bun-common";
import { createGraphQLClient } from "../../lib/graphql";

export const router = new BunRouter();
export { createGraphQLClient };
