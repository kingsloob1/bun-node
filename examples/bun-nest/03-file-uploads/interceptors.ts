/**
 * File uploads: `FileInterceptor`, `FilesInterceptor`, `FileFieldsInterceptor`,
 * `AnyFilesInterceptor` and `NoFilesInterceptor`, with `@UploadedFile()` and
 * `@UploadedFiles()` — the `@nestjs/platform-express` API, on Bun.
 *
 * ```bash
 * bun 03-file-uploads/interceptors.ts
 * ```
 *
 * Worth knowing:
 *
 * - Import the interceptors from `@kingsleyweb/bun-nest`. `UploadedFile` and
 *   `UploadedFiles` are Nest's own decorators, re-exported for convenience.
 * - An uploaded file is a bun-common `StorageFile`: `fieldname`,
 *   `originalFilename`, `mimetype` (what the client claimed),
 *   `validatedMimeType` (what the bytes are), `size`, and a `buffer` or a
 *   `path` depending on the storage.
 * - Options are bun-common's `UploadOptions`: `storageType: "memory"` (the
 *   default), `"disk"` with a `dest`, or `"custom"` with any `Storage` — such
 *   as a `DiskStorage` with its own `filename` and `removeAfter`. `filter`
 *   accepts (`true`), silently drops (`false`) or rejects (a message) each
 *   file; busboy options such as `limits` are passed through.
 * - A memory file's buffer is released once the handler's result is emitted,
 *   so read it inside the handler.
 * - A bad upload (an unexpected field, a filter's rejection, a malformed body)
 *   is answered `400 Bad Request` with its message, as is every count limit;
 *   only a file over `limits.fileSize` is `413` — exactly as
 *   `@nestjs/platform-express` does, no exception filter needed.
 *   The body carries the error's `code` and `field` too. An error a filter or
 *   storage *throws* is passed on unchanged, so Nest answers it `500`.
 * - By default the adapter parses a multipart body while building the
 *   request, before any interceptor runs, so busboy options given to an
 *   interceptor (`limits`, `inflate`, …) are not applied. Leave `multipart`
 *   out of the adapter's `request.parseBody.contentTypes` and the interceptor
 *   parses the body itself, with its options — see the last section.
 */
import type {
  DiskStorageFile,
  MemoryStorageFile,
  StorageFile,
  UploadFilterHandler,
} from "@kingsleyweb/bun-common";
import type { ExecutionContext } from "@nestjs/common";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskStorage } from "@kingsleyweb/bun-common";
import {
  AnyFilesInterceptor,
  BunHttpAdapter,
  FileFieldsInterceptor,
  FileInterceptor,
  FilesInterceptor,
  getMultipartRequest,
  NoFilesInterceptor,
  UploadedFile,
  UploadedFiles,
} from "@kingsleyweb/bun-nest";
import {
  Body,
  Controller,
  createParamDecorator,
  HttpCode,
  MaxFileSizeValidator,
  Module,
  ParseFilePipe,
  Post,
  UseInterceptors,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { show, step, title, waitFor } from "../shared/console";
import "reflect-metadata";

/** Where disk uploads are written for this run. */
const scratch = await mkdtemp(join(tmpdir(), "bun-nest-uploads-"));
const reportsDir = join(scratch, "reports");
const scratchDir = join(scratch, "scratch");

/** A real 1×1 PNG, so magic-byte detection has something to find. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** What a handler reports about one uploaded file. */
function describe(file: StorageFile | undefined) {
  if (!file) {
    return null;
  }

  return {
    field: file.fieldname,
    name: file.originalFilename,
    claimed: file.mimetype,
    detected: file.validatedMimeType?.mime ?? null,
    size: file.size,
    storage: (file as MemoryStorageFile | DiskStorageFile).type,
  };
}

/** Accepts images only — judged by their bytes, not by what the client claims. */
const imagesOnly: UploadFilterHandler = (_req, file) => {
  const detected = file.validatedMimeType?.mime ?? "";
  return (
    detected.startsWith("image/") ||
    `${file.originalFilename} is not an image (${detected || "unrecognised bytes"})`
  );
};

/** The multipart boundary, through `getMultipartRequest` (400 for anything else). */
const MultipartBoundary = createParamDecorator(
  (_data: undefined, context: ExecutionContext) => {
    const req = getMultipartRequest(context.switchToHttp());
    return req.getHeader("content-type")?.split("boundary=")[1] ?? null;
  },
);

@Controller("uploads")
class UploadsController {
  /** One file, in memory, filtered by its detected type; other fields in `@Body()`. */
  @Post("avatar")
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor("avatar", { storageType: "memory", filter: imagesOnly }),
  )
  avatar(
    @UploadedFile() file: MemoryStorageFile | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    return {
      file: describe(file),
      firstBytes: file ? file.buffer.subarray(0, 4).toString("hex") : null,
      body,
    };
  }

  /** Up to three files from one field. */
  @Post("gallery")
  @HttpCode(200)
  @UseInterceptors(FilesInterceptor("photos", 3))
  gallery(@UploadedFiles() files: MemoryStorageFile[]) {
    return { count: files.length, files: files.map((file) => describe(file)) };
  }

  /** Several named fields, each with its own maximum. */
  @Post("profile")
  @HttpCode(200)
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: "avatar", maxCount: 1 },
      { name: "documents", maxCount: 2 },
    ]),
  )
  profile(
    @UploadedFiles() files: Record<string, StorageFile[]>,
    @Body() body: Record<string, unknown>,
  ) {
    return {
      avatar: (files.avatar ?? []).map((file) => file.originalFilename),
      documents: (files.documents ?? []).map((file) => file.originalFilename),
      body,
    };
  }

  /** Files from any field at all. */
  @Post("anything")
  @HttpCode(200)
  @UseInterceptors(AnyFilesInterceptor())
  anything(@UploadedFiles() files: StorageFile[]) {
    return files.map((file) => describe(file));
  }

  /** A multipart form with fields only. Values are inflated: numbers, booleans, JSON. */
  @Post("form")
  @HttpCode(200)
  @UseInterceptors(NoFilesInterceptor())
  form(
    @Body() body: Record<string, unknown>,
    @MultipartBoundary() boundary: string | null,
  ) {
    const types = Object.fromEntries(
      Object.entries(body).map(([key, value]) => {
        return [key, Array.isArray(value) ? "array" : typeof value];
      }),
    );
    return {
      body,
      types,
      boundary: boundary ? `${boundary.slice(0, 10)}…` : null,
    };
  }

  /** `storageType: "disk"` writes the file under `dest` with a generated name. */
  @Post("reports")
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor("report", { storageType: "disk", dest: reportsDir }),
  )
  async report(@UploadedFile() file: DiskStorageFile) {
    return {
      file: describe(file),
      filename: file.filename,
      inDest: file.dest === reportsDir,
      contents: await Bun.file(file.path).text(),
    };
  }

  /** `storageType: "custom"`: a `DiskStorage` that names files and removes them afterwards. */
  @Post("scratch")
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor("upload", {
      storageType: "custom",
      storage: new DiskStorage({
        dest: scratchDir,
        filename: (file) => `scratch-${file.filename}`,
        removeAfter: true,
      }),
    }),
  )
  scratch(@UploadedFile() file: DiskStorageFile) {
    return { path: file.path, existsWhileHandling: existsSync(file.path) };
  }

  /** Nest's `ParseFilePipe` validators work on these files too. */
  @Post("note")
  @HttpCode(200)
  @UseInterceptors(FileInterceptor("note"))
  note(
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 64 })],
      }),
    )
    file: MemoryStorageFile,
  ) {
    return { accepted: describe(file) };
  }
}

