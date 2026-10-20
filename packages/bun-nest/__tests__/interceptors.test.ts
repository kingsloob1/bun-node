import type { UploadErrorCode, UploadOptions } from "@kingsleyweb/bun-common";
import { createRequire } from "node:module";
import {
  MemoryStorage,
  PayloadTooLargeError,
  UPLOAD_ERROR_MESSAGES,
  UploadError,
} from "@kingsleyweb/bun-common";
import {
  BadRequestException,
  ForbiddenException,
  Logger,
  PayloadTooLargeException,
} from "@nestjs/common";
import { AbstractHttpAdapter } from "@nestjs/core/adapters/http-adapter.js";
import { describe, expect, it, spyOn } from "bun:test";
import { firstValueFrom, throwError } from "rxjs";
import {
  AnyFilesInterceptor,
  FileFieldsInterceptor,
  FileInterceptor,
  FilesInterceptor,
  getMultipartRequest,
  mergeUploadOptions,
  nestIsRejectedByPipes,
  NoFilesInterceptor,
  transformUploadException,
} from "../lib/interceptors";
import {
  makeCallHandler,
  makeExecutionContext,
  makeMultipartRequest,
} from "./helpers";

describe("getMultipartRequest", () => {
  it("returns the request for a multipart context", async () => {
    const req = await makeMultipartRequest((fd) => fd.set("a", "1"));
    const ctx = makeExecutionContext(req);
    expect(getMultipartRequest(ctx.switchToHttp())).toBe(req);
  });
});

describe("FileInterceptor", () => {
  it("attaches a single uploaded file to the request", async () => {
    const req = await makeMultipartRequest((fd) => {
      fd.set("avatar", new Blob(["bytes"]), "avatar.txt");
      fd.set("name", "kingsley");
    });
    const Interceptor = FileInterceptor("avatar", { storageType: "memory" });
    const result = await firstValueFrom(
      await new Interceptor().intercept(
        makeExecutionContext(req),
        makeCallHandler("done"),
      ),
    );

    expect(result).toBe("done");
    expect(req.storageFile).toBeDefined();
    expect((req.body as Record<string, unknown>).name).toBe("kingsley");
  });
});

describe("FilesInterceptor", () => {
  it("collects multiple files up to the limit", async () => {
    const req = await makeMultipartRequest((fd) => {
      fd.append("docs", new Blob(["1"]), "1.txt");
      fd.append("docs", new Blob(["2"]), "2.txt");
    });
    const Interceptor = FilesInterceptor("docs", 5, { storageType: "memory" });
    await firstValueFrom(
      await new Interceptor().intercept(
        makeExecutionContext(req),
        makeCallHandler(),
      ),
    );
    expect(Array.isArray(req.storageFiles)).toBe(true);
    expect((req.storageFiles as unknown[]).length).toBe(2);
  });
});

describe("AnyFilesInterceptor", () => {
  it("collects files from any field", async () => {
    const req = await makeMultipartRequest((fd) => {
      fd.set("a", new Blob(["x"]), "a.txt");
      fd.set("b", new Blob(["y"]), "b.txt");
    });
    const Interceptor = AnyFilesInterceptor({ storageType: "memory" });
    await firstValueFrom(
      await new Interceptor().intercept(
        makeExecutionContext(req),
        makeCallHandler(),
      ),
    );
    expect((req.storageFiles as unknown[]).length).toBe(2);
  });
});

describe("FileFieldsInterceptor", () => {
  it("groups files by declared field", async () => {
    const req = await makeMultipartRequest((fd) => {
      fd.set("avatar", new Blob(["x"]), "a.txt");
      fd.set("cover", new Blob(["y"]), "c.txt");
    });
    const Interceptor = FileFieldsInterceptor(
      [{ name: "avatar" }, { name: "cover" }],
      { storageType: "memory" },
    );
    await firstValueFrom(
      await new Interceptor().intercept(
        makeExecutionContext(req),
        makeCallHandler(),
      ),
    );
    const files = req.storageFiles as Record<string, unknown[]>;
    expect(files.avatar.length).toBe(1);
    expect(files.cover.length).toBe(1);
  });
});

