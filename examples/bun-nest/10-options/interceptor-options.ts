/**
 * Option tour: every upload interceptor, every argument each takes, every
 * `UploadOptions` field and `getMultipartRequest` — each asserted.
 *
 * ```bash
 * bun 10-options/interceptor-options.ts
 * ```
 *
 * A few things worth knowing before reading it:
 *
 * - The interceptors answer a bad upload — including every count limit and
 *   an over-long field — with a `BadRequestException` (400), and only a file
 *   over `limits.fileSize` with a `PayloadTooLargeException` (413), exactly
 *   as `@nestjs/platform-express` does. A global filter here only reshapes every
 *   error to `{ status, message }` — anything that is not an `HttpException`
 *   stays a 500 — so each check can name the error it expects.
 * - Two applications share one module. The first uses a default adapter, which
 *   parses multipart bodies while building the request. The second leaves
 *   `multipart` out of `request.parseBody.contentTypes`, so the interceptor
 *   parses the body itself — which is what makes busboy options apply.
 */
import type {
  BunRequest,
  BunResponse,
  DiskStorageFile,
  JsonValue,
  MemoryStorageFile,
  StorageFile,
  UploadOptions,
} from "@kingsleyweb/bun-common";
import type {
  ArgumentsHost,
  ExceptionFilter,
  ExecutionContext,
} from "@nestjs/common";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskStorage, UploadError } from "@kingsleyweb/bun-common";
import {
  AnyFilesInterceptor,
  BunHttpAdapter,
  FileFieldsInterceptor,
  FileInterceptor,
  FilesInterceptor,
  getMultipartRequest,
  NoFilesInterceptor,
  transformUploadException,
  UploadedFile,
  UploadedFiles,
} from "@kingsleyweb/bun-nest";
import {
  BadRequestException,
  Body,
  Catch,
  Controller,
  createParamDecorator,
  HttpCode,
  HttpException,
  MaxFileSizeValidator,
  Module,
  UploadedFile as NestUploadedFile,
  UploadedFiles as NestUploadedFiles,
  ParseFilePipe,
  PayloadTooLargeException,
  Post,
  UseInterceptors,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { step, title, waitFor } from "../shared/console";
import "reflect-metadata";

const scratch = await mkdtemp(join(tmpdir(), "bun-nest-interceptor-tour-"));
const diskDir = join(scratch, "disk");
const customDir = join(scratch, "custom");
const filteredDir = join(scratch, "filtered");

/** A real 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** What handlers report about a file. */
interface Summary {
  /** The form field it came in. */
  field: string;
  /** The client's file name. */
  name: string;
  /** The client's claimed content type. */
  claimed: string;
  /** The type detected from the bytes, or `null`. */
  detected: string | null;
  /** Size in bytes. */
  size: number;
  /** Which storage produced it. */
  storage: string;
}

/** Summarises a stored file. */
function summarise(file: StorageFile): Summary {
  return {
    field: file.fieldname,
    name: file.originalFilename,
    claimed: file.mimetype,
    detected: file.validatedMimeType?.mime ?? null,
    size: file.size,
    storage: (file as MemoryStorageFile | DiskStorageFile).type,
  };
}

/** The most recent memory file a handler saw, to observe its release. */
let lastMemoryFile: MemoryStorageFile | undefined;

/** What each `filter` call was given. */
const filterCalls: { path: string; name: string; detected: string | null }[] =
  [];

/** Answers every error with its status (500 unless an `HttpException`) and message. */
@Catch()
class MessageFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<BunResponse>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const message = error instanceof Error ? error.message : String(error);
    return res.status(status).json({ status, message });
  }
}

/** Whether `getMultipartRequest` answered the very request Nest holds. */
const SameRequest = createParamDecorator(
  (_data: undefined, context: ExecutionContext) => {
    const http = context.switchToHttp();
    return getMultipartRequest(http) === http.getRequest<BunRequest>();
  },
);

