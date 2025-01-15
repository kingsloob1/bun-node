import type { DiskStorageFile, RawMultipartFile, Storage } from "..";
import type { BunRequest } from "../../BunRequest";
import type { MultiPartFileRecord } from "../../types/general";
import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { isObject, isString, values } from "lodash-es";
import { getUniqueFilename, pathExists } from "../../utils/general";
import { pump } from "../stream";

type DiskStorageOptionHandler =
  | ((file: RawMultipartFile, req: BunRequest) => Promise<string> | string)
  | string;

export interface DiskStorageOptions {
  dest?: DiskStorageOptionHandler;
  filename?: DiskStorageOptionHandler;
  removeAfter?: boolean;
}

const excecuteStorageHandler = (
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

const ENV_TESTS_STORAGE_TMP_PATH = process.env.__TESTS_TMP_PATH__;
export class DiskStorage
  implements Storage<DiskStorageFile, DiskStorageOptions>
{
  public readonly options?: DiskStorageOptions;

  constructor(options?: DiskStorageOptions) {
    this.options = options;

    if (ENV_TESTS_STORAGE_TMP_PATH != null) {
      this.options = { ...this.options, dest: ENV_TESTS_STORAGE_TMP_PATH };
    }
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

  public async removeFile(file: unknown, force?: boolean) {
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
        values(file).forEach((value) => {
          this.removeFile(value, force);
        });
      }
    }
  }

  protected async getFilename(
    file: RawMultipartFile,
    req: BunRequest,
    obj?: DiskStorageOptionHandler,
  ): Promise<string> {
    return (
      excecuteStorageHandler(file, req, obj) ?? getUniqueFilename(file.filename)
    );
  }

  protected async getFileDestination(
    file: RawMultipartFile,
    req: BunRequest,
    obj?: DiskStorageOptionHandler,
  ): Promise<string> {
    return excecuteStorageHandler(file, req, obj) ?? tmpdir();
  }
}
