/**
 * multer 2.4's field-name limits (`fieldNestingDepth`,
 * `fieldArrayIndexLimit`) with platform-express 12.2's defaults, the three
 * codes that come with them, and the memory default for `storageType`.
 */
import type { MultiPartOptions, UploadOptions } from "../lib";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_FIELD_NAME_LIMITS,
  DiskStorage,
  handleMultipartAnyFiles,
  handleMultipartSingleFile,
  MemoryStorage,
  transformUploadOptions,
  UploadError,
} from "../lib";
import { makeRequest } from "./helpers";

type Part =
  | [name: string, value: string]
  | [name: string, file: Blob, filename: string];

/** A multipart request carrying `parts`, in order. */
function form(...parts: Part[]) {
  const fd = new FormData();
  for (const part of parts) {
    if (part.length === 3) {
      fd.append(part[0], part[1], part[2]);
    } else {
      fd.append(part[0], part[1]);
    }
  }
  return makeRequest({ method: "POST", body: fd });
}

/** What `getMultiParts(options)` settles to: its fields, or the refusal. */
async function parse(
  parts: Part[],
  options: MultiPartOptions = {},
): Promise<
  | { fields: Record<string, unknown>; files: string[] }
  | { code: string; field: string | undefined; message: string; status: number }
> {
  const req = await form(...parts);
  try {
    const result = await req.getMultiParts(options);
    return {
      fields: result.fields,
      files: [...result.files.values()].flatMap((paths) => [...paths]),
    };
  } catch (error) {
    expect(error).toBeInstanceOf(UploadError);
    const upload = error as UploadError;
    return {
      code: upload.code,
      field: upload.field,
      message: upload.message,
      status: upload.status,
    };
  }
}

const file = (name: string): Part => [name, new Blob(["x"]), "x.txt"];
/** Forces the event-driven parse: a file to sniff (`detectFileType` is on). */
const sniffed: Part = ["zz", new Blob(["x"]), "z.txt"];

describe("multipart field names: defaults (32 levels, index 1000)", () => {
  it("are platform-express 12.2's", () => {
    expect(DEFAULT_FIELD_NAME_LIMITS).toEqual({
      fieldNestingDepth: 32,
      fieldArrayIndexLimit: 1000,
    });
    expect(Object.isFrozen(DEFAULT_FIELD_NAME_LIMITS)).toBe(true);
  });

  it("refuse arr[4294967294] instead of building a 4294967295-long array", async () => {
    for (const extra of [[], [sniffed]] as Part[][]) {
      expect(await parse([["arr[4294967294]", "x"], ...extra])).toEqual({
        code: "LIMIT_FIELD_ARRAY_INDEX",
        field: "arr[4294967294]",
        message: "Field name array index too large",
        status: 400,
      });
    }
  });

  it("let index 1000 through and refuse 1001", async () => {
    const ok = await parse([["arr[1000]", "x"]]);
    expect("fields" in ok && (ok.fields.arr as unknown[]).length).toBe(1001);
    expect(await parse([["arr[1001]", "x"]])).toMatchObject({
      code: "LIMIT_FIELD_ARRAY_INDEX",
      field: "arr[1001]",
    });
  });

  it("let 32 levels through and refuse 33", async () => {
    const at = `a${"[b]".repeat(32)}`;
    const over = `a${"[b]".repeat(33)}`;
    expect(await parse([[at, "x"]])).toHaveProperty("fields");
    expect(await parse([[over, "x"]])).toEqual({
      code: "LIMIT_FIELD_NESTING",
      field: over,
      message: "Field name nesting too deep",
      status: 400,
    });
  });

  it("keep a repeated key an array however long it is", async () => {
    const parts: Part[] = Array.from({ length: 2500 }, (_, i) => [
      "tag",
      `t${i}`,
    ]);
    const result = await parse(parts);
    expect("fields" in result && result.fields.tag).toEqual(
      parts.map(([, value]) => value),
    );
  });

  it("apply to a parse made while the request was built, remembered for later calls", async () => {
    const req = await form(["arr[4294967294]", "x"]);
    await req.ready();
    expect(req.isFormDataParsed).toBe(false);
    const again = await req.getMultiParts({}).catch((error: unknown) => error);
    expect(again).toBeInstanceOf(UploadError);
    expect((again as UploadError).code).toBe("LIMIT_FIELD_ARRAY_INDEX");
  });

  it("can be lifted per call, which re-parses", async () => {
    const req = await form(["arr[5000]", "x"]);
    await expect(req.getMultiParts({})).rejects.toThrow(
      "Field name array index too large",
    );
    const lifted = await req.getMultiParts({
      limits: { fieldArrayIndexLimit: Infinity },
    });
    expect((lifted.fields.arr as unknown[]).length).toBe(5001);
  });
});