@Controller()
class TourController {
  @Post("multipart-only")
  @HttpCode(200)
  multipartOnly(@SameRequest() same: boolean) {
    return { same };
  }

  @Post("single")
  @HttpCode(200)
  @UseInterceptors(FileInterceptor("avatar"))
  single(
    @UploadedFile() file: MemoryStorageFile | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    lastMemoryFile = file;
    return {
      file: file ? summarise(file) : null,
      text: file?.buffer.toString() ?? null,
      body,
    };
  }

  @Post("files-default")
  @HttpCode(200)
  @UseInterceptors(FilesInterceptor("docs"))
  filesDefault(@UploadedFiles() files: StorageFile[]) {
    return { names: files.map((file) => file.originalFilename).sort() };
  }

  @Post("files-three")
  @HttpCode(200)
  @UseInterceptors(FilesInterceptor("docs", 3))
  filesThree(@UploadedFiles() files: StorageFile[]) {
    return { names: files.map((file) => file.originalFilename).sort() };
  }

  @Post("fields")
  @HttpCode(200)
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: "avatar" },
      { name: "documents", maxCount: 2 },
    ]),
  )
  fields(@UploadedFiles() files: Record<string, StorageFile[]>) {
    return Object.fromEntries(
      Object.entries(files).map(([field, list]) => {
        return [field, list.map((file) => file.originalFilename).sort()];
      }),
    );
  }

  @Post("any")
  @HttpCode(200)
  @UseInterceptors(AnyFilesInterceptor())
  any(
    @UploadedFiles() files: StorageFile[],
    @Body() body: Record<string, unknown>,
  ) {
    return {
      files: files
        .map((file) => `${file.fieldname}:${file.originalFilename}`)
        .sort(),
      body,
    };
  }

  @Post("none")
  @HttpCode(200)
  @UseInterceptors(NoFilesInterceptor())
  none(@Body() body: Record<string, unknown>) {
    return { body };
  }

  @Post("disk")
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor("report", { storageType: "disk", dest: diskDir }),
  )
  async disk(@UploadedFile() file: DiskStorageFile) {
    return {
      file: summarise(file),
      dest: file.dest,
      filename: file.filename,
      path: file.path,
      contents: await Bun.file(file.path).text(),
    };
  }

  @Post("custom")
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor("upload", {
      storageType: "custom",
      storage: new DiskStorage({
        dest: customDir,
        filename: () => "fixed-name.txt",
        removeAfter: true,
      }),
    }),
  )
  custom(@UploadedFile() file: DiskStorageFile) {
    return {
      filename: file.filename,
      path: file.path,
      existsWhileHandling: existsSync(file.path),
    };
  }

  @Post("filtered")
  @HttpCode(200)
  @UseInterceptors(
    FilesInterceptor("images", 5, {
      storageType: "memory",
      filter: (req, file) => {
        filterCalls.push({
          path: req.path,
          name: file.originalFilename,
          detected: file.validatedMimeType?.mime ?? null,
        });
        if (file.originalFilename.startsWith("drop-")) {
          return false;
        }
        if (file.originalFilename.startsWith("reject-")) {
          return `rejected ${file.originalFilename}`;
        }
        if (file.originalFilename.startsWith("throw-")) {
          throw new Error("the filter threw");
        }
        return true;
      },
    }),
  )
  filtered(@UploadedFiles() files: StorageFile[]) {
    return { names: files.map((file) => file.originalFilename).sort() };
  }

  @Post("filtered-disk")
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor("report", {
      storageType: "disk",
      dest: filteredDir,
      filter: () => "no reports today",
    }),
  )
  filteredDisk(@UploadedFile() file: StorageFile | undefined) {
    return { file: file ? summarise(file) : null };
  }

  @Post("limits")
  @HttpCode(200)
  @UseInterceptors(
    AnyFilesInterceptor({
      storageType: "memory",
      limits: { files: 2, fileSize: 4 },
    }),
  )
  limits(@UploadedFiles() files: StorageFile[]) {
    return { sizes: files.map((file) => file.size) };
  }

  @Post("inflated")
  @HttpCode(200)
  @UseInterceptors(NoFilesInterceptor())
  inflated(@Body() body: Record<string, unknown>) {
    return { body };
  }

  @Post("not-inflated")
  @HttpCode(200)
  @UseInterceptors(
    NoFilesInterceptor({ storageType: "memory", inflate: false }),
  )
  notInflated(@Body() body: Record<string, unknown>) {
    return { body };
  }

  @Post("field-inflator")
  @HttpCode(200)
  @UseInterceptors(
    NoFilesInterceptor({
      storageType: "memory",
      fieldInflator: async (name, value) => ({ [name]: value.toUpperCase() }),
    }),
  )
  fieldInflator(@Body() body: Record<string, unknown>) {
    return { body };
  }

  @Post("pipe")
  @HttpCode(200)
  @UseInterceptors(FileInterceptor("note"))
  pipe(
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 16 })],
      }),
    )
    file: StorageFile,
  ) {
    return { size: file.size };
  }
}

