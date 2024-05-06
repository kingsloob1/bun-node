import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import process from "node:process";
import { isArray, isObject, isString, keys, values } from "lodash-es";
import { BadRequestException } from "@nestjs/common";
import { pump } from "../stream";
import { getUniqueFilename, pathExists } from "../../utils/general";
import type { BunRequest } from "../../BunRequest";
import type {
  DiskStorageFile,
  RawMultipartFile,
  Storage,
  StorageExpandedFile,
} from "..";
import type {
  MultiPartExpandedFileRecord,
  MultiPartFileRecord,
} from "../../types/general";

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

  private async handleExpandedFileValues(
    record: MultiPartExpandedFileRecord["values"],
    req: BunRequest,
  ) {
    const expandedFiles: StorageExpandedFile<DiskStorageFile> = {};
    await Promise.all(
      keys(record).map(async (fieldname) => {
        const value = record[fieldname];

        if (isArray(value)) {
          expandedFiles[fieldname] = await Promise.all(
            value.map(async (file: MultiPartFileRecord) =>
              this.handleFile(file, req),
            ),
          );
        } else if (isObject(value)) {
          expandedFiles[fieldname] = await this.handleExpandedFileValues(
            value as unknown as MultiPartExpandedFileRecord["values"],
            req,
          );
        }
      }),
    );

    return expandedFiles;
  }

  public async handleExpandedFiles(
    file: MultiPartExpandedFileRecord,
    req: BunRequest,
  ) {
    if (file.type !== "expanded-file") {
      throw new BadRequestException(
        "Only expanded files record can be handled by this method",
      );
    }

    return await this.handleExpandedFileValues(file.values, req);
  }
}
