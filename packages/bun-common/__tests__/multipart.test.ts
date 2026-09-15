import type { Buffer } from "node:buffer";
import type {
  DiskStorageFile,
  DiskUploadOptions,
  MultiPartOptions,
  StorageFile,
  UploadErrorCode,
  UploadOptions,
} from "../lib";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  DiskStorage,
  getBusBoyConfig,
  handleMultipartAnyFiles,
  handleMultipartFileFields,
  handleMultipartMultipleFiles,
  handleMultipartSingleFile,
  handleNoFiles,
  MemoryStorage,
  transformUploadOptions,
  UPLOAD_ERROR_MESSAGES,
  UploadError,
  uploadFieldsToMap,
} from "../lib";
import { makeRequest } from "./helpers";

/** Runs `run`, expecting it to reject with an `UploadError`, and answers it. */
async function uploadRejection(
  run: () => Promise<unknown>,
): Promise<UploadError> {
  const caught = await run().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(UploadError);
  return caught as UploadError;
}

function multipartRequest(build: (fd: FormData) => void) {
  const fd = new FormData();
  build(fd);
  return makeRequest({ method: "POST", body: fd });
}

let tmp = "";
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bun-common-multipart-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("multipart: option transforms", () => {
  it("transformUploadOptions selects a memory storage by default", () => {
    const opts = transformUploadOptions();
    expect(opts.storage).toBeInstanceOf(MemoryStorage);
  });

  it("transformUploadOptions selects disk storage", () => {
    const opts = transformUploadOptions({ storageType: "disk" });
    expect(opts.storage).toBeInstanceOf(DiskStorage);
  });

  it("transformUploadOptions requires a storage for custom type", () => {
    expect(() =>
      transformUploadOptions({ storageType: "custom" } as never),
    ).toThrow();
  });

  it("getBusBoyConfig strips storage-specific keys", () => {
    const config = getBusBoyConfig(
      transformUploadOptions({ storageType: "memory" }),
    );
    expect("storageType" in config).toBe(false);
    expect("storage" in config).toBe(false);
  });

  it("uploadFieldsToMap builds a field/limit map", () => {
    const map = uploadFieldsToMap([
      { name: "avatar" },
      { name: "docs", maxCount: 5 },
    ]);
    expect(map.get("avatar")).toEqual({ maxCount: 1 });
    expect(map.get("docs")).toEqual({ maxCount: 5 });
  });
});

/** A fresh, empty directory under the suite's temp root. */
async function freshDir(name: string): Promise<string> {
  return mkdtemp(join(tmp, `${name}-`));
}

/** busboy's `limits`, as `getMultiParts` takes them. */
type BusboyLimits = NonNullable<MultiPartOptions["limits"]>;

/** A multipart request parsed, while it is built, with busboy `limits`. */
function limitedRequest(limits: BusboyLimits, build: (fd: FormData) => void) {
  const fd = new FormData();
  build(fd);
  return makeRequest({
    method: "POST",
    body: fd,
    options: {
      parseBody: { contentTypes: { multipart: { opts: { limits } } } },
    },
  });
}