@Module({ controllers: [TourController] })
class TourModule {}

title("Option tour: upload interceptors and UploadOptions");

/** Builds and starts one application on `adapter`. */
async function start(adapter: BunHttpAdapter) {
  const app = await NestFactory.create(TourModule, adapter, {
    logger: false,
    abortOnError: false,
  });
  app.useGlobalFilters(new MessageFilter());
  await app.listen(0);
  return { app, url: await app.getUrl() };
}

const main = await start(new BunHttpAdapter());
const parsedByInterceptor = await start(
  new BunHttpAdapter(0, {
    request: {
      parseBody: { contentTypes: { json: true, urlencoded: true, text: true } },
    },
  }),
);

/** Builds a multipart body from `[field, value]` pairs; a `File` is a file part. */
function form(parts: [string, string | File][]): FormData {
  const data = new FormData();
  for (const [name, value] of parts) {
    data.append(name, value);
  }
  return data;
}

/** A small text file. */
function text(name: string, contents = "hello"): File {
  return new File([contents], name, { type: "text/plain" });
}

/** What a POST answered: the status and the parsed JSON body. */
interface Answer<T> {
  /** The HTTP status. */
  status: number;
  /** The JSON body. */
  body: T;
}

/** Posts `body` to `path` on the main app (or `base`) and reads the JSON answer. */
async function post<T = JsonValue>(
  path: string,
  body: FormData | string,
  base: string = main.url,
): Promise<Answer<T>> {
  const init: RequestInit =
    typeof body === "string"
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }
      : { method: "POST", body };
  const response = await fetch(`${base}${path}`, init);
  return { status: response.status, body: (await response.json()) as T };
}

/** Checks that a POST was refused with 400 and a message matching `pattern`. */
async function checkRefused(
  label: string,
  path: string,
  body: FormData | string,
  pattern: RegExp,
) {
  const answer = await post<{ message: string }>(path, body);
  check(
    label,
    answer.status === 400 && pattern.test(answer.body.message),
    answer,
  );
}

/* ------------------------------------------------------------------ */
step("getMultipartRequest(ctx)");
await checkRefused(
  "a non-multipart request is a 400 BadRequestException",
  "/multipart-only",
  JSON.stringify({ a: 1 }),
  /^Not a multipart request$/,
);
checkEqual(
  "a multipart request is returned as-is",
  (await post("/multipart-only", form([["a", "1"]]))).body,
  { same: true },
);

