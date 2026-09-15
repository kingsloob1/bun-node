import type { DiskStorageFile, RawMultipartFile, Storage } from "..";
import type { BunRequest } from "../../BunRequest";
import type { MultiPartFileRecord } from "../../types/general";
import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { getUniqueFilename, pathExists } from "../../utils/general";
import { isObject, isString, values } from "../../utils/native";
import { pump } from "../stream";

/** A fixed string, or a function deciding one per file and request. */
export type DiskStorageOptionHandler =
  | ((file: RawMultipartFile, req: BunRequest) => Promise<string> | string)
  | string;

export interface DiskStorageOptions {
  /**
   * Directory the file is written into, created recursively when missing.
   * Defaults to the OS temp directory.
   */
  dest?: DiskStorageOptionHandler;
  /**
   * Name the file is written under. Defaults to 32 random hex characters plus
   * the original extension. A fixed string makes every upload overwrite the
   * last.
   */
  filename?: DiskStorageOptionHandler;
  /**
   * Whether `removeFile(file)` deletes the file without `force`. Defaults to
   * `false`, so `removeAll()` keeps plain disk uploads; a rejected upload is
   * always removed with `force`.
   */
  removeAfter?: boolean;
}

const executeStorageHandler = (
  file: RawMultipartFile,
  req: BunRequest,
  obj?: DiskStorageOptionHandler,
) => {
  if (typeof obj === "function") {
    return obj(file, req);
  }

  if (obj != null) return obj;

  return null;
};

export class DiskStorage implements Storage<
  DiskStorageFile,
  DiskStorageOptions
> {
  /** Options this storage was constructed with. */
  public readonly options?: DiskStorageOptions;

  /**
   * @param options Where and under what name files are written, and whether
   *   `removeFile` deletes without `force`; see {@link DiskStorageOptions}.
   */
  constructor(options?: DiskStorageOptions) {
    this.options = options;
  }

  public async handleFile(file: MultiPartFileRecord, req: BunRequest) {
    const filename = await this.getFilename(file, req, this.options?.filename);
    const dest = await this.getFileDestination(file, req, this.options?.dest);

    if (!(await pathExists(dest))) {
      await mkdir(dest, { recursive: true });
    }

    const path = join(dest, filename);
    const stream = createWriteStream(path);

    await pump(Readable.from(file.file), stream);

    const { encoding, fieldname, mimeType: mimetype, validatedMimeType } = file;

    return {
      type: "disk" as const,
      size: stream.bytesWritten,
      dest,
      filename,
      originalFilename: file.filename,
      path,
      mimetype,
      encoding,
      fieldname,
      validatedMimeType,
    };
  }

  /**
   * Deletes a disk file — or every disk file found inside an object — once
   * every nested removal has finished. A no-op without `force` unless
   * `removeAfter` is set.
   */
  public async removeFile(file: unknown, force?: boolean): Promise<void> {
    if (!this.options?.removeAfter && !force) return;
    if (isObject(file)) {
      if (
        "type" in file &&
        "path" in file &&
        file.type === "disk" &&
        isString(file.path) &&
        (await pathExists(file.path))
      ) {
        await unlink((file as DiskStorageFile).path);
      } else {
        await Promise.all(
          values(file).map((value) => this.removeFile(value, force)),
        );
      }
    }
  }

  protected async getFilename(
    file: RawMultipartFile,
    req: BunRequest,
    obj?: DiskStorageOptionHandler,
  ): Promise<string> {
    return (
      executeStorageHandler(file, req, obj) ?? getUniqueFilename(file.filename)
    );
  }

  protected async getFileDestination(
    file: RawMultipartFile,
    req: BunRequest,
    obj?: DiskStorageOptionHandler,
  ): Promise<string> {
    return executeStorageHandler(file, req, obj) ?? tmpdir();
  }
}