describe("multipart: busboy limits reject the upload, as multer does", () => {
  const cases: {
    code: UploadErrorCode;
    field?: string;
    limits: BusboyLimits;
    build: (fd: FormData) => void;
  }[] = [
    {
      code: "LIMIT_PART_COUNT",
      limits: { parts: 1 },
      build: (fd) => {
        fd.append("a", "1");
        fd.append("b", "2");
      },
    },
    {
      code: "LIMIT_FILE_COUNT",
      limits: { files: 1 },
      build: (fd) => {
        fd.append("f", new File(["1"], "1.txt"));
        fd.append("f", new File(["2"], "2.txt"));
      },
    },
    {
      code: "LIMIT_FIELD_COUNT",
      limits: { fields: 1 },
      build: (fd) => {
        fd.append("a", "1");
        fd.append("b", "2");
      },
    },
    {
      code: "LIMIT_FILE_SIZE",
      field: "doc",
      limits: { fileSize: 4 },
      build: (fd) => fd.append("doc", new File(["0123456789"], "d.txt")),
    },
    {
      code: "LIMIT_FIELD_KEY",
      limits: { fieldNameSize: 3 },
      build: (fd) => fd.append("toolong", "1"),
    },
    {
      code: "LIMIT_FIELD_VALUE",
      field: "word",
      limits: { fieldSize: 3 },
      build: (fd) => fd.append("word", "abcdef"),
    },
  ];

  for (const { code, field, limits, build } of cases) {
    it(`${code}: a 413 UploadError, field ${String(field)}, never truncated data`, async () => {
      const req = await limitedRequest(limits, build);
      const error = await uploadRejection(() => req.getMultiParts({}));
      expect(error.code).toBe(code);
      expect(error.field).toBe(field);
      expect(error.status).toBe(413);
      expect(error.message).toBe(UPLOAD_ERROR_MESSAGES[code]);

      // The refusal is remembered: a handler asking again is refused too,
      // rather than re-parsing without the request's limits.
      const again = await uploadRejection(() =>
        handleMultipartAnyFiles(
          req,
          transformUploadOptions({ storageType: "memory" }),
        ),
      );
      expect(again.code).toBe(code);
    });
  }

  it("a body within every limit parses in full", async () => {
    // busboy refuses `files`/`fields` past the limit, so exactly that many
    // pass; sizes and `parts` are refused on reaching it (next test).
    const req = await limitedRequest(
      {
        parts: 4,
        files: 1,
        fields: 2,
        fileSize: 11,
        fieldSize: 4,
        fieldNameSize: 1,
      },
      (fd) => {
        fd.append("a", "abc");
        fd.append("b", "xyz");
        fd.append("d", new File(["0123456789"], "d.txt"));
      },
    );
    const { files, fields } = await req.getMultiParts({ inflate: false });
    expect(fields).toEqual({ a: "abc", b: "xyz" });
    expect([...files.keys()].map((file) => file.file.length)).toEqual([10]);
  });

  it("reaching parts, fileSize or fieldSize is refused, as busboy (and so multer) counts it", async () => {
    const atParts = await limitedRequest({ parts: 2 }, (fd) => {
      fd.append("a", "1");
      fd.append("b", "2");
    });
    expect((await uploadRejection(() => atParts.getMultiParts({}))).code).toBe(
      "LIMIT_PART_COUNT",
    );

    const atFileSize = await limitedRequest({ fileSize: 10 }, (fd) => {
      fd.append("d", new File(["0123456789"], "d.txt"));
    });
    expect(
      (await uploadRejection(() => atFileSize.getMultiParts({}))).code,
    ).toBe("LIMIT_FILE_SIZE");

    const atFieldSize = await limitedRequest({ fieldSize: 3 }, (fd) => {
      fd.append("a", "abc");
    });
    expect(
      (await uploadRejection(() => atFieldSize.getMultiParts({}))).code,
    ).toBe("LIMIT_FIELD_VALUE");
  });

  it("a file whose field name is over fieldNameSize is LIMIT_FIELD_KEY too", async () => {
    const req = await limitedRequest({ fieldNameSize: 3 }, (fd) => {
      fd.append("document", new File(["x"], "x.txt"));
    });
    const error = await uploadRejection(() => req.getMultiParts({}));
    expect([error.code, error.field]).toEqual(["LIMIT_FIELD_KEY", undefined]);
  });

  it("stored files are removed on a limit error", async () => {
    const dest = await freshDir("limit-cleanup");
    const req = await multipartRequest((fd) => {
      fd.append("docs", new File(["small"], "a.txt"));
      fd.append("docs", new File(["0123456789abcdef"], "b.txt"));
    });

    const error = await uploadRejection(() =>
      handleMultipartMultipleFiles(
        req,
        "docs",
        5,
        transformUploadOptions({
          storageType: "disk",
          dest,
          limits: { fileSize: 8 },
        }),
      ),
    );
    expect(error).toMatchObject({ code: "LIMIT_FILE_SIZE", field: "docs" });
    // The parse is refused before any file reaches storage, so the first,
    // in-limit file was never written either.
    expect(await readdir(dest)).toEqual([]);
  });
});

