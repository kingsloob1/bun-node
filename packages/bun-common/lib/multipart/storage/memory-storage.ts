import { isArray, isBuffer, isObject, keys, values } from 'lodash-es';
import type { MemoryStorageFile, Storage, StorageExpandedFile } from '..';
import type {
  MultiPartExpandedFileRecord,
  MultiPartFileRecord,
} from '../../types/general';
import { BadRequestException } from '@nestjs/common';

export class MemoryStorage implements Storage<MemoryStorageFile> {
  public async handleFile(file: MultiPartFileRecord) {
    if (file.type !== 'file') {
      throw new BadRequestException(
        'Only file record can be handled by this method',
      );
    }

    const buffer = file.file;
    const { encoding, mimeType: mimetype, fieldname, validatedMimeType } = file;

    return {
      type: 'memory' as const,
      buffer,
      size: buffer.length,
      encoding,
      mimetype,
      fieldname,
      originalFilename: file.filename,
      validatedMimeType,
    };
  }

  private async handleExpandedFileValues(
    record: MultiPartExpandedFileRecord['values'],
  ) {
    const expandedFiles: StorageExpandedFile<MemoryStorageFile> = {};
    await Promise.all(
      keys(record).map(async (fieldname) => {
        const value = record[fieldname];

        if (isArray(value)) {
          expandedFiles[fieldname] = await Promise.all(
            value.map(async (file: MultiPartFileRecord) =>
              this.handleFile(file),
            ),
          );
        } else if (isObject(value)) {
          expandedFiles[fieldname] = await this.handleExpandedFileValues(
            value as unknown as MultiPartExpandedFileRecord['values'],
          );
        }
      }),
    );

    return expandedFiles;
  }

  public async handleExpandedFiles(file: MultiPartExpandedFileRecord) {
    if (file.type !== 'expanded-file') {
      throw new BadRequestException(
        'Only expanded files record can be handled by this method',
      );
    }

    return await this.handleExpandedFileValues(file.values);
  }

  public async removeFile(file: unknown) {
    if (isObject(file)) {
      if (
        'type' in file &&
        'buffer' in file &&
        file.type === 'memory' &&
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
