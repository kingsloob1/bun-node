/**
 * The generator's bodies beyond JSON (typed-client plan,
 * `other-transports.md` §3–§4, PR-C9), over documents from any server: a
 * multipart body's files found by `format: binary` or `contentMediaType`,
 * through `$ref` and `allOf`, their media types from `encoding`; an
 * urlencoded body's fields; NDJSON by `x-bun-chunks` or by media type, raw
 * chunks; and the zod module's `files` and line schemas. Each check has a
 * control.
 */
import { describe, expect, it } from "bun:test";
import { generateRoutes } from "../../lib/codegen/index";

/** A one-operation document. */
function documentOf(
  operation: Record<string, unknown>,
  components: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: { "/x": { post: { operationId: "x", ...operation } } },
    components: { schemas: components },
  };
}

/** The generated map and zod module for a document. */
function generate(document: Record<string, unknown>) {
  const result = generateRoutes(document, {
    zod: { flavour: "mini", routesModule: "./api.gen" },
  });
  return { code: result.code, zod: result.zod!.code };
}

const OK = { "200": { description: "ok" } };

describe("multipart bodies: fields and files", () => {
  it("splits an inline object (3.0's format: binary, 3.1's contentMediaType) and reads encoding", () => {
    const { code, zod } = generate(
      documentOf({
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  scan: {
                    type: "string",
                    format: "binary",
                    "x-bun-max-bytes": 10,
                  },
                  photo: { type: "string", contentMediaType: "image/png" },
                  pages: {
                    type: "array",
                    items: { type: "string", format: "binary" },
                    maxItems: 4,
                  },
                  // A base64 string in a part is text, not a file.
                  inline: {
                    type: "string",
                    contentMediaType: "image/png",
                    contentEncoding: "base64",
                  },
                },
                required: ["title", "scan"],
              },
              encoding: { scan: { contentType: "application/pdf, image/*" } },
            },
          },
        },
        responses: OK,
      }),
    );
    expect(code).toContain(`    body:
      | {
          title: string;
          inline?: string;
        }
      | FormData;
    files: {
      scan: Blob;
      photo?: Blob;
      pages?: Blob[];
    };`);
    expect(code).toContain(`bodyType: "multipart"`);
    // The wildcard leaves the scan's media types unchecked; the photo's
    // single contentMediaType is checked.
    expect(zod).toContain(`    files: z.looseObject({
      scan: z.file().check(z.maxSize(10)),
      photo: z.optional(z.file().check(z.mime(["image/png"]))),
      pages: z.optional(z.array(z.file()).check(z.maxLength(4))),
    }),`);
    expect(zod).toContain(`    body: z.looseObject({
      title: z.string(),
      inline: z.optional(z.string()),
    }),`);
  });

  it("follows a $ref, and keeps a fields $ref under allOf as it is", () => {
    const upload = {
      type: "object",
      properties: {
        name: { type: "string" },
        file: { type: "string", format: "binary" },
      },
      required: ["file"],
    };
    const fields = { type: "object", properties: { note: { type: "string" } } };
    const viaRef = generate(
      documentOf(
        {
          requestBody: {
            content: {
              "multipart/form-data": {
                schema: { $ref: "#/components/schemas/Upload" },
              },
            },
          },
          responses: OK,
        },
        { Upload: upload },
      ),
    );
    expect(viaRef.code).toContain(`    files: {
      file: Blob;
    };`);
    expect(viaRef.code).toContain(`name?: string;`);
    const viaAllOf = generate(
      documentOf(
        {
          requestBody: {
            content: {
              "multipart/form-data": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/Fields" },
                    {
                      type: "object",
                      properties: {
                        file: { type: "string", format: "binary" },
                      },
                      required: ["file"],
                    },
                  ],
                },
              },
            },
          },
          responses: OK,
        },
        { Fields: fields },
      ),
    );
    expect(viaAllOf.code).toContain(`    body: Fields | FormData | undefined;
    files: {
      file: Blob;
    };`);
  });

  it("types a files-only body undefined; control: a multipart body with no binary property has no files", () => {
    const filesOnly = generate(
      documentOf({
        requestBody: {
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: { file: { type: "string", format: "binary" } },
              },
            },
          },
        },
        responses: OK,
      }),
    );
    expect(filesOnly.code).toContain(`    body: FormData | undefined;
    files: {
      file?: Blob;
    };`);
    const plain = generate(
      documentOf({
        requestBody: {
          content: {
            "multipart/form-data": {
              schema: { type: "object", properties: { a: { type: "string" } } },
            },
          },
        },
        responses: OK,
      }),
    );
    expect(plain.code).not.toContain("files:");
  });

  it("types an urlencoded body's fields; control: with JSON beside it, no bodyType (JSON wins)", () => {
    const form = generate(
      documentOf({
        requestBody: {
          required: true,
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                properties: { user: { type: "string" } },
                required: ["user"],
              },
            },
          },
        },
        responses: OK,
      }),
    );
    expect(form.code).toContain(`bodyType: "urlencoded"`);
    expect(form.code).toContain(`    body:
      | {
          user: string;
        }
      | URLSearchParams;`);
    const both = generate(
      documentOf({
        requestBody: {
          content: {
            "application/json": { schema: { type: "object" } },
            "application/x-www-form-urlencoded": { schema: { type: "object" } },
          },
        },
        responses: OK,
      }),
    );
    expect(both.code).not.toContain("bodyType");
  });
});

describe("streamed responses", () => {
  /** A document whose 200 is `content`. */
  const streaming = (content: Record<string, unknown>) =>
    generate(
      documentOf({ responses: { "200": { description: "s", content } } }),
    );

  it("x-bun-chunks ndjson, an NDJSON media type and x-bun-chunks raw", () => {
    const line = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    };
    const marked = streaming({
      "application/x-ndjson": { schema: { ...line, "x-bun-chunks": "ndjson" } },
    });
    expect(marked.code).toContain(`      200: AsyncIterable<{
        n: number;
      }>;`);
    expect(marked.code).toContain(`chunks: { 200: "ndjson" }`);
    expect(marked.zod).toContain(`    responses: {
      200: z.looseObject({
        n: z.number(),
      }),
    },`);
    const byType = streaming({ "application/jsonl": { schema: line } });
    expect(byType.code).toContain("AsyncIterable<{");
    expect(byType.code).toContain(`chunks: { 200: "ndjson" }`);
    const raw = streaming({
      "application/octet-stream": { schema: { "x-bun-chunks": "raw" } },
    });
    expect(raw.code).toContain("200: AsyncIterable<Uint8Array>;");
    expect(raw.code).toContain(`chunks: { 200: "raw" }`);
    expect(raw.zod).not.toContain("responses");
  });

  it("control: an unmarked binary or JSON body is not a stream", () => {
    const binary = streaming({ "application/octet-stream": {} });
    expect(binary.code).toContain("200: Blob;");
    expect(binary.code).not.toContain("chunks");
    const json = streaming({
      "application/json": { schema: { type: "number" } },
    });
    expect(json.code).toContain("200: number;");
    expect(json.code).not.toContain("chunks");
  });
});
