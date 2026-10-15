/**
 * Item 8: uploads — platform-express (multer 2.4) interceptors vs bun-nest's,
 * error mapping by code, limits merge (#17818), field nesting/array index
 * (#18074), ParseFilePipe/FileTypeValidator (file-type, overrideMimeType #17333,
 * metacharacters #17435).
 */
import * as common from "@nestjs/common";
import { Body, Controller, Module, ParseFilePipe, Post, UploadedFile, UploadedFiles, UseInterceptors } from "@nestjs/common";
import { build, kind, runCases, snap } from "./harness";

const C12 = common as any;
const lib: any = kind === "bun" ? await import("@kingsleyweb/bun-nest") : await import("@nestjs/platform-express");
const { FileInterceptor, FilesInterceptor, AnyFilesInterceptor } = lib;
const MulterModule = (await import("@nestjs/platform-express")).MulterModule; // express-only module options
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a1a9b3d40000000049454e44ae426082", "hex");
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');

/** bun-nest's interceptors need `storageType` beside multer's options (a multer-style object alone throws). */
const o = (x: any) => (kind === "bun" ? { storageType: "memory", ...x } : x);
let multerStyleOptionsThrow: string = "no throw";
try {
  new (FileInterceptor("file", { limits: { fileSize: 5 } }))();
} catch (e) {
  multerStyleOptionsThrow = String(e);
}
const shape = (f: any) =>
  f && { fieldname: f.fieldname, originalname: f.originalname, mimetype: f.mimetype, size: f.size, hasBuffer: Buffer.isBuffer(f.buffer), encoding: f.encoding, keys: Object.keys(f).sort() };

@Controller("u")
class C {
  @Post("single")
  @UseInterceptors(FileInterceptor("file"))
  single(@UploadedFile() file: any, @Body() body: any) {
    return { file: shape(file), body };
  }
  @Post("small")
  @UseInterceptors(FileInterceptor("file", o({ limits: { fileSize: 5 } })))
  small(@UploadedFile() file: any) {
    return shape(file);
  }
  @Post("merged")
  @UseInterceptors(FilesInterceptor("f", 5, o({ limits: { fileSize: 1000 } })))
  merged(@UploadedFiles() files: any[]) {
    return { count: files?.length };
  }
  @Post("nesting")
  @UseInterceptors(AnyFilesInterceptor(o({ limits: { fieldNestingDepth: 1, fieldArrayIndexLimit: 2 } })))
  nesting(@Body() body: any) {
    return body;
  }
  @Post("nested-default")
  @UseInterceptors(AnyFilesInterceptor())
  nestedDefault(@Body() body: any) {
    return body;
  }
  @Post("png")
  @UseInterceptors(FileInterceptor("file"))
  png(@UploadedFile(new ParseFilePipe({ validators: [new C12.FileTypeValidator({ fileType: "image/png", overrideMimeType: true } as any)] })) file: any) {
    return shape(file);
  }
  @Post("svg")
  @UseInterceptors(FileInterceptor("file"))
  svg(@UploadedFile(new ParseFilePipe({ validators: [new C12.FileTypeValidator({ fileType: "image/svg+xml", skipMagicNumbersValidation: true } as any)] })) file: any) {
    return shape(file);
  }
}
@Module({ imports: [MulterModule.register({ limits: { files: 1 } })], controllers: [C] })
class M {}

function form(parts: [string, string | Blob, string?][]) {
  const fd = new FormData();
  for (const [k, v, name] of parts) {
    if (typeof v === "string") fd.append(k, v);
    else fd.append(k, v, name);
  }
  return fd;
}
const blob = (s: string | Buffer, type = "text/plain") => new Blob([s], { type });

await runCases("08-uploads", {
  all: async () => {
    const b = await build(M, {});
    const post = async (path: string, fd: FormData) => snap(await b.request(`/u/${path}`, { method: "POST", body: fd }));
    try {
      const r: Record<string, unknown> = { multerStyleOptionsThrow };
      r.single = await post("single", form([["title", "t"], ["file", blob("hello"), "h.txt"]]));
      r.unexpectedField = await post("single", form([["other", blob("hello"), "h.txt"]]));
      r.tooLarge = await post("small", form([["file", blob("hello world"), "h.txt"]]));
      r.mergedLimitsTwoFiles = await post("merged", form([["f", blob("a"), "a.txt"], ["f", blob("b"), "b.txt"]]));
      r.nestingTooDeep = await post("nesting", form([["a[b][c]", "1"]]));
      r.arrayIndexTooLarge = await post("nesting", form([["arr[5]", "x"]]));
      r.nestingOk = await post("nesting", form([["a[b]", "1"], ["arr[1]", "x"]]));
      r.nestedDefault = await post("nested-default", form([["a[b][c]", "1"], ["list[]", "x"], ["list[]", "y"], ["plain", "p"]]));
      r.pngMislabelled = await post("png", form([["file", blob(PNG, "application/octet-stream"), "x.bin"]]));
      r.pngWrong = await post("png", form([["file", blob("not a png", "image/png"), "x.png"]]));
      r.svgPlusMeta = await post("svg", form([["file", blob(SVG, "image/svg+xml"), "x.svg"]]));
      return r;
    } finally {
      await b.close();
    }
  },
});
