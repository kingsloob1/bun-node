import type { MemoryStorageFile, Storage } from "..";
import type { MultiPartFileRecord } from "../../types/general";
import { isBuffer, isObject, values } from "../../utils/native";

export interface MemoryStorageOptions {
  /**
   * Whether `removeFile(file)` releases a file's buffer without `force`.
   * Defaults to `true` — unlike `DiskStorage`, where it defaults to `false`,
   * because a buffer is only worth keeping for the request that received it.
   * With `false`, only `removeFile(file, true)` (as a rejected upload does)
   * releases it.
   */
  removeAfter?: boolean;
}

export class MemoryStorage implements Storage<
  MemoryStorageFile,
  MemoryStorageOptions
> {
  /** Options this storage was constructed with. */
  public readonly options?: MemoryStorageOptions;

  /**
   * @param options Removal behaviour; see {@link MemoryStorageOptions}.
   */
  constructor(options?: MemoryStorageOptions) {
    this.options = options;
  }

  public async handleFile(file: MultiPartFileRecord) {
    if (file.type !== "file") {
      throw new Error("Only file record can be handled by this method");
    }

    const buffer = file.file;
    const { encoding, mimeType: mimetype, fieldname, validatedMimeType } = file;

    return {
      type: "memory" as const,
      buffer,
      size: buffer.length,
      encoding,
      mimetype,
      fieldname,
      originalFilename: file.filename,
      validatedMimeType,
    };
  }

  /**
   * Releases a memory file's buffer — or every memory file found inside an
   * object. A no-op without `force` when `removeAfter` is `false`.
   */
  public async removeFile(file: unknown, force?: boolean): Promise<void> {
    if (this.options?.removeAfter === false && !force) return;
    if (!isObject(file)) return;

    if (
      "type" in file &&
      "buffer" in file &&
      file.type === "memory" &&
      isBuffer(file.buffer)
    ) {
      delete (file as Partial<MemoryStorageFile>).buffer;
    } else {
      await Promise.all(
        values(file).map((value) => this.removeFile(value, force)),
      );
    }
  }
}