describe("multipart field names: multer's checks", () => {
  it("nesting counts each [ (a[b][c] has 2 levels), as multer", async () => {
    const limits = { fieldNestingDepth: 1 };
    for (const extra of [[], [sniffed]] as Part[][]) {
      expect(await parse([["a[b]", "1"], ...extra], { limits })).toHaveProperty(
        "fields",
      );
      expect(
        await parse([["a[b][c]", "1"], ...extra], { limits }),
      ).toMatchObject({ code: "LIMIT_FIELD_NESTING", field: "a[b][c]" });
    }
  });

  it("array index: any [digits] over the limit, as multer (arr[5] with 2)", async () => {
    const limits = { fieldArrayIndexLimit: 2 };
    expect(await parse([["arr[2]", "1"]], { limits })).toHaveProperty("fields");
    expect(await parse([["arr[5]", "1"]], { limits })).toMatchObject({
      code: "LIMIT_FIELD_ARRAY_INDEX",
      field: "arr[5]",
    });
    expect(await parse([["a[b][9][c]", "1"]], { limits })).toMatchObject({
      code: "LIMIT_FIELD_ARRAY_INDEX",
    });
    // Not an index: `[-1]`, `[x]`.
    expect(
      await parse(
        [
          ["a[-1]", "1"],
          ["a[x]", "2"],
        ],
        { limits },
      ),
    ).toHaveProperty("fields");
  });

  it("Infinity turns either check off", async () => {
    const limits = {
      fieldNestingDepth: Infinity,
      fieldArrayIndexLimit: Infinity,
    };
    const deep = `a${"[b]".repeat(40)}`;
    expect(
      await parse(
        [
          [deep, "1"],
          ["arr[2000]", "2"],
        ],
        { limits },
      ),
    ).toHaveProperty("fields");
  });

  it("checks nesting before the index, and fieldNameSize before both", async () => {
    expect(
      await parse([["a[b][9]", "1"]], {
        limits: { fieldNestingDepth: 1, fieldArrayIndexLimit: 2 },
      }),
    ).toMatchObject({ code: "LIMIT_FIELD_NESTING" });
    expect(
      await parse([["a[b][9]", "1"]], {
        limits: { fieldNameSize: 3, fieldNestingDepth: 1 },
      }),
    ).toMatchObject({ code: "LIMIT_FIELD_KEY", field: undefined });
  });

  it("refuses the first offending part in body order", async () => {
    expect(
      await parse([
        ["ok", "1"],
        ["x[2000]", "2"],
        [`y${"[b]".repeat(40)}`, "3"],
      ]),
    ).toMatchObject({ code: "LIMIT_FIELD_ARRAY_INDEX", field: "x[2000]" });
  });

  it("with inflate: false, the checks are multer's exactly", async () => {
    const options = {
      inflate: false,
      limits: { fieldNestingDepth: 1, fieldArrayIndexLimit: 2 },
    };
    // A `.` does not nest for multer, and `a[6]suffix` is a literal key to
    // append-field, so neither is refused.
    expect(
      await parse(
        [
          ["a.b.c", "1"],
          ["a[6]suffix", "2"],
        ],
        options,
      ),
    ).toEqual({
      fields: { "a.b.c": "1", "a[6]suffix": "2" },
      files: [],
    });
    expect(await parse([["a[b][c]", "1"]], options)).toMatchObject({
      code: "LIMIT_FIELD_NESTING",
    });
    expect(await parse([["a[6]", "1"]], options)).toMatchObject({
      code: "LIMIT_FIELD_ARRAY_INDEX",
    });
  });
});