describe("NoFilesInterceptor", () => {
  it("passes through field-only multipart requests", async () => {
    const req = await makeMultipartRequest((fd) => fd.set("name", "value"));
    const Interceptor = NoFilesInterceptor({ storageType: "memory" });
    const result = await firstValueFrom(
      await new Interceptor().intercept(
        makeExecutionContext(req),
        makeCallHandler("ok"),
      ),
    );
    expect(result).toBe("ok");
    expect((req.body as Record<string, unknown>).name).toBe("value");
  });

  it("rejects multipart requests that contain files", async () => {
    const req = await makeMultipartRequest((fd) => {
      fd.set("file", new Blob(["x"]), "x.txt");
    });
    const Interceptor = NoFilesInterceptor({ storageType: "memory" });
    await expect(
      new Interceptor().intercept(makeExecutionContext(req), makeCallHandler()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("removing an upload's files once the handler emits", () => {
  it("logs a storage whose removeFile rejects, rather than leaving an unhandled rejection", async () => {
    // Under Bun an unhandled rejection ends the process (and fails this run),
    // so the removal's rejection has to be caught where it is started.
    const failure = new Error("storage unavailable");
    class FailingRemoval extends MemoryStorage {
      override async removeFile(): Promise<void> {
        throw failure;
      }
    }
    const logged: unknown[][] = [];
    const errorSpy = spyOn(Logger.prototype, "error").mockImplementation(
      (...args: unknown[]) => {
        logged.push(args);
      },
    );
    try {
      const req = await makeMultipartRequest((fd) => {
        fd.set("doc", new Blob(["x"]), "x.txt");
      });
      const Interceptor = FileInterceptor("doc", {
        storageType: "custom",
        storage: new FailingRemoval(),
      });
      const result = await firstValueFrom(
        await new Interceptor().intercept(
          makeExecutionContext(req),
          makeCallHandler("done"),
        ),
      );

      // The response is not held for the removal.
      expect(result).toBe("done");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(logged).toEqual([
        ["Removing an upload's stored files failed", failure.stack],
      ]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("upload errors map to HTTP exceptions (as platform-express)", () => {
  it("rejects a file in an unexpected field with a 400 BadRequestException", async () => {
    const req = await makeMultipartRequest((fd) => {
      fd.set("picture", new Blob(["x"]), "x.txt");
    });
    const Interceptor = FileInterceptor("avatar", { storageType: "memory" });

    const error = await Promise.resolve(
      new Interceptor().intercept(makeExecutionContext(req), makeCallHandler()),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getStatus()).toBe(400);
    expect((error as BadRequestException).cause).toBeInstanceOf(Error);
  });

  it("maps a 413 error to PayloadTooLargeException", () => {
    const tooLarge = new PayloadTooLargeError(10, 20);
    const mapped = transformUploadException(tooLarge);

    expect(mapped).toBeInstanceOf(PayloadTooLargeException);
    expect(mapped.getStatus()).toBe(413);
  });

  it("keeps an HttpException as it is", () => {
    const forbidden = new ForbiddenException("nope");
    expect(transformUploadException(forbidden)).toBe(forbidden);
  });

  it("answers an unexpected field with its message as it is, the field, and the code", async () => {
    const req = await makeMultipartRequest((fd) => {
      fd.set("picture", new Blob(["x"]), "x.txt");
    });
    const Interceptor = FileInterceptor("avatar", { storageType: "memory" });

    const error = await Promise.resolve(
      new Interceptor().intercept(makeExecutionContext(req), makeCallHandler()),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BadRequestException);
    const cause = (error as BadRequestException).cause;
    expect(cause).toBeInstanceOf(UploadError);
    expect((error as BadRequestException).getResponse()).toEqual({
      statusCode: 400,
      // bun-common's own message already names the field; only multer's
      // default messages get ` - <field>` (see the per-code 400 tests).
      message: (cause as UploadError).message,
      code: "LIMIT_UNEXPECTED_FILE",
      field: "picture",
    });
  });

  it("rejects a count limit hit while intercepting with a 400, as platform-express", async () => {
    const req = await makeMultipartRequest((fd) => {
      fd.append("docs", new Blob(["a"]), "a.txt");
      fd.append("docs", new Blob(["b"]), "b.txt");
    });
    const Interceptor = AnyFilesInterceptor({
      storageType: "memory",
      limits: { files: 1 },
    });

    const error = await Promise.resolve(
      new Interceptor().intercept(makeExecutionContext(req), makeCallHandler()),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getStatus()).toBe(400);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      statusCode: 400,
      code: "LIMIT_FILE_COUNT",
    });
  });

  it("maps only LIMIT_FILE_SIZE to 413, with the bare message, as platform-express", () => {
    const tooBig = new UploadError("LIMIT_FILE_SIZE", { field: "avatar" });
    const mapped = transformUploadException(tooBig);

    expect(mapped).toBeInstanceOf(PayloadTooLargeException);
    expect(mapped.getStatus()).toBe(413);
    expect(mapped.cause).toBe(tooBig);
    // platform-express: `new PayloadTooLargeException(error.message)`, no field suffix.
    expect(mapped.getResponse()).toEqual({
      statusCode: 413,
      message: "File too large",
      code: "LIMIT_FILE_SIZE",
      field: "avatar",
    });
  });

  it.each([
    ["LIMIT_PART_COUNT", "Too many parts"],
    ["LIMIT_FILE_COUNT", "Too many files"],
    ["LIMIT_FIELD_KEY", "Field name too long"],
    ["LIMIT_FIELD_VALUE", "Field value too long"],
    ["LIMIT_FIELD_COUNT", "Too many fields"],
    ["LIMIT_UNEXPECTED_FILE", "Unexpected field"],
    ["MISSING_FIELD_NAME", "Field name missing"],
  ] as const)(
    "maps %s to 400 BadRequestException, as platform-express",
    (code, message) => {
      const error = new UploadError(code);
      // bun-common's own status is unchanged; only the Nest mapping differs.
      expect(error.status).toBe(
        code.startsWith("LIMIT_") && code !== "LIMIT_UNEXPECTED_FILE"
          ? 413
          : 400,
      );

      const mapped = transformUploadException(error);
      expect(mapped).toBeInstanceOf(BadRequestException);
      expect(mapped.getStatus()).toBe(400);
      expect(mapped.cause).toBe(error);
      expect(mapped.getResponse()).toEqual({
        statusCode: 400,
        message,
        code,
        field: undefined,
      });

      const withField = transformUploadException(
        new UploadError(code, { field: "doc" }),
      );
      expect(withField.getResponse()).toEqual({
        statusCode: 400,
        message: `${message} - doc`,
        code,
        field: "doc",
      });
    },
  );

  it("keeps a filter's rejection message as it is (not a multer code)", () => {
    const mapped = transformUploadException(
      new UploadError("FILTER_REJECTED", { field: "doc", message: "no pdfs" }),
    );

    expect(mapped).toBeInstanceOf(BadRequestException);
    expect(mapped.getResponse()).toEqual({
      statusCode: 400,
      message: "no pdfs",
      code: "FILTER_REJECTED",
      field: "doc",
    });
  });

  it("answers busboy's malformed-body errors 400, as platform-express", () => {
    const endOfForm = transformUploadException(
      new Error("Unexpected end of form"),
    );
    expect(endOfForm).toBeInstanceOf(BadRequestException);
    expect((endOfForm as BadRequestException).message).toBe(
      "Multipart: Unexpected end of form",
    );

    const boundary = transformUploadException(
      new Error("Multipart: Boundary not found"),
    );
    expect((boundary as BadRequestException).message).toBe(
      "Multipart: Boundary not found",
    );
  });

  it("passes any other error through unchanged, so Nest answers it 500", async () => {
    const typeError = new TypeError("bad");
    expect(transformUploadException(typeError)).toBe(typeError);

    const thrown = new Error("the filter threw");
    const req = await makeMultipartRequest((fd) => {
      fd.set("doc", new Blob(["x"]), "x.txt");
    });
    const Interceptor = FileInterceptor("doc", {
      storageType: "memory",
      filter: () => {
        throw thrown;
      },
    });
    const error = await Promise.resolve(
      new Interceptor().intercept(makeExecutionContext(req), makeCallHandler()),
    ).catch((caught: unknown) => caught);

    expect(error).toBe(thrown);
  });

  it("surfaces misconfigured storage as a TypeError when the interceptor is built", () => {
    const Unknown = FileInterceptor("doc", {
      storageType: "cloud",
    } as unknown as UploadOptions);
    expect(() => new Unknown()).toThrow(TypeError);

    const NoStorage = AnyFilesInterceptor({
      storageType: "custom",
    } as unknown as UploadOptions);
    expect(() => new NoStorage()).toThrow(TypeError);
  });
});

/** Nest 12 or later, by the capability the interceptors read (`mapException`). */
const NEST_12 =
  typeof (AbstractHttpAdapter.prototype as { mapException?: unknown })
    .mapException === "function";

/** Nest 12.2.0 or later, by the capability the interceptors read (`isRejectedByPipes`). */
const NEST_12_2 = nestIsRejectedByPipes() !== undefined;

/**
 * Whether bun-common raises multer 2.4's field-name codes (PR-7 of the Nest
 * 12 parity plan). Until it does, the tests that need bun-common to enforce
 * `fieldNestingDepth`/`fieldArrayIndexLimit` are skipped, visibly.
 */
const HAS_FIELD_NAME_CODES = "LIMIT_FIELD_NESTING" in UPLOAD_ERROR_MESSAGES;

/** multer 2.4.0's messages for its field-name codes (`lib/multer-error.js`). */
const FIELD_NAME_CODES = [
  ["LIMIT_FIELD_NESTING", "Field name nesting too deep"],
  ["LIMIT_FIELD_ARRAY_INDEX", "Field name array index too large"],
  ["INVALID_FIELD_NAME", "Invalid field name"],
] as const;

describe("mergeUploadOptions: module-level options under the interceptor's, as platform-express", () => {
  it("lets every key of the interceptor's options win", () => {
    expect(
      mergeUploadOptions(
        { storageType: "memory", inflate: false, detectFileType: false },
        { storageType: "disk", dest: "/tmp/x", inflate: true },
      ),
    ).toEqual({
      storageType: "disk",
      dest: "/tmp/x",
      inflate: true,
      detectFileType: false,
    });
  });

  it("merges limits key by key on Nest 12 (#17818), and replaces them whole on Nest 11", () => {
    const merged = mergeUploadOptions(
      { limits: { files: 1, fields: 3 } },
      { limits: { fileSize: 5, fields: 4 } },
    );
    expect(merged.limits).toEqual(
      NEST_12
        ? { files: 1, fields: 4, fileSize: 5 }
        : { fileSize: 5, fields: 4 },
    );
  });

  it("keeps the module's limits when the interceptor gives none, and drops them when it gives `undefined` (a spread)", () => {
    expect(
      mergeUploadOptions({ limits: { files: 1 } }, { inflate: false }).limits,
    ).toEqual({ files: 1 });
    expect(
      mergeUploadOptions({ limits: { files: 1 } }, { limits: undefined })
        .limits,
    ).toBeUndefined();
  });

  it("matches platform-express's own mergeMulterOptions where the installed one has it", () => {
    const utils = createRequire(import.meta.url)(
      "@nestjs/platform-express/multer/multer/multer.utils.js",
    ) as {
      mergeMulterOptions?: (
        a: Record<string, unknown>,
        b: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const module = { limits: { files: 1 }, inflate: false };
    const local = { limits: { fileSize: 9 } };
    const expected = utils.mergeMulterOptions?.(module, local) ?? {
      ...module,
      ...local,
    };
    const { storageType: _storageType, ...ours }: Record<string, unknown> = {
      ...mergeUploadOptions(module, local),
    };
    // Nest 12.0.0–12.0.3 merge shallowly in platform-express, key by key here.
    if (utils.mergeMulterOptions || !NEST_12) {
      expect(ours).toEqual(expected);
    }
  });

  it("chooses an absent storageType from dest (disk) or else memory; a storage needs storageType custom", () => {
    expect(mergeUploadOptions({ dest: "/tmp/x" }, {}).storageType).toBe("disk");
    expect(mergeUploadOptions(undefined, undefined).storageType).toBe("memory");
    // A multer-style options object without storageType builds.
    expect(
      () => new (FileInterceptor("f", { limits: { fileSize: 5 } }))(),
    ).not.toThrow();

    const storage = new MemoryStorage();
    // Key words only: the wording may be aligned with bun-common's later.
    expect(() => mergeUploadOptions({}, { storage })).toThrow(
      /storage\b.+storageType.*"custom"/,
    );
    expect(() => mergeUploadOptions({ storage }, { inflate: false })).toThrow(
      TypeError,
    );
    expect(() => new (FileInterceptor("f", { storage }))()).toThrow(TypeError);
    expect(
      mergeUploadOptions({}, { storageType: "custom", storage }).storageType,
    ).toBe("custom");
  });

  it("lets a route's dest replace the module's storage on Nest 12.2.0+ (e075cda3c); before, the module's storage shadows it", () => {
    const storage = new MemoryStorage();
    const fromCustom = mergeUploadOptions(
      { storageType: "custom", storage },
      { dest: "/tmp/route" },
    ) as unknown as Record<string, unknown>;
    const fromMemory = mergeUploadOptions(
      { storageType: "memory" },
      { dest: "/tmp/route" },
    );
    if (NEST_12_2) {
      expect(fromCustom.storageType).toBe("disk");
      expect(fromCustom.storage).toBeUndefined();
      expect(fromMemory.storageType).toBe("disk");
    } else {
      expect(fromCustom.storageType).toBe("custom");
      expect(fromCustom.storage).toBe(storage);
      expect(fromMemory.storageType).toBe("memory");
    }
    // A route naming its own storageType keeps it on every version.
    expect(
      mergeUploadOptions(
        { storageType: "custom", storage },
        // A `dest` the memory storage ignores, as plain JS may give one.
        { storageType: "memory", dest: "/tmp/route" } as never,
      ).storageType,
    ).toBe("memory");
  });

  it("is what each interceptor builds from its injected module options", async () => {
    const req = await makeMultipartRequest((fd) => {
      fd.append("f", new Blob(["a"]), "a.txt");
      fd.append("f", new Blob(["b"]), "b.txt");
    });
    const Interceptor = FilesInterceptor("f", 5, {
      limits: { fileSize: 1000 },
    });
    const run = new Interceptor({ limits: { files: 1 } }).intercept(
      makeExecutionContext(req),
      makeCallHandler(),
    );
    if (NEST_12) {
      const error = await Promise.resolve(run).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        message: "Too many files",
        code: "LIMIT_FILE_COUNT",
      });
    } else {
      await firstValueFrom(await run);
      expect((req.storageFiles as unknown[]).length).toBe(2);
    }
  });
});

describe("multer 2.4's field-name codes map as platform-express maps them (#17857)", () => {
  it.each(FIELD_NAME_CODES)(
    "maps %s to a 400 BadRequestException, never by bun-common's status",
    (code) => {
      const error = new UploadError(code as string as UploadErrorCode, {
        field: "a[b][c]",
      });
      const mapped = transformUploadException(error);
      expect(mapped).toBeInstanceOf(BadRequestException);
      expect(mapped.getStatus()).toBe(400);
      expect(mapped.cause).toBe(error);
      expect(mapped.getResponse()).toMatchObject({
        statusCode: 400,
        code,
        field: "a[b][c]",
      });
    },
  );

  it.skipIf(!HAS_FIELD_NAME_CODES).each(FIELD_NAME_CODES)(
    "renders %s as multer's message - field",
    (code, message) => {
      const mapped = transformUploadException(
        new UploadError(code as string as UploadErrorCode, { field: "arr[5]" }),
      );
      expect(mapped.getResponse()).toEqual({
        statusCode: 400,
        message: `${message} - arr[5]`,
        code,
        field: "arr[5]",
      });
    },
  );

  it("passes an UploadError whose code platform-express does not list through unchanged, so Nest answers it 500", () => {
    // multer's STREAM_DESTROYED, which platform-express leaves out on purpose.
    const error = new UploadError(
      "STREAM_DESTROYED" as string as UploadErrorCode,
    );
    // Typed codes all map; only plain JS reaches an unlisted one.
    expect(transformUploadException(error as unknown)).toBe(error);
  });

  it.skipIf(!HAS_FIELD_NAME_CODES)(
    "rejects a field nested deeper than limits.fieldNestingDepth, and an array index over fieldArrayIndexLimit",
    async () => {
      const Interceptor = AnyFilesInterceptor({
        limits: { fieldNestingDepth: 1, fieldArrayIndexLimit: 2 } as never,
      });
      for (const [name, message] of [
        ["a[b][c]", "Field name nesting too deep - a[b][c]"],
        ["arr[5]", "Field name array index too large - arr[5]"],
      ] as const) {
        const req = await makeMultipartRequest((fd) => fd.set(name, "1"));
        const error = await Promise.resolve(
          new Interceptor().intercept(
            makeExecutionContext(req),
            makeCallHandler(),
          ),
        ).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({
          statusCode: 400,
          message,
        });
      }
    },
  );
});

describe("files removed when a pipe rejects the request (Nest 12.2.0+, acb98de89)", () => {
  /** Core's own marker, on a Nest that has it; what a pipe's throw calls. */
  const markRejectedByPipes = NEST_12_2
    ? (
        createRequire(import.meta.url)(
          "@nestjs/core/router/rejected-by-pipes.js",
        ) as { markRejectedByPipes: (req: unknown) => void }
      ).markRejectedByPipes
    : undefined;

  /** A CallHandler whose stream fails, as a rejecting pipe makes it. */
  function failingHandler(error: Error) {
    return { handle: () => throwError(() => error) };
  }

  /** A storage recording each removal and its `force`. */
  class RecordingStorage extends MemoryStorage {
    removed: [string, boolean | undefined][] = [];
    override async removeFile(file: unknown, force?: boolean): Promise<void> {
      this.removed.push([(file as { fieldname: string }).fieldname, force]);
    }
  }

  async function runRejected(markRejected: boolean) {
    const storage = new RecordingStorage();
    const req = await makeMultipartRequest((fd) => {
      fd.set("doc", new Blob(["x"]), "x.txt");
    });
    const Interceptor = FileInterceptor("doc", {
      storageType: "custom",
      storage,
    });
    const rejection = new BadRequestException("Validation failed");
    if (markRejected) {
      markRejectedByPipes?.(req);
    }
    const error = await firstValueFrom(
      await new Interceptor().intercept(
        makeExecutionContext(req),
        failingHandler(rejection),
      ),
    ).catch((caught: unknown) => caught);
    // No response in this context: the removal runs a microtask later.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { error, rejection, removed: storage.removed };
  }

  it.skipIf(!NEST_12_2)(
    "removes the stored files with force, and rethrows the pipe's error unchanged",
    async () => {
      const { error, rejection, removed } = await runRejected(true);
      expect(error).toBe(rejection);
      expect(removed).toEqual([["doc", true]]);
    },
  );

  it("keeps the files when the handler itself fails (not a pipe), on every Nest", async () => {
    const { error, rejection, removed } = await runRejected(false);
    expect(error).toBe(rejection);
    expect(removed).toEqual([]);
  });
});