describe("multipart: UploadError", () => {
  it("answers 413 for size and count limits, 400 otherwise, with multer's messages", () => {
    const tooLarge: UploadErrorCode[] = [
      "LIMIT_PART_COUNT",
      "LIMIT_FILE_SIZE",
      "LIMIT_FILE_COUNT",
      "LIMIT_FIELD_KEY",
      "LIMIT_FIELD_VALUE",
      "LIMIT_FIELD_COUNT",
    ];
    const badRequest: UploadErrorCode[] = [
      "LIMIT_UNEXPECTED_FILE",
      "MISSING_FIELD_NAME",
      "FILTER_REJECTED",
    ];

    for (const code of tooLarge) {
      const error = new UploadError(code);
      expect([error.status, error.statusCode]).toEqual([413, 413]);
    }
    for (const code of badRequest) {
      const error = new UploadError(code);
      expect([error.status, error.statusCode]).toEqual([400, 400]);
    }

    const error = new UploadError("LIMIT_FILE_SIZE", { field: "avatar" });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("UploadError");
    expect(error.code).toBe("LIMIT_FILE_SIZE");
    expect(error.field).toBe("avatar");
    expect(error.expose).toBe(true);
    expect(error.message).toBe("File too large");
    expect(UPLOAD_ERROR_MESSAGES.LIMIT_UNEXPECTED_FILE).toBe(
      "Unexpected field",
    );

    const cause = new Error("disk full");
    const custom = new UploadError("FILTER_REJECTED", {
      message: "no PDFs",
      cause,
    });
    expect([custom.message, custom.field, custom.cause]).toEqual([
      "no PDFs",
      undefined,
      cause,
    ]);
  });

  it("single(): a file on a foreign field is LIMIT_UNEXPECTED_FILE naming that field", async () => {
    const req = await multipartRequest((fd) => {
      fd.set("cover", new Blob(["x"]), "c.txt");
    });
    const error = await uploadRejection(() =>
      handleMultipartSingleFile(req, "avatar", transformUploadOptions()),
    );
    expect([error.code, error.field, error.status, error.message]).toEqual([
      "LIMIT_UNEXPECTED_FILE",
      "cover",
      400,
      "Only Field avatar accept one file",
    ]);
  });

  it("single(): a second file on the field names the field itself", async () => {
    const req = await multipartRequest((fd) => {
      fd.append("avatar", new Blob(["1"]), "1.txt");
      fd.append("avatar", new Blob(["2"]), "2.txt");
    });
    const error = await uploadRejection(() =>
      handleMultipartSingleFile(req, "avatar", transformUploadOptions()),
    );
    expect([error.code, error.field]).toEqual([
      "LIMIT_UNEXPECTED_FILE",
      "avatar",
    ]);
  });

  it("array(): a foreign field and too many files are both LIMIT_UNEXPECTED_FILE", async () => {
    const foreign = await uploadRejection(async () =>
      handleMultipartMultipleFiles(
        await multipartRequest((fd) => {
          fd.append("photos", new Blob(["1"]), "1.txt");
          fd.append("cover", new Blob(["c"]), "c.txt");
        }),
        "photos",
        5,
        transformUploadOptions(),
      ),
    );
    expect([foreign.code, foreign.field, foreign.message]).toEqual([
      "LIMIT_UNEXPECTED_FILE",
      "cover",
      "Only Field photos accept files",
    ]);

    const tooMany = await uploadRejection(async () =>
      handleMultipartMultipleFiles(
        await multipartRequest((fd) => {
          for (const n of [1, 2, 3]) {
            fd.append("photos", new Blob([String(n)]), `${n}.txt`);
          }
        }),
        "photos",
        2,
        transformUploadOptions(),
      ),
    );
    expect([tooMany.code, tooMany.field, tooMany.message]).toEqual([
      "LIMIT_UNEXPECTED_FILE",
      "photos",
      "Field photos accepts max 2 files",
    ]);
  });

  it("fields(): an unmapped field and a field over its maxCount are LIMIT_UNEXPECTED_FILE", async () => {
    const map = uploadFieldsToMap([{ name: "avatar" }]);

    const unmapped = await uploadRejection(async () =>
      handleMultipartFileFields(
        await multipartRequest((fd) => {
          fd.set("resume", new Blob(["x"]), "cv.txt");
        }),
        map,
        transformUploadOptions(),
      ),
    );
    expect([unmapped.code, unmapped.field, unmapped.message]).toEqual([
      "LIMIT_UNEXPECTED_FILE",
      "resume",
      "Field resume doesn't accept files",
    ]);

    const overCount = await uploadRejection(async () =>
      handleMultipartFileFields(
        await multipartRequest((fd) => {
          fd.append("avatar", new Blob(["a"]), "a.txt");
          fd.append("avatar", new Blob(["b"]), "b.txt");
        }),
        map,
        transformUploadOptions(),
      ),
    );
    expect([overCount.code, overCount.field, overCount.message]).toEqual([
      "LIMIT_UNEXPECTED_FILE",
      "avatar",
      "Field avatar accepts max 1 files",
    ]);
  });

  it("none(): any file is LIMIT_UNEXPECTED_FILE naming its field", async () => {
    const req = await multipartRequest((fd) => {
      fd.set("doc", new Blob(["x"]), "x.txt");
    });
    const error = await uploadRejection(() =>
      handleNoFiles(req, transformUploadOptions()),
    );
    expect([error.code, error.field, error.message]).toEqual([
      "LIMIT_UNEXPECTED_FILE",
      "doc",
      "File upload is not accepted",
    ]);
  });

  it("filter: a string answer is FILTER_REJECTED; a thrown error passes through", async () => {
    const rejected = await uploadRejection(async () =>
      handleMultipartAnyFiles(
        await multipartRequest((fd) => {
          fd.set("doc", new Blob(["x"]), "x.txt");
        }),
        transformUploadOptions({
          storageType: "memory",
          filter: () => "not allowed",
        }),
      ),
    );
    expect([
      rejected.code,
      rejected.field,
      rejected.status,
      rejected.message,
    ]).toEqual(["FILTER_REJECTED", "doc", 400, "not allowed"]);

    const own = new RangeError("quota exceeded");
    const req = await multipartRequest((fd) => {
      fd.set("doc", new Blob(["x"]), "x.txt");
    });
    await expect(
      handleMultipartAnyFiles(
        req,
        transformUploadOptions({
          storageType: "memory",
          filter: () => {
            throw own;
          },
        }),
      ),
    ).rejects.toBe(own);
  });

  it("transformUploadOptions throws a TypeError for an unknown storageType", () => {
    // Plain JS can pass a storageType the types rule out.
    const fromJs = { storageType: "cloud" } as unknown as UploadOptions;
    expect(() => transformUploadOptions(fromJs)).toThrow(TypeError);
    expect(() => transformUploadOptions(fromJs)).toThrow(
      'Unknown upload storageType "cloud": expected "disk", "memory" or "custom"',
    );
  });

  it("transformUploadOptions throws a TypeError for custom without a storage", () => {
    const noStorage = { storageType: "custom" } as unknown as UploadOptions;
    expect(() => transformUploadOptions(noStorage)).toThrow(TypeError);
  });
});