describe("multipart field names: what the default inflator builds", () => {
  it("a . nests as a [ does, so it counts as a level", async () => {
    const limits = { fieldNestingDepth: 1 };
    expect(await parse([["a.b", "1"]], { limits })).toEqual({
      fields: { a: { b: "1" } },
      files: [],
    });
    expect(await parse([["a.b.c", "1"]], { limits })).toMatchObject({
      code: "LIMIT_FIELD_NESTING",
      field: "a.b.c",
    });
    // 5000 dots would otherwise nest 5000 levels.
    expect(await parse([[`a${".b".repeat(5000)}`, "1"]])).toMatchObject({
      code: "LIMIT_FIELD_NESTING",
    });
  });

  it("an index builds an array wherever it sits, so x[4294967294]suffix is refused", async () => {
    expect(await parse([["x[4294967294]suffix", "1"]])).toMatchObject({
      code: "LIMIT_FIELD_ARRAY_INDEX",
      field: "x[4294967294]suffix",
    });
  });

  it("a file's name is checked too: the default inflator nests files", async () => {
    expect(await parse([file("docs[5000]"), sniffed])).toMatchObject({
      code: "LIMIT_FIELD_ARRAY_INDEX",
      field: "docs[5000]",
    });
    expect(
      await parse([file("docs[5000]")], { detectFileType: false }),
    ).toMatchObject({ code: "LIMIT_FIELD_ARRAY_INDEX" });
    expect(
      await parse([file(`d${"[b]".repeat(33)}`)], { detectFileType: false }),
    ).toMatchObject({ code: "LIMIT_FIELD_NESTING" });
    // Within the limits it nests as before.
    expect(await parse([file("docs[passport]")])).toEqual({
      fields: {},
      files: ["[docs][passport]"],
    });
  });

  it("a file's name is not checked where nothing nests it, as multer checks none", async () => {
    expect(await parse([file("docs[5000]")], { inflate: false })).toEqual({
      fields: {},
      files: ["docs[5000]"],
    });
    expect(
      await parse([file("docs[5000]")], {
        fileInflator: async (name, bytes) => ({ [name]: bytes }),
      }),
    ).toEqual({ fields: {}, files: ["[docs[5000]]"] });
  });

  it("a custom fieldInflator gets multer's checks", async () => {
    const fieldInflator = async (name: string, value: string) => ({
      [name]: value,
    });
    expect(
      await parse([["a.b.c", "1"]], {
        fieldInflator,
        limits: { fieldNestingDepth: 1 },
      }),
    ).toEqual({ fields: { "a.b.c": "1" }, files: [] });
    expect(await parse([["arr[2000]", "1"]], { fieldInflator })).toMatchObject({
      code: "LIMIT_FIELD_ARRAY_INDEX",
    });
  });
});

