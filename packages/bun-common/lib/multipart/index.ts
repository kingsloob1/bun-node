import { type FileInfo, type BusboyConfig } from 'busboy';
import type { BunRequest } from '../BunRequest';
import { DiskStorage, MemoryStorage } from './storage';
import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import type { HttpArgumentsHost } from '@nestjs/common/interfaces';
import { isString, omit } from 'lodash-es';
import type {
  MultiPartExpandedFileRecord,
  MultiPartFileRecord,
  MultiPartOptions,
} from '../types/general';
import type { FileTypeResult } from 'file-type';

export interface StorageFile {
  size: number;
  mimetype: string;
  encoding: string;
  fieldname: string;
  originalFilename: string;
  validatedMimeType: FileTypeResult | undefined;
}

export interface DiskStorageFile extends StorageFile {
  type: 'disk';
  dest?: string | null;
  filename?: string | null;
  path: string;
}

export interface MemoryStorageFile extends StorageFile {
  type: 'memory';
  buffer: Buffer;
}

export interface CustomtorageFile extends StorageFile {
  type: 'custom';
  file: Buffer;
}

export type StorageExpandedFile<T extends StorageFile> = {
  [key: string]: T[] | StorageExpandedFile<T>;
};

export type RawMultipartFile = FileInfo & {
  fieldname: string;
  file: Buffer;
};

export interface Storage<T extends StorageFile = StorageFile, K = any> {
  handleFile: (file: MultiPartFileRecord, req: BunRequest) => Promise<T>;
  handleExpandedFiles: (
    record: MultiPartExpandedFileRecord,
    req: BunRequest,
  ) => Promise<StorageExpandedFile<T>>;
  removeFile: (file: T | unknown, force?: boolean) => Promise<void> | void;
  options?: K;
}

export type UploadFilterFile =
  | DiskStorageFile
  | MemoryStorageFile
  | StorageFile;

export type UploadFilterHandler = (
  req: BunRequest,
  file: UploadFilterFile,
) => Promise<boolean | string> | boolean | string;

export type DiskUploadOptions = MultiPartOptions & {
  storageType: 'disk';
  dest?: string;
  filter?: UploadFilterHandler;
};

export type MemoryUploadOptions = MultiPartOptions & {
  storageType: 'memory';
  filter?: UploadFilterHandler;
};

export type CustomUploadOptions = MultiPartOptions & {
  storageType: 'custom';
  filter?: UploadFilterHandler;
  storage: Storage;
};

export type UploadOptions =
  | DiskUploadOptions
  | MemoryUploadOptions
  | CustomUploadOptions;

export const DEFAULT_UPLOAD_OPTIONS: MemoryUploadOptions = {
  storageType: 'memory',
};

export const transformUploadOptions = (opts?: UploadOptions) => {
  if (opts == null) {
    opts = DEFAULT_UPLOAD_OPTIONS;
  }

  let storage: DiskStorage | MemoryStorage | Storage | undefined = undefined;
  if (opts.storageType === 'disk') {
    storage = new DiskStorage(opts);
  } else if (opts.storageType === 'memory') {
    storage = new MemoryStorage();
  } else if (opts.storageType === 'custom') {
    if (!opts.storage) {
      throw new InternalServerErrorException(
        'Ooops.. Custom file handler requires a storage handler',
      );
    }

    storage = opts.storage;
  }

  return {
    ...opts,
    storage,
  };
};

export type TransFormedUploadOptions = ReturnType<
  typeof transformUploadOptions
>;

export const filterUpload = async (
  uploadOptions: ReturnType<typeof transformUploadOptions>,
  req: BunRequest,
  file: UploadFilterFile,
): Promise<boolean> => {
  if (uploadOptions.filter == null) {
    return true;
  }

  try {
    const filterResp = await uploadOptions.filter(req, file);

    if (typeof filterResp === 'string') {
      throw new BadRequestException(filterResp);
    }

    return !!filterResp;
  } catch (error) {
    await uploadOptions.storage!.removeFile(file, true);
    throw error;
  }
};

export type BunMultipartRequest = InstanceType<typeof BunRequest> & {
  storageFile?: StorageFile;
  storageFiles?: StorageFile[] | Record<string, StorageFile[]>;
};

export const getMultipartRequest = (ctx: HttpArgumentsHost) => {
  const req = ctx.getRequest<BunMultipartRequest>();

  const contentType = req.headersObj.get('content-type');
  if (
    !(isString(contentType) && contentType.includes('multipart/form-data;'))
  ) {
    throw new BadRequestException('Not a multipart request');
  }

  return req;
};

export const removeStorageFiles = async (
  storage: Storage,
  files?: (StorageFile | undefined)[],
  force?: boolean,
) => {
  if (files == null) return;
  await Promise.all(
    files.map((file) => file && storage.removeFile(file, force)),
  );
};

export function getBusBoyConfig(
  options: TransFormedUploadOptions,
): BusboyConfig {
  return omit(options, [
    'storageType',
    'filter',
    'storage',
    'dest',
  ]) as BusboyConfig;
}

export interface UploadField {
  /**
   * Field name
   */
  name: string;
  /**
   * Max number of files in this field
   */
  maxCount?: number;
}

export type UploadFieldMapEntry = Required<Pick<UploadField, 'maxCount'>>;
