import type { UploadOptions } from "@kingsleyweb/bun-common";
import { PayloadTooLargeError, UploadError } from "@kingsleyweb/bun-common";
import {
  BadRequestException,
  ForbiddenException,
  PayloadTooLargeException,
} from "@nestjs/common";
import { describe, expect, it } from "bun:test";
import { firstValueFrom } from "rxjs";
import {
  AnyFilesInterceptor,
  FileFieldsInterceptor,
  FileInterceptor,
  FilesInterceptor,
  getMultipartRequest,
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