describe("multipart: DiskUploadOptions", () => {
  it("accepts filename, removeAfter and function dest, and applies them", async () => {
    const dest = await freshDir("disk-options");
    const options: DiskUploadOptions = {
      storageType: "disk",
      dest: (file) => join(dest, file.fieldname),
      filename: (file) => `renamed-${file.filename}`,
      removeAfter: true,
    };
    const upload = transformUploadOptions(options);
    const req = await multipartRequest((fd) => {
      fd.set("doc", new Blob(["x"]), "a.txt");
    });

    const { files, removeAll } = await handleMultipartAnyFiles(req, upload);
    const file = files[0] as DiskStorageFile;
    expect(file.path).toBe(join(dest, "doc", "renamed-a.txt"));
    expect(await Bun.file(file.path).exists()).toBe(true);

    // removeAfter: true — removeAll() deletes without force.
    await removeAll();
    expect(await Bun.file(file.path).exists()).toBe(false);
  });

  it("keeps filename and removeAfter out of the busboy config", () => {
    const config = getBusBoyConfig(
      transformUploadOptions({
        storageType: "disk",
        dest: tmp,
        filename: "x.txt",
        removeAfter: true,
      }),
    );
    expect("filename" in config).toBe(false);
    expect("removeAfter" in config).toBe(false);
    expect("dest" in config).toBe(false);
  });
});

