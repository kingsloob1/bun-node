/**
 * The zod module's format sweep (`../format.test.ts`): a document whose
 * schemas put each construct the zod emitter writes either side of the
 * 80-column line, where Prettier's layout choices change: a property's key
 * from one character to past the line (a short key never breaks after its
 * colon; a poorly breakable value moves whole; anything else stays while its
 * first line fits), `.check()` chains, literals short and long, regular
 * expressions, enums, nested optional unions, lazy references beside other
 * arguments, long component names and long route keys.
 */

/** A name of `width` characters, from `stem`. */
function named(stem: string, width: number): string {
  return `${stem}${"x".repeat(Math.max(0, width - stem.length))}`;
}

/** The value schemas swept, each placed under keys of every width. */
function values(width: number): Record<string, unknown>[] {
  return [
    { type: "string" },
    { type: "string", minLength: 1, maxLength: 10 * width },
    { type: "string", pattern: `^[a-z]{${width}}(?:-[0-9]+)?$` },
    { type: "string", format: "date-time" },
    { type: "string", format: "email", maxLength: 254 },
    { const: named("v", width) },
    { const: "on" },
    { enum: [named("a", width), named("b", width), "c"] },
    { type: "integer", minimum: 1, maximum: width * 1000, multipleOf: 5 },
    { type: "array", items: { type: "number" }, minItems: 1 },
    {
      type: "array",
      items: { $ref: "#/components/schemas/Base" },
      maxItems: width,
    },
    { anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] },
    {
      type: "object",
      additionalProperties: { $ref: "#/components/schemas/Base" },
    },
    {
      allOf: [
        { $ref: "#/components/schemas/Base" },
        {
          type: "object",
          properties: { [named("k", width)]: { type: "string" } },
        },
      ],
    },
    {
      type: "array",
      prefixItems: [{ type: "string" }, { enum: [named("t", width)] }],
    },
  ];
}

/** A document sweeping key widths, value shapes and name lengths. */
export function zodSweepDocument(): object {
  const schemas: Record<string, unknown> = {
    Base: { type: "object", properties: { id: { type: "string" } } },
  };
  const paths: Record<string, unknown> = {};
  for (const width of [
    1, 2, 3, 4, 5, 8, 12, 20, 30, 40, 50, 55, 58, 60, 62, 64, 66, 68, 70, 74,
  ]) {
    const properties: Record<string, unknown> = {};
    values(width).forEach((value, index) => {
      properties[named(`p${index}`, width)] = value;
    });
    schemas[named(`Object${width}`, Math.min(width, 60))] = {
      type: "object",
      properties,
      required: Object.keys(properties).filter((_, index) => index % 2 === 0),
    };
    paths[`/${named(`r${width}`, width)}/{id}`] = {
      post: {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: named("q", width),
            in: "query",
            schema: { type: "integer", minimum: 0 },
          },
        ],
        requestBody: {
          required: width % 2 === 0,
          content: {
            "application/json": {
              schema: {
                $ref: `#/components/schemas/${named(`Object${width}`, Math.min(width, 60))}`,
              },
            },
          },
        },
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: Object.fromEntries(
                    values(width).map((value, index) => [
                      named(`r${index}`, width),
                      value,
                    ]),
                  ),
                },
              },
            },
          },
          "204": { description: "none" },
          "400": {
            description: "text",
            content: { "text/plain": { schema: { type: "string" } } },
          },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "zod sweep", version: "1" },
    paths,
    components: { schemas },
  };
}