describe("multipart field names: INVALID_FIELD_NAME", () => {
  it("is what a throwing fieldInflator refuses with, as multer when append-field throws", async () => {
    const boom = new Error("cannot place it");
    const req = await form(["a[b]", "1"], ["a[b]", "2"]);
    const error = await req
      .getMultiParts({
        fieldInflator: async () => {
          throw boom;
        },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UploadError);
    const upload = error as UploadError;
    expect([
      upload.code,
      upload.field,
      upload.message,
      upload.status,
      upload.cause,
    ]).toEqual(["INVALID_FIELD_NAME", "a[b]", "Invalid field name", 400, boom]);
  });
});

describe("multipart field names: limit validation", () => {
  it("refuses a limit that is not a non-negative integer or Infinity, with multer's message", async () => {
    for (const bad of [-1, 1.5, Number.NaN, "3"]) {
      const options = {
        limits: { fieldNestingDepth: bad },
      } as unknown as UploadOptions;
      expect(() => transformUploadOptions(options)).toThrow(
        new TypeError(
          "Expected limits.fieldNestingDepth to be a non-negative integer or Infinity",
        ),
      );
    }
    expect(() =>
      transformUploadOptions({ limits: { fieldArrayIndexLimit: -2 } }),
    ).toThrow(
      "Expected limits.fieldArrayIndexLimit to be a non-negative integer or Infinity",
    );
    // At parse time too, for options handed straight to getMultiParts.
    const req = await form(["a", "1"]);
    await expect(
      req.getMultiParts({ limits: { fieldArrayIndexLimit: -1 } }),
    ).rejects.toThrow(TypeError);
  });

  it("accepts 0, Infinity and unset", () => {
    for (const value of [0, Infinity, undefined, null]) {
      expect(() =>
        transformUploadOptions({
          limits: {
            fieldNestingDepth: value as number,
            fieldArrayIndexLimit: value as number,
          },
        }),
      ).not.toThrow();
    }
  });

  it("0 refuses any nesting and any index", async () => {
    const limits = { fieldNestingDepth: 0 };
    expect(await parse([["a", "1"]], { limits })).toHaveProperty("fields");
    expect(await parse([["a[b]", "1"]], { limits })).toMatchObject({
      code: "LIMIT_FIELD_NESTING",
    });
    expect(
      await parse([["a[1]", "1"]], { limits: { fieldArrayIndexLimit: 0 } }),
    ).toMatchObject({ code: "LIMIT_FIELD_ARRAY_INDEX" });
  });
});

describe("multipart field names: through the upload handlers", () => {
  it("refuse with the field named, so Nest renders `<message> - <field>`", async () => {
    const req = await form(["a[b][c]", "1"], file("avatar"));
    const error = await handleMultipartSingleFile(
      req,
      "avatar",
      transformUploadOptions({ limits: { fieldNestingDepth: 1 } }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UploadError);
    expect([(error as UploadError).code, (error as UploadError).field]).toEqual(
      ["LIMIT_FIELD_NESTING", "a[b][c]"],
    );
  });

  it("apply their defaults with options that set other limits", async () => {
    const req = await form(["arr[4294967294]", "1"]);
    await expect(
      handleMultipartAnyFiles(
        req,
        transformUploadOptions({ limits: { fileSize: 10 } }),
      ),
    ).rejects.toThrow("Field name array index too large");
  });
});

describe("transformUploadOptions: storageType defaults to memory (G15)", () => {
  it("multer-style options without storageType are kept in memory", async () => {
    for (const options of [
      { limits: { fileSize: 5 } },
      {},
      { storageType: undefined },
    ]) {
      const transformed = transformUploadOptions(options);
      expect(transformed.storage).toBeInstanceOf(MemoryStorage);
    }
    const req = await form(file("avatar"));
    const { file: stored } = await handleMultipartSingleFile(
      req,
      "avatar",
      transformUploadOptions({ limits: { fileSize: 5 } }),
    );
    expect(stored?.type).toBe("memory");
  });

  it("keeps removeAfter for the memory default", () => {
    const transformed = transformUploadOptions({ removeAfter: false });
    expect(transformed.storage.options).toEqual({
      removeAfter: false,
    });
  });

  it('multer\'s { dest } without storageType writes to disk there, as storageType: "disk"', async () => {
    const dest = await mkdtemp(join(tmpdir(), "bun-common-dest-"));
    try {
      const transformed = transformUploadOptions({
        dest,
        filename: "kept.txt",
        limits: { fileSize: 50 },
      });
      expect(transformed.storage).toBeInstanceOf(DiskStorage);
      expect(transformed.storageType).toBe("disk");
      expect(transformed.limits).toEqual({ fileSize: 50 });
      const { file: stored } = await handleMultipartSingleFile(
        await form(file("avatar")),
        "avatar",
        transformed,
      );
      // The other disk options apply: the fixed filename, in `dest`.
      expect([stored?.type, stored?.path]).toEqual([
        "disk",
        join(dest, "kept.txt"),
      ]);
      expect(await readdir(dest)).toEqual(["kept.txt"]);
      // The same options with storageType: "disk" build the same storage.
      const explicit = transformUploadOptions({
        storageType: "disk",
        dest,
        filename: "kept.txt",
      });
      expect([
        explicit.storage.options?.dest,
        explicit.storage.options?.filename,
      ]).toEqual([
        transformed.storage.options?.dest,
        transformed.storage.options?.filename,
      ]);
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  });

  it("refuses a multer storage engine without a storageType rather than ignore it", () => {
    const withStorage = {
      storage: { _handleFile() {}, _removeFile() {} },
    } as unknown as UploadOptions;
    expect(() => transformUploadOptions(withStorage)).toThrow(
      new TypeError(
        'Upload options with a storage need storageType "custom" (and a storage implementing handleFile/removeFile)',
      ),
    );
    // Beside a dest too: the engine is still what cannot run.
    expect(() =>
      transformUploadOptions({
        dest: "/tmp/x",
        storage: {},
      } as unknown as UploadOptions),
    ).toThrow(TypeError);
  });
});