describe("multipart: filter", () => {
  it("removes a file the filter leaves out from disk", async () => {
    const dest = await freshDir("filter-false");
    const req = await multipartRequest((fd) => {
      fd.append("f", new Blob(["keep"]), "keep.txt");
      fd.append("f", new Blob(["drop"]), "drop.txt");
    });

    const { files } = await handleMultipartAnyFiles(
      req,
      transformUploadOptions({
        storageType: "disk",
        dest,
        filter: (_req, file) => file.originalFilename === "keep.txt",
      }),
    );

    expect(files.map((file) => file.originalFilename)).toEqual(["keep.txt"]);
    const onDisk = await readdir(dest);
    expect(onDisk).toEqual([(files[0] as DiskStorageFile).filename as string]);
  });
});

describe("multipart: handleMultipartAnyFiles", () => {
  it("collects files and fields with memory storage", async () => {
    const req = await multipartRequest((fd) => {
      fd.set("photo", new Blob(["image-bytes"]), "photo.txt");
      fd.set("name", "kingsley");
    });

    const { files, body } = await handleMultipartAnyFiles(
      req,
      transformUploadOptions({ storageType: "memory" }),
    );
    expect(files).toHaveLength(1);
    expect(files[0].fieldname).toBe("photo");
    expect(body.name).toBe("kingsley");
  });
});

describe("multipart: handleMultipartSingleFile", () => {
  it("accepts a single file on the named field", async () => {
    const req = await multipartRequest((fd) => {
      fd.set("avatar", new Blob(["a"]), "a.txt");
    });
    const { file } = await handleMultipartSingleFile(
      req,
      "avatar",
      transformUploadOptions({ storageType: "memory" }),
    );
    expect(file?.fieldname).toBe("avatar");
  });

  it("rejects more than one file on the field and stores none", async () => {
    const dest = await freshDir("single-two");
    const req = await multipartRequest((fd) => {
      fd.append("avatar", new Blob(["1"]), "1.txt");
      fd.append("avatar", new Blob(["2"]), "2.txt");
    });

    await expect(
      handleMultipartSingleFile(
        req,
        "avatar",
        transformUploadOptions({ storageType: "disk", dest }),
      ),
    ).rejects.toThrow("Only Field avatar accept one file");
    expect(await readdir(dest)).toEqual([]);
  });

  it("stores nothing when a foreign field comes alongside", async () => {
    const dest = await freshDir("single-foreign");
    const req = await multipartRequest((fd) => {
      fd.append("avatar", new Blob(["1"]), "1.txt");
      fd.append("other", new Blob(["2"]), "2.txt");
    });

    await expect(
      handleMultipartSingleFile(
        req,
        "avatar",
        transformUploadOptions({ storageType: "disk", dest }),
      ),
    ).rejects.toThrow("Only Field avatar accept one file");
    expect(await readdir(dest)).toEqual([]);
  });

  it("rejects files on a foreign field", async () => {
    const req = await multipartRequest((fd) => {
      fd.set("other", new Blob(["a"]), "a.txt");
    });
    await expect(
      handleMultipartSingleFile(
        req,
        "avatar",
        transformUploadOptions({ storageType: "memory" }),
      ),
    ).rejects.toThrow();
  });
});

describe("multipart: handleMultipartMultipleFiles", () => {
  it("enforces the max-count limit", async () => {
    const req = await multipartRequest((fd) => {
      fd.append("docs", new Blob(["1"]), "1.txt");
      fd.append("docs", new Blob(["2"]), "2.txt");
      fd.append("docs", new Blob(["3"]), "3.txt");
    });
    await expect(
      handleMultipartMultipleFiles(
        req,
        "docs",
        1,
        transformUploadOptions({ storageType: "memory" }),
      ),
    ).rejects.toThrow("max");
  });
});