/* ------------------------------------------------------------------ */
step("FileInterceptor(fieldname, options?)");
{
  const answer = await post<{
    file: Summary;
    text: string;
    body: Record<string, JsonValue>;
  }>(
    "/single",
    form([
      ["avatar", text("hello.txt", "hi there")],
      ["name", "Ada"],
    ]),
  );
  checkEqual("the file in the named field is attached", answer.body.file, {
    field: "avatar",
    name: "hello.txt",
    claimed: "text/plain",
    detected: null,
    size: 8,
    storage: "memory",
  });
  checkEqual(
    "options omitted: memory storage, bytes in buffer",
    answer.body.text,
    "hi there",
  );
  checkEqual("other fields arrive in the body", answer.body.body, {
    name: "Ada",
  });

  const disguised = await post<{ file: Summary }>(
    "/single",
    form([["avatar", new File([PNG], "notes.txt", { type: "text/plain" })]]),
  );
  checkEqual(
    "validatedMimeType is detected from the bytes, not the claim",
    [disguised.body.file.claimed, disguised.body.file.detected],
    ["text/plain", "image/png"],
  );

  const noFile = await post<{ file: Summary | null }>(
    "/single",
    form([["name", "Ada"]]),
  );
  checkEqual("no file: @UploadedFile() is undefined", noFile.body.file, null);

  await checkRefused(
    "a file in another field is refused",
    "/single",
    form([["picture", text("a.txt")]]),
    /^Only Field avatar accept one file$/,
  );

  await post("/single", form([["avatar", text("release.txt")]]));
  let released = false;
  try {
    await waitFor("the buffer to be released", () => !lastMemoryFile?.buffer, {
      timeout: 2_000,
    });
    released = true;
  } catch {
    released = false;
  }
  check("a memory file's buffer is released after the handler", released);
}

/* ------------------------------------------------------------------ */
step("FilesInterceptor(fieldname, maxCount = 1, options?)");
checkEqual(
  "maxCount defaults to 1: one file",
  (await post("/files-default", form([["docs", text("1.txt")]]))).body,
  { names: ["1.txt"] },
);
await checkRefused(
  "maxCount defaults to 1: two files are refused",
  "/files-default",
  form([
    ["docs", text("1.txt")],
    ["docs", text("2.txt")],
  ]),
  /^Field docs accepts max 1 files$/,
);
checkEqual(
  "maxCount 3: three files",
  (
    await post(
      "/files-three",
      form([
        ["docs", text("1.txt")],
        ["docs", text("2.txt")],
        ["docs", text("3.txt")],
      ]),
    )
  ).body,
  { names: ["1.txt", "2.txt", "3.txt"] },
);
await checkRefused(
  "maxCount 3: four files are refused",
  "/files-three",
  form(Array.from({ length: 4 }, (_, i) => ["docs", text(`${i}.txt`)])),
  /^Field docs accepts max 3 files$/,
);
await checkRefused(
  "a file in another field is refused",
  "/files-three",
  form([["other", text("x.txt")]]),
  /^Only Field docs accept files$/,
);

/* ------------------------------------------------------------------ */
step("FileFieldsInterceptor(uploadFields, options?)");
checkEqual(
  "files are grouped by field",
  (
    await post(
      "/fields",
      form([
        ["avatar", text("a.png")],
        ["documents", text("1.txt")],
        ["documents", text("2.txt")],
      ]),
    )
  ).body,
  { avatar: ["a.png"], documents: ["1.txt", "2.txt"] },
);
await checkRefused(
  "a field's maxCount defaults to 1",
  "/fields",
  form([
    ["avatar", text("a.png")],
    ["avatar", text("b.png")],
  ]),
  /^Field avatar accepts max 1 files$/,
);
await checkRefused(
  "a field's maxCount is enforced",
  "/fields",
  form([
    ["documents", text("1.txt")],
    ["documents", text("2.txt")],
    ["documents", text("3.txt")],
  ]),
  /^Field documents accepts max 2 files$/,
);
await checkRefused(
  "an undeclared field is refused",
  "/fields",
  form([["cover", text("c.png")]]),
  /^Field cover doesn't accept files$/,
);

