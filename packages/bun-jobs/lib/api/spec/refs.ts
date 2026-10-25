// Moved to bun-common in AD (a) (plan `docs/plans/api-docs-generation/` §6.1);
// kept as a re-export so no import site or test moves.
export {
  collectRefs,
  danglingRefs,
  pruneSchemaComponents,
  resolveRef,
  SCHEMA_REF_PREFIX,
} from "@kingsleyweb/bun-common/lib/docs/refs";
