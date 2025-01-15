import type { MemoryStorageFile, Storage } from "..";
import type { MultiPartFileRecord } from "../../types/general";
import { BadRequestException } from "@nestjs/common";
import { isBuffer, isObject, values } from "lodash-es";

export class MemoryStorage implements Storage<MemoryStorageFile> {
  public async handleFile(file: MultiPartFileRecord) {
    if (file.type !== "file") {
      throw new BadRequestException(
        "Only file record can be handled by this method",
      );
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

  public async removeFile(file: unknown) {
    if (isObject(file)) {
      if (
        "type" in file &&
        "buffer" in file &&
        file.type === "memory" &&
        isBuffer(file.buffer)
      ) {
        delete (file as any).buffer;
      } else {
        values(file).forEach((value) => {
          this.removeFile(value);
        });
      }
    }
  }
}