/* ------------------------------------------------------------------ */
step("AnyFilesInterceptor(options?)");
checkEqual(
  "collects files from every field",
  (
    await post(
      "/any",
      form([
        ["a", text("1.txt")],
        ["b", text("2.txt")],
        ["b", text("3.txt")],
        ["note", "hi"],
      ]),
    )
  ).body,
  { files: ["a:1.txt", "b:2.txt", "b:3.txt"], body: { note: "hi" } },
);
checkEqual(
  "no files: an empty list",
  (await post("/any", form([["note", "hi"]]))).body,
  { files: [], body: { note: "hi" } },
);

/* ------------------------------------------------------------------ */
step("NoFilesInterceptor(options?)");
checkEqual(
  "fields only: the body",
  (await post("/none", form([["name", "Ada"]]))).body,
  { body: { name: "Ada" } },
);
await checkRefused(
  "any file is refused",
  "/none",
  form([["attachment", text("x.txt")]]),
  /^File upload is not accepted$/,
);

/* ------------------------------------------------------------------ */
step("storageType: 'disk' — dest");
{
  const answer = await post<{
    file: Summary;
    dest: string;
    filename: string;
    path: string;
    contents: string;
  }>("/disk", form([["report", text("q3.csv", "q,revenue\nq3,1200\n")]]));
  checkEqual("the file is a disk file", answer.body.file.storage, "disk");
  checkEqual("written under dest", answer.body.dest, diskDir);
  checkEqual(
    "path is dest + filename",
    answer.body.path,
    join(diskDir, answer.body.filename),
  );
  check(
    "the stored filename is generated, not the client's",
    answer.body.filename !== "q3.csv",
    answer.body.filename,
  );
  checkEqual(
    "with the uploaded bytes",
    answer.body.contents,
    "q,revenue\nq3,1200\n",
  );
  check("disk files are kept by default", existsSync(answer.body.path));
}

/* ------------------------------------------------------------------ */
step("storageType: 'custom' — storage");
{
  const answer = await post<{
    filename: string;
    path: string;
    existsWhileHandling: boolean;
  }>("/custom", form([["upload", text("draft.txt")]]));
  checkEqual(
    "the storage names the file (DiskStorage filename)",
    answer.body.filename,
    "fixed-name.txt",
  );
  check(
    "the file exists while the handler runs",
    answer.body.existsWhileHandling,
  );
  let removed = false;
  try {
    await waitFor("removal", () => !existsSync(answer.body.path), {
      timeout: 2_000,
    });
    removed = true;
  } catch {
    removed = false;
  }
  check("DiskStorage removeAfter: true removes it after the handler", removed);

  await checkRejects(
    "custom without a storage throws when the interceptor is built",
    () => {
      const Interceptor = FileInterceptor("upload", {
        storageType: "custom",
      } as unknown as UploadOptions);
      return new Interceptor();
    },
    { message: /requires a storage handler/ },
  );
}

/* ------------------------------------------------------------------ */
step("filter");
{
  filterCalls.length = 0;
  const kept = await post(
    "/filtered",
    form([
      ["images", new File([PNG], "keep.png", { type: "image/png" })],
      ["images", text("drop-me.txt")],
    ]),
  );
  checkEqual("true accepts a file; false drops it silently", kept.body, {
    names: ["keep.png"],
  });
  checkEqual(
    "the filter is called with the request and each stored file",
    [...filterCalls].sort((a, b) => a.name.localeCompare(b.name)),
    [
      { path: "/filtered", name: "drop-me.txt", detected: null },
      { path: "/filtered", name: "keep.png", detected: "image/png" },
    ],
  );
  await checkRefused(
    "a string rejects the upload with that message",
    "/filtered",
    form([["images", text("reject-me.txt")]]),
    /^rejected reject-me\.txt$/,
  );
  // Passed on unchanged, as multer passes a `fileFilter` error on: not an
  // HttpException, so Nest answers it 500.
  checkEqual(
    "an error thrown by the filter rejects the upload, unchanged (500)",
    await post("/filtered", form([["images", text("throw-me.txt")]])),
    { status: 500, body: { status: 500, message: "the filter threw" } },
  );
  await checkRefused(
    "a rejected disk upload is refused",
    "/filtered-disk",
    form([["report", text("r.csv")]]),
    /^no reports today$/,
  );
  checkEqual(
    "…and its stored file is removed",
    existsSync(filteredDir) ? await readdir(filteredDir) : [],
    [],
  );
}

