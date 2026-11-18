/**
 * The policy's JSON Schema, read from the management API's OpenAPI document
 * (its `SecurityPolicy` component, PR-AN2) once a session.
 */
import type { SchemaNode } from "./schema";
import { useQuery } from "@tanstack/react-query";
import { useSecurityClient } from "../../context";
import { isObject } from "./paths";
import { POLICY_COMPONENT } from "./schema";

/** The policy's JSON Schema from `GET /openapi.json`, read once a session. */
export function usePolicySchema() {
  const { client } = useSecurityClient();
  return useQuery({
    queryKey: ["openapi", "policy-schema"],
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async ({ signal }): Promise<SchemaNode> => {
      const answer = await client.get("/openapi.json", { signal });
      const document = answer.ok ? answer.data : undefined;
      const schemas = isObject(document)
        ? (document.components as { schemas?: unknown } | undefined)?.schemas
        : undefined;
      const component = isObject(schemas)
        ? schemas[POLICY_COMPONENT]
        : undefined;
      if (!isObject(component)) {
        throw new Error(
          `the API's OpenAPI document has no ${POLICY_COMPONENT} component`,
        );
      }
      return component;
    },
  });
}
