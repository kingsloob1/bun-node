import { describe, expect, it } from "bun:test";
import {
  additionalFields,
  deref,
  refName,
  resolveRef,
  schemaChildren,
  schemaFacts,
  schemaSkeleton,
  typeLabel,
} from "../../../../app/screens/docs/schema";

/** A document with components, a cycle, a ref chain and an escaped name. */
const doc = {
  components: {
    schemas: {
      Job: {
        type: "object",
        properties: {
          id: { type: "string" },
          state: { $ref: "#/components/schemas/State" },
          parent: {
            anyOf: [{ $ref: "#/components/schemas/Job" }, { type: "null" }],
          },
        },
        required: ["id", "state"],
        additionalProperties: false,
      },
      State: { type: "string", enum: ["waiting", "active"] },
      Alias: { $ref: "#/components/schemas/State" },
      LoopA: { $ref: "#/components/schemas/LoopB" },
      LoopB: { $ref: "#/components/schemas/LoopA" },
      "a/b~c": { type: "integer" },
    },
  },
};

describe("resolveRef", () => {
  it("follows a local pointer into the document", () => {
    expect(resolveRef(doc, "#/components/schemas/State")).toEqual({
      type: "string",
      enum: ["waiting", "active"],
    });
    expect(resolveRef(doc, "#")).toBe(doc);
  });

  it("decodes ~1 and ~0 escapes and percent-encoding", () => {
    expect(resolveRef(doc, "#/components/schemas/a~1b~0c")).toEqual({
      type: "integer",
    });
    expect(resolveRef(doc, "#/components/schemas/a%7E1b~0c")).toEqual({
      type: "integer",
    });
    expect(refName("#/components/schemas/a~1b~0c")).toBe("a/b~c");
  });

  it("answers undefined for a missing target or a remote document", () => {
    expect(resolveRef(doc, "#/components/schemas/Nope")).toBeUndefined();
    expect(resolveRef(doc, "other.json#/x")).toBeUndefined();
    expect(
      resolveRef(doc, "#/components/schemas/Job/required/9"),
    ).toBeUndefined();
  });
});

describe("deref", () => {
  it("follows a chain of refs and records it", () => {
    const result = deref({ $ref: "#/components/schemas/Alias" }, doc);
    expect(result.refs).toEqual([
      "#/components/schemas/Alias",
      "#/components/schemas/State",
    ]);
    expect(result.schema).toEqual(doc.components.schemas.State);
    expect(result.cycle).toBe(false);
  });

  it("stops at a ref cycle instead of looping", () => {
    const result = deref({ $ref: "#/components/schemas/LoopA" }, doc);
    expect(result.cycle).toBe(true);
    expect(result.schema).toBeUndefined();
  });
});

describe("typeLabel", () => {
  it("reads types, arrays of types, null, nullable and items", () => {
    expect(typeLabel({ type: "string" }, doc)).toBe("string");
    expect(typeLabel({ type: ["integer", "null"] }, doc)).toBe(
      "integer | null",
    );
    expect(typeLabel({ type: "string", nullable: true }, doc)).toBe(
      "string | null",
    );
    expect(
      typeLabel(
        { type: "array", items: { $ref: "#/components/schemas/State" } },
        doc,
      ),
    ).toBe("array<State>");
    expect(typeLabel(true, doc)).toBe("any");
    expect(typeLabel(false, doc)).toBe("never");
  });

  it("shows an untyped enum or const by its values, and unions by their options", () => {
    expect(typeLabel({ enum: ["asc", "desc"] }, doc)).toBe('"asc" | "desc"');
    expect(typeLabel({ const: 3 }, doc)).toBe("3");
    expect(
      typeLabel({ anyOf: [{ type: "string" }, { type: "null" }] }, doc),
    ).toBe("string | null");
    expect(typeLabel({ oneOf: [{}, {}, {}, {}] }, doc)).toBe("oneOf(4)");
  });
});

describe("schemaFacts", () => {
  it("lists constraints, format, default, enum and examples", () => {
    const facts = schemaFacts({
      type: "integer",
      minimum: 1,
      maximum: 100,
      default: 20,
      format: "int32",
      examples: [5],
    });
    expect(facts.map((fact) => `${fact.label} ${fact.value}`)).toEqual([
      "format int32",
      "default 20",
      "min 1",
      "max 100",
      "examples 5",
    ]);
    expect(
      schemaFacts({ type: "string", enum: ["a", "b"], pattern: "^x$" }).map(
        (fact) => fact.key,
      ),
    ).toEqual(["enum", "pattern"]);
    // Untyped: the enum is the type label, not repeated as a fact.
    expect(schemaFacts({ enum: ["a"] })).toEqual([]);
  });
});

describe("additionalFields", () => {
  it("tells closed objects from open and typed ones", () => {
    expect(additionalFields({ additionalProperties: false })).toBe("closed");
    expect(additionalFields({ additionalProperties: {} })).toBe("any");
    expect(additionalFields({ additionalProperties: true })).toBe("any");
    expect(additionalFields({ additionalProperties: { type: "string" } })).toBe(
      "typed",
    );
    expect(additionalFields({ type: "object" })).toBeNull();
  });
});

describe("schemaChildren", () => {
  it("lists properties with their required flags, then alternatives", () => {
    const children = schemaChildren(doc.components.schemas.Job);
    expect(
      children.map((child) => [child.label, child.kind, child.required]),
    ).toEqual([
      ["id", "property", true],
      ["state", "property", true],
      ["parent", "property", false],
    ]);
    const options = schemaChildren(
      doc.components.schemas.Job.properties.parent,
    );
    expect(options.map((child) => [child.label, child.kind])).toEqual([
      ["Option 1", "anyOf"],
      ["Option 2", "anyOf"],
    ]);
  });

  it("expands arrays into items and typed extra fields", () => {
    expect(
      schemaChildren({ type: "array", items: { type: "string" } }).map(
        (child) => child.label,
      ),
    ).toEqual(["[]"]);
    expect(
      schemaChildren({ additionalProperties: { type: "string" } }).map(
        (child) => child.kind,
      ),
    ).toEqual(["additional"]);
  });
});

describe("schemaSkeleton", () => {
  it("fills only the required fields, preferring default, const and enum", () => {
    const body = {
      type: "object",
      properties: {
        state: { $ref: "#/components/schemas/State" },
        olderThan: { type: "integer", minimum: 0 },
        limit: { type: "integer", default: 1000 },
        tags: { type: "array", items: { type: "string" } },
        kind: { const: "x" },
        optional: { type: "string" },
      },
      required: ["state", "olderThan", "limit", "tags", "kind"],
    };
    expect(schemaSkeleton(body, doc)).toEqual({
      state: "waiting",
      olderThan: 0,
      limit: 1000,
      tags: [],
      kind: "x",
    });
  });

  it("takes a union's first non-null option and survives a recursive ref", () => {
    expect(
      schemaSkeleton({ anyOf: [{ type: "null" }, { type: "boolean" }] }, doc),
    ).toBe(false);
    const recursive = {
      components: {
        schemas: {
          Node: {
            type: "object",
            properties: { next: { $ref: "#/components/schemas/Node" } },
            required: ["next"],
          },
        },
      },
    };
    expect(
      schemaSkeleton({ $ref: "#/components/schemas/Node" }, recursive),
    ).toEqual({ next: null });
  });
});