/* ------------------------------------------------------------------ */
step("busboy options, with the interceptor parsing the body");
{
  // As multer: a limit refuses the upload rather than truncating it. As
  // platform-express, only a file too large is a 413; a count limit is a 400.
  checkEqual(
    "within limits: every file is read",
    (
      await post<{ sizes: number[] }>(
        "/limits",
        form([
          ["a", text("1.txt", "123")],
          ["b", text("2.txt", "123")],
        ]),
        parsedByInterceptor.url,
      )
    ).body.sizes,
    [3, 3],
  );
  checkEqual(
    "limits.files: one file too many is a 400",
    await post(
      "/limits",
      form([
        ["a", text("1.txt", "123")],
        ["b", text("2.txt", "123")],
        ["c", text("3.txt", "123")],
      ]),
      parsedByInterceptor.url,
    ),
    { status: 400, body: { status: 400, message: "Too many files" } },
  );
  checkEqual(
    "limits.fileSize: a file too large is a 413, with multer's bare message",
    await post(
      "/limits",
      form([["a", text("1.txt", "123456789")]]),
      parsedByInterceptor.url,
    ),
    { status: 413, body: { status: 413, message: "File too large" } },
  );

  const fields = () => {
    return form([
      ["age", "36"],
      ["subscribed", "true"],
      ["meta", '{"plan":"pro"}'],
      ["name", "Ada"],
    ]);
  };
  checkEqual(
    "inflate (default true): numbers, booleans and JSON",
    (await post("/inflated", fields(), parsedByInterceptor.url)).body,
    { body: { age: 36, subscribed: true, meta: { plan: "pro" }, name: "Ada" } },
  );
  checkEqual(
    "inflate (default true): bracketed names nest",
    (
      await post(
        "/inflated",
        form([["address[city]", "London"]]),
        parsedByInterceptor.url,
      )
    ).body,
    { body: { address: { city: "London" } } },
  );
  checkEqual(
    "inflate: false keeps every value a string",
    (await post("/not-inflated", fields(), parsedByInterceptor.url)).body,
    {
      body: {
        age: "36",
        subscribed: "true",
        meta: '{"plan":"pro"}',
        name: "Ada",
      },
    },
  );
  checkEqual(
    "inflate: false keeps a bracketed name as-is",
    (
      await post(
        "/not-inflated",
        form([["address[city]", "London"]]),
        parsedByInterceptor.url,
      )
    ).body,
    { body: { "address[city]": "London" } },
  );
  checkEqual(
    "fieldInflator replaces the default inflation",
    (
      await post(
        "/field-inflator",
        form([["name", "Ada"]]),
        parsedByInterceptor.url,
      )
    ).body,
    { body: { name: "ADA" } },
  );
  checkEqual(
    "a repeated field becomes an array",
    (
      await post(
        "/not-inflated",
        form([
          ["tag", "a"],
          ["tag", "b"],
        ]),
        parsedByInterceptor.url,
      )
    ).body,
    { body: { tag: ["a", "b"] } },
  );
  checkEqual(
    "a repeated identical value is kept",
    (
      await post(
        "/not-inflated",
        form([
          ["tag", "x"],
          ["tag", "x"],
        ]),
        parsedByInterceptor.url,
      )
    ).body,
    { body: { tag: ["x", "x"] } },
  );
}