/** A bare controller: an upload error is already a 400 `BadRequestException`. */
@Controller("unfiltered")
class UnfilteredController {
  @Post("avatar")
  @HttpCode(200)
  @UseInterceptors(FileInterceptor("avatar"))
  avatar(@UploadedFile() file: StorageFile | undefined) {
    return describe(file);
  }
}

/** Busboy options: at most two files of at most 8 bytes, fields left as strings. */
@Controller("limited")
class LimitedController {
  @Post()
  @HttpCode(200)
  @UseInterceptors(
    AnyFilesInterceptor({
      storageType: "memory",
      limits: { files: 2, fileSize: 8 },
      inflate: false,
    }),
  )
  upload(
    @UploadedFiles() files: MemoryStorageFile[],
    @Body() body: Record<string, unknown>,
  ) {
    return {
      files: files.map((file) => ({
        name: file.originalFilename,
        size: file.size,
      })),
      body,
    };
  }
}

@Module({
  controllers: [UploadsController, UnfilteredController, LimitedController],
})
class UploadModule {}

title("File uploads with bun-nest's interceptors");

const app = await NestFactory.create(UploadModule, new BunHttpAdapter(), {
  logger: false,
  abortOnError: false,
});
await app.listen(0);
const url = await app.getUrl();
show("listening on", url);

/** Builds a multipart body from `[field, value]` pairs; a `File` is a file part. */
function form(parts: [string, string | File][]): FormData {
  const data = new FormData();
  for (const [name, value] of parts) {
    data.append(name, value);
  }
  return data;
}

/** Posts `body` to `path` on `base` and prints the status and JSON answer. */
async function upload(
  label: string,
  path: string,
  body: FormData | string,
  base: string = url,
) {
  const init: RequestInit =
    typeof body === "string"
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }
      : { method: "POST", body };
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  const answer = {
    status: response.status,
    body: text ? JSON.parse(text) : "",
  };
  show(label, answer);
  return answer;
}

const pixel = () => new File([PNG], "pixel.png", { type: "image/png" });
const textFile = (name: string, contents = "hello") => {
  return new File([contents], name, { type: "text/plain" });
};