describe("multipart: handleMultipartFileFields", () => {
  it("groups files by their field name", async () => {
    const req = await multipartRequest((fd) => {
      fd.set("avatar", new Blob(["a"]), "a.txt");
      fd.set("cover", new Blob(["c"]), "c.txt");
    });
    const { files } = await handleMultipartFileFields(
      req,
      uploadFieldsToMap([{ name: "avatar" }, { name: "cover" }]),
      transformUploadOptions({ storageType: "memory" }),
    );
    expect(files.avatar).toHaveLength(1);
    expect(files.cover).toHaveLength(1);
  });
});

describe("multipart: handleNoFiles", () => {
  it("passes when there are no files", async () => {
    const req = await multipartRequest((fd) => {
      fd.set("name", "value");
    });
    const { body } = await handleNoFiles(
      req,
      transformUploadOptions({ storageType: "memory" }),
    );
    expect(body.name).toBe("value");
  });

  it("rejects when files are present", async () => {
    const req = await multipartRequest((fd) => {
      fd.set("file", new Blob(["x"]), "x.txt");
    });
    await expect(
      handleNoFiles(req, transformUploadOptions({ storageType: "memory" })),
    ).rejects.toThrow("not accepted");
  });
});

describe("multipart: storage", () => {
  it("MemoryStorage exposes the buffer and can remove it", async () => {
    const req = await multipartRequest((fd) => {
      fd.set("file", new Blob(["payload"]), "f.txt");
    });
    const { files } = await handleMultipartAnyFiles(
      req,
      transformUploadOptions({ storageType: "memory" }),
    );
    const file = files[0] as unknown as { type: string; buffer?: Buffer };
    expect(file.type).toBe("memory");
    expect(file.buffer?.toString()).toBe("payload");

    await new MemoryStorage().removeFile(file);
    expect(file.buffer).toBeUndefined();
  });

  it("DiskStorage writes the file to disk and removes it", async () => {
    const req = await multipartRequest((fd) => {
      fd.set("file", new Blob(["disk-payload"]), "f.txt");
    });
    const options = transformUploadOptions({
      storageType: "disk",
      dest: tmp,
    });
    const { files } = await handleMultipartAnyFiles(req, options);
    const file = files[0] as unknown as { type: string; path: string };
    expect(file.type).toBe("disk");
    expect(await Bun.file(file.path).exists()).toBe(true);

    await (options.storage as DiskStorage).removeFile(file, true);
    expect(await Bun.file(file.path).exists()).toBe(false);
  });

  it("DiskStorage.removeFile resolves only once nested files are removed", async () => {
    const dest = await freshDir("nested-remove");
    const storage = new DiskStorage({ dest, removeAfter: true });
    const req = await multipartRequest((fd) => {
      fd.append("a", new Blob(["1"]), "1.txt");
      fd.append("b", new Blob(["2"]), "2.txt");
    });
    const { files } = await handleMultipartAnyFiles(
      req,
      transformUploadOptions({ storageType: "custom", storage }),
    );
    expect(await readdir(dest)).toHaveLength(2);

    await storage.removeFile({ nested: { list: files } });
    expect(await readdir(dest)).toEqual([]);
  });

  it("MemoryStorage honours removeAfter: false unless forced", async () => {
    const storage = new MemoryStorage({ removeAfter: false });
    const req = await multipartRequest((fd) => {
      fd.set("file", new Blob(["kept"]), "k.txt");
    });
    const { files } = await handleMultipartAnyFiles(
      req,
      transformUploadOptions({ storageType: "memory", removeAfter: false }),
    );
    const file = files[0] as StorageFile & { buffer?: Buffer };

    await storage.removeFile(file);
    expect(file.buffer).toBeDefined();
    await storage.removeFile({ holder: file }, true);
    expect(file.buffer).toBeUndefined();
  });

  it("MemoryStorage releases buffers by default, nested ones included", async () => {
    const storage = new MemoryStorage();
    const req = await multipartRequest((fd) => {
      fd.set("file", new Blob(["payload"]), "f.txt");
    });
    const { files } = await handleMultipartAnyFiles(
      req,
      transformUploadOptions({ storageType: "memory" }),
    );
    const file = files[0] as StorageFile & { buffer?: Buffer };
    await storage.removeFile({ holder: [file] });
    expect(file.buffer).toBeUndefined();
  });

  it("DiskStorage writes to dest even when __TESTS_TMP_PATH__ is set", async () => {
    const dest = await freshDir("env-dest");
    const hijack = await freshDir("env-hijack");
    const lib = join(import.meta.dir, "..", "lib", "index.ts");
    const script = `
      const { DiskStorage } = await import(${JSON.stringify(lib)});
      const storage = new DiskStorage({ dest: ${JSON.stringify(dest)} });
      const file = await storage.handleFile(
        { filename: "a.txt", encoding: "7bit", mimeType: "text/plain", fieldname: "f",
          originalFilename: "a.txt", validatedMimeType: undefined,
          file: Buffer.from("x"), type: "file" },
        {},
      );
      console.log(file.dest);
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      env: { ...process.env, __TESTS_TMP_PATH__: hijack },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out.trim()).toBe(dest);
    expect(await readdir(hijack)).toEqual([]);
  });
});

describe("multipart: BunRequest field parsing", () => {
  it("inflate: false keeps bracketed names and every value as a string", async () => {
    const req = await multipartRequest((fd) => {
      fd.append("address[city]", "London");
      fd.append("age", "36");
      fd.append("tag", "x");
      fd.append("tag", "x");
    });
    const { body } = await handleNoFiles(
      req,
      transformUploadOptions({ storageType: "memory", inflate: false }),
    );
    expect(body).toEqual({
      "address[city]": "London",
      age: "36",
      tag: ["x", "x"],
    });
  });

  it("keeps a repeated identical value with the default inflation", async () => {
    const req = await multipartRequest((fd) => {
      fd.append("tag", "x");
      fd.append("tag", "x");
      fd.append("address[city]", "London");
    });
    const { body } = await handleNoFiles(req, transformUploadOptions());
    expect(body).toEqual({ tag: ["x", "x"], address: { city: "London" } });
  });

  it("keeps a custom fieldInflator's bracketed keys", async () => {
    const req = await multipartRequest((fd) => {
      fd.append("address[city]", "London");
    });
    const { body } = await handleNoFiles(
      req,
      transformUploadOptions({
        storageType: "memory",
        fieldInflator: async (name, value) => ({
          [name.toUpperCase()]: value.toUpperCase(),
        }),
      }),
    );
    expect(body).toEqual({ "ADDRESS[CITY]": "LONDON" });
  });

  it("keeps a file whose custom fileInflator keys it with brackets", async () => {
    const req = await multipartRequest((fd) => {
      fd.append(
        "docs[passport]",
        new File(["p"], "p.txt", { type: "text/plain" }),
      );
    });
    const { files } = await handleMultipartAnyFiles(
      req,
      transformUploadOptions({
        storageType: "memory",
        fileInflator: async (name, file) => ({ [name]: file }),
      }),
    );
    expect(files.map((file) => file.fieldname)).toEqual(["docs[passport]"]);
  });

  it("applies busboy limits given per call, re-parsing the buffered body", async () => {
    const req = await multipartRequest((fd) => {
      for (const n of [1, 2, 3]) {
        fd.append(
          "f",
          new File([String(n)], `${n}.txt`, { type: "text/plain" }),
        );
      }
    });
    // Parsed unlimited while the request was built…
    expect((await req.getMultiParts({})).files.size).toBe(3);
    // …and refused, as multer does, once a call's limit applies — never
    // resolved with the extra files dropped.
    const error = await uploadRejection(() =>
      handleMultipartAnyFiles(
        req,
        transformUploadOptions({ storageType: "memory", limits: { files: 1 } }),
      ),
    );
    expect(error.code).toBe("LIMIT_FILE_COUNT");
  });

  it("returns the cached parse when the options change nothing", async () => {
    const req = await multipartRequest((fd) => fd.append("a", "1"));
    const first = await req.getMultiParts({});
    expect(await req.getMultiParts({ limits: {} })).toBe(first);
  });
});
