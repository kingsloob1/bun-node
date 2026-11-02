/**
 * The format test's sweep (`../format.test.ts`): a document whose schemas,
 * keys and names sit either side of the 80-column line, where Prettier's
 * layout choices change.
 */

/** `n` string literals of `width` characters each. */
function literals(n: number, width: number): string[] {
  return Array.from({ length: n }, (_, i) =>
    `${String.fromCharCode(97 + (i % 26))}${i}`.padEnd(width, "x"),
  );
}

/** A document whose schemas and keys sweep the widths around the line's end. */
export function sweepDocument(): object {
  const schemas: Record<string, unknown> = {};
  const paths: Record<string, unknown> = {};
  for (let width = 4; width <= 30; width += 1) {
    for (const count of [2, 3, 4]) {
      const values = literals(count, width);
      const name = `S${width}x${count}`;
      schemas[`Alias${name}`] = { enum: values };
      schemas[`Object${name}`] = {
        type: "object",
        properties: {
          [`prop${"p".repeat(width % 13)}`]: { enum: values },
          list: { type: "array", items: { enum: values } },
          map: { type: "object", additionalProperties: { enum: values } },
          pair: {
            type: "array",
            prefixItems: [{ type: "string" }, { enum: values }],
            items: false,
          },
          both: {
            allOf: [{ $ref: "#/components/schemas/Base" }, { enum: values }],
          },
          either: {
            anyOf: [
              {
                allOf: [
                  { $ref: "#/components/schemas/Base" },
                  { type: "object", properties: { x: { type: "string" } } },
                ],
              },
              { type: "null" },
            ],
          },
          nullableList: {
            type: "array",
            items: {
              anyOf: [
                { type: "object", properties: { v: { enum: values } } },
                { type: "null" },
              ],
            },
          },
        },
        required: ["list"],
      };
      paths[`/sweep/${"segment".repeat(width % 9)}/${name}/{id}`] = {
        get: {
          operationId: `get${name}${"Long".repeat(width % 7)}`,
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { enum: values },
            },
          ],
          responses: Object.fromEntries(
            [200, 201, 202, 203, 204, 206, 400, 401, 403, 404, 409, 422]
              .slice(0, 2 + (width % 10))
              .map((status) => [
                String(status),
                {
                  description: "x",
                  content: {
                    "application/json": {
                      schema: { $ref: `#/components/schemas/Object${name}` },
                    },
                  },
                },
              ]),
          ),
          "x-bun-cache": { tags: literals(count, width) },
        },
      };
    }
  }
  schemas.Base = { type: "object", properties: { id: { type: "string" } } };
  return {
    openapi: "3.1.0",
    info: { title: "sweep", version: "1" },
    paths,
    components: { schemas },
  };
}