/* ------------------------------------------------------------------ */
step("FileInterceptor(fieldname, options) + @UploadedFile()");
await upload(
  "a PNG and a text field",
  "/uploads/avatar",
  form([
    ["avatar", pixel()],
    ["name", "Ada"],
  ]),
);
await upload(
  "fields only — no file",
  "/uploads/avatar",
  form([["name", "Ada"]]),
);
await upload(
  "a text file claiming to be a PNG (filter)",
  "/uploads/avatar",
  form([
    ["avatar", new File(["not a png"], "fake.png", { type: "image/png" })],
  ]),
);
await upload(
  "a file in another field",
  "/uploads/avatar",
  form([["picture", pixel()]]),
);

/* ------------------------------------------------------------------ */
step("FilesInterceptor(fieldname, maxCount) + @UploadedFiles()");
await upload(
  "two photos",
  "/uploads/gallery",
  form([
    ["photos", pixel()],
    ["photos", textFile("caption.txt")],
  ]),
);
await upload(
  "four photos (maxCount 3)",
  "/uploads/gallery",
  form(
    Array.from({ length: 4 }, (_, index) => [
      "photos",
      textFile(`${index}.txt`),
    ]),
  ),
);
await upload(
  "a file in another field",
  "/uploads/gallery",
  form([["attachments", textFile("a.txt")]]),
);

/* ------------------------------------------------------------------ */
step("FileFieldsInterceptor([{ name, maxCount }])");
await upload(
  "an avatar and two documents",
  "/uploads/profile",
  form([
    ["avatar", pixel()],
    ["documents", textFile("cv.txt")],
    ["documents", textFile("cover-letter.txt")],
    ["displayName", "Ada L."],
  ]),
);
await upload(
  "three documents (maxCount 2)",
  "/uploads/profile",
  form([
    ["documents", textFile("1.txt")],
    ["documents", textFile("2.txt")],
    ["documents", textFile("3.txt")],
  ]),
);
await upload(
  "a field that was not declared",
  "/uploads/profile",
  form([["cover", pixel()]]),
);

/* ------------------------------------------------------------------ */
step("AnyFilesInterceptor()");
await upload(
  "files from three fields",
  "/uploads/anything",
  form([
    ["a", pixel()],
    ["b", textFile("b.txt")],
    ["c", textFile("c.txt")],
  ]),
);

/* ------------------------------------------------------------------ */
step("NoFilesInterceptor() and getMultipartRequest()");
await upload(
  "fields only",
  "/uploads/form",
  form([
    ["name", "Ada"],
    ["age", "36"],
    ["subscribed", "true"],
    ["tags", "math"],
    ["tags", "engines"],
    ["address[city]", "London"],
    ["meta", '{"plan":"pro"}'],
  ]),
);
await upload(
  "a form carrying a file",
  "/uploads/form",
  form([["attachment", textFile("x.txt")]]),
);
await upload("a JSON body", "/uploads/form", JSON.stringify({ name: "Ada" }));

/* ------------------------------------------------------------------ */
step('storageType: "disk" and storageType: "custom"');
await upload(
  "a report to disk",
  "/uploads/reports",
  form([["report", textFile("q3.csv", "quarter,revenue\nq3,1200\n")]]),
);
show("files left in dest (disk storage keeps them)", await readdir(reportsDir));

const scratched = await upload(
  "a scratch file (removeAfter: true)",
  "/uploads/scratch",
  form([["upload", textFile("draft.txt")]]),
);
const scratchPath = (scratched.body as { path: string }).path;
await waitFor("the scratch file to be removed", () => !existsSync(scratchPath));
show("…removed once the response was produced", !existsSync(scratchPath));

/* ------------------------------------------------------------------ */
step("ParseFilePipe with MaxFileSizeValidator");
await upload(
  "a 5-byte note",
  "/uploads/note",
  form([["note", textFile("n.txt")]]),
);
await upload(
  "a 100-byte note",
  "/uploads/note",
  form([["note", textFile("n.txt", "x".repeat(100))]]),
);

/* ------------------------------------------------------------------ */
step("Upload errors are 400 Bad Request, with no exception filter");
await upload(
  "a file in another field",
  "/unfiltered/avatar",
  form([["picture", pixel()]]),
);

/* ------------------------------------------------------------------ */
step("Busboy options: parsed by the interceptor, or by the adapter first");

/** Three 20-byte files and a numeric field. */
const limitedForm = () => {
  return form([
    ["one", textFile("1.txt", "x".repeat(20))],
    ["two", textFile("2.txt", "x".repeat(20))],
    ["three", textFile("3.txt", "x".repeat(20))],
    ["age", "36"],
  ]);
};

await upload(
  "default adapter — options not applied",
  "/limited",
  limitedForm(),
);

// Leave `multipart` out of the parsed content types: the adapter keeps the raw
// bytes and the interceptor parses them, with its own busboy options.
const interceptorParsed = new BunHttpAdapter(0, {
  request: {
    parseBody: { contentTypes: { json: true, urlencoded: true, text: true } },
  },
});
const second = await NestFactory.create(UploadModule, interceptorParsed, {
  logger: false,
  abortOnError: false,
});
await second.listen(0);
await upload(
  "multipart left to the interceptor — options applied",
  "/limited",
  limitedForm(),
  await second.getUrl(),
);

await second.close();
await app.close();
await rm(scratch, { recursive: true, force: true });
show("closed");