/* ------------------------------------------------------------------ */
step("busboy options on the default adapter");
checkEqual(
  "limits apply on the default adapter",
  (
    await post(
      "/limits",
      form([
        ["a", text("1.txt", "123")],
        ["b", text("2.txt", "123")],
        ["c", text("3.txt", "123")],
      ]),
    )
  ).status,
  400,
);

checkEqual(
  "inflate: false applies on the default adapter",
  (await post("/not-inflated", form([["age", "36"]]))).body,
  { body: { age: "36" } },
);

/* ------------------------------------------------------------------ */
step("transformUploadException(error): how upload errors are answered");
{
  const tooBig = transformUploadException(
    new UploadError("LIMIT_FILE_SIZE", { field: "avatar" }),
  );
  check(
    "a file too large is a 413 PayloadTooLargeException",
    tooBig instanceof PayloadTooLargeException,
    tooBig,
  );
  checkEqual(
    "…whose body carries the code and field (the message stays bare)",
    tooBig.getResponse(),
    {
      statusCode: 413,
      message: "File too large",
      code: "LIMIT_FILE_SIZE",
      field: "avatar",
    },
  );

  const tooMany = transformUploadException(new UploadError("LIMIT_FILE_COUNT"));
  check(
    "every other limit is a 400 BadRequestException, as platform-express",
    tooMany instanceof BadRequestException,
    tooMany,
  );
  checkEqual("…with a 400 body", tooMany.getResponse(), {
    statusCode: 400,
    message: "Too many files",
    code: "LIMIT_FILE_COUNT",
    field: undefined,
  });
  checkEqual(
    "bun-common's own UploadError.status stays 413 outside Nest",
    new UploadError("LIMIT_FILE_COUNT").status,
    413,
  );

  const unexpected = transformUploadException(
    new UploadError("LIMIT_UNEXPECTED_FILE", { field: "picture" }),
  );
  check(
    "anything else is a 400 BadRequestException",
    unexpected instanceof BadRequestException,
    unexpected,
  );
  checkEqual(
    "…with multer's message and the field, as platform-express",
    unexpected.message,
    "Unexpected field - picture",
  );

  const typeError = new TypeError("not an upload error");
  check(
    "any other error is passed on unchanged (Nest answers it 500)",
    transformUploadException(typeError) === typeError,
  );

  await checkRejects(
    "an unknown storageType throws a TypeError when the interceptor is built",
    () =>
      new (FileInterceptor("doc", {
        storageType: "cloud",
      } as unknown as UploadOptions))(),
    { name: "TypeError" },
  );
  await checkRejects(
    "…as does storageType 'custom' without a storage",
    () =>
      new (AnyFilesInterceptor({
        storageType: "custom",
      } as unknown as UploadOptions))(),
    { name: "TypeError" },
  );
}

/* ------------------------------------------------------------------ */
step("@UploadedFile / @UploadedFiles and file pipes");
check("UploadedFile is NestJS's decorator", UploadedFile === NestUploadedFile);
check(
  "UploadedFiles is NestJS's decorator",
  UploadedFiles === NestUploadedFiles,
);
checkEqual(
  "ParseFilePipe accepts a file its validators pass",
  (await post("/pipe", form([["note", text("n.txt", "short")]]))).body,
  { size: 5 },
);
await checkRefused(
  "ParseFilePipe refuses a file its validators fail",
  "/pipe",
  form([["note", text("n.txt", "x".repeat(64))]]),
  /expected size is less than 16/,
);
await checkRefused(
  "ParseFilePipe refuses a missing file (fileIsRequired)",
  "/pipe",
  form([["other", "field"]]),
  /File is required/,
);

await main.app.close();
await parsedByInterceptor.app.close();
await rm(scratch, { recursive: true, force: true });
summary();
