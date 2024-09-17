import { BadRequestException } from "@nestjs/common";
import { each, isArray, keys, merge, unset } from "lodash-es";
import {
  filterUpload,
  getBusBoyConfig,
  removeStorageFiles,
  type StorageExpandedFile,
  type StorageFile,
  type TransFormedUploadOptions,
  type UploadField,
  type UploadFieldMapEntry,
} from ".";
import type { BunRequest } from "../BunRequest";

export const handleMultipartAnyFiles = async (
  req: BunRequest,
  options: TransFormedUploadOptions,
) => {
  const multiPartResp = await req.getMultiParts(getBusBoyConfig(options));
  let body: Record<string, any> = {};
  const files: StorageFile[] = [];

  const removeFiles = async (error?: boolean) => {
    await removeStorageFiles(options.storage!, files, error);
  };

  try {
    await Promise.all(
      Array.from(multiPartResp.files.keys()).map(async (fileRecord) => {
        const file = await options.storage!.handleFile(fileRecord, req);

        if (await filterUpload(options, req, file)) {
          files.push(file);
        }
      }),
    );

    body = merge(body, multiPartResp.fields);
  } catch (error) {
    await removeFiles(true);
    each(files, (_, key) => {
      unset(files, key);
    });

    throw error;
  }

  return {
    body,
    files,
    removeFile: (file: StorageFile) => options.storage?.removeFile(file),
    removeAll: () => removeFiles(),
  };
};

export const uploadFieldsToMap = (uploadFields: UploadField[]) => {
  const map = new Map<string, UploadFieldMapEntry>();

  uploadFields.forEach(({ name, ...opts }) => {
    map.set(name, { maxCount: 1, ...opts });
  });

  return map;
};

export const handleMultipartFileFields = async (
  req: BunRequest,
  fieldsMap: Map<string, UploadFieldMapEntry>,
  options: TransFormedUploadOptions,
) => {
  const multiPartResp = await req.getMultiParts(getBusBoyConfig(options));
  let body: Record<string, unknown> = {};
  const files: Record<string, StorageFile[]> = {};

  const removeFiles = async (error?: boolean) => {
    const allFiles = ([] as StorageFile[]).concat(...Object.values(files));
    await removeStorageFiles(options.storage!, allFiles, error);
  };

  try {
    await Promise.all(
      Array.from(multiPartResp.files.keys()).map(async (fileRecord) => {
        if (!isArray(files[fileRecord.fieldname])) {
          files[fileRecord.fieldname] = [];
        }

        const file = await options.storage!.handleFile(fileRecord, req);

        if (await filterUpload(options, req, file)) {
          files[fileRecord.fieldname].push(file);
        }
      }),
    );

    // Handle validation checks
    for (const fileFieldName of keys(files)) {
      const fieldOptions = fieldsMap.get(fileFieldName);

      if (fieldOptions == null) {
        throw new BadRequestException(
          `Field ${fileFieldName} doesn't accept files`,
        );
      }

      if (files[fileFieldName].length + 1 > fieldOptions.maxCount) {
        throw new BadRequestException(
          `Field ${fileFieldName} accepts max ${fieldOptions.maxCount} files`,
        );
      }
    }

    body = merge(body, multiPartResp.fields);
  } catch (error) {
    await removeFiles(true);

    each(files, (_, key) => {
      unset(files, key);
    });

    throw error;
  }

  return {
    body,
    files,
    removeFile: (file: StorageFile) => options.storage?.removeFile(file),
    removeAll: () => removeFiles(),
  };
};

export const handleMultipartMultipleFiles = async (
  req: BunRequest,
  fieldname: string,
  maxCount: number,
  options: TransFormedUploadOptions,
) => {
  const multiPartResp = await req.getMultiParts(getBusBoyConfig(options));
  let body: Record<string, unknown> = {};
  const files: StorageFile[] = [];

  const removeFiles = async (error?: boolean) => {
    const allFiles = ([] as StorageFile[]).concat(...Object.values(files));
    await removeStorageFiles(options.storage!, allFiles, error);
  };

  try {
    let hasInvalidFiles = false;
    await Promise.all(
      Array.from(multiPartResp.files.keys()).map(async (fileRecord) => {
        if (fileRecord.fieldname !== fieldname || hasInvalidFiles) {
          hasInvalidFiles = true;
          return;
        }

        const file = await options.storage!.handleFile(fileRecord, req);

        if (await filterUpload(options, req, file)) {
          files.push(file);
        }
      }),
    );

    // Handle validation checks to see if foreign file was uploaded
    if (hasInvalidFiles) {
      throw new BadRequestException(`Only Field ${fieldname} accept files`);
    }

    // Handle validation checks
    if (files.length + 1 > maxCount) {
      throw new BadRequestException(
        `Field ${fieldname} accepts max ${maxCount} files`,
      );
    }

    body = merge(body, multiPartResp.fields);
  } catch (error) {
    await removeFiles(true);
    each(files, (_, key) => {
      unset(files, key);
    });

    throw error;
  }

  return {
    body,
    files,
    removeFile: (file: StorageFile) => options.storage?.removeFile(file),
    removeAll: () => removeFiles(),
  };
};

export const handleMultipartSingleFile = async (
  req: BunRequest,
  fieldname: string,
  options: TransFormedUploadOptions,
) => {
  const multiPartResp = await req.getMultiParts(getBusBoyConfig(options));
  let body: Record<string, any> = {};
  let file: StorageFile | undefined;

  const removeFiles = async (error?: boolean) => {
    if (file == null) return;
    await options.storage!.removeFile(file, error);
  };

  try {
    let hasInvalidFiles = false;
    await Promise.all(
      Array.from(multiPartResp.files.keys()).map(async (fileRecord) => {
        if (fileRecord.fieldname !== fieldname || hasInvalidFiles) {
          hasInvalidFiles = true;
          return;
        }

        const fileHandled = await options.storage!.handleFile(fileRecord, req);

        if (await filterUpload(options, req, fileHandled)) {
          file = fileHandled;
        }
      }),
    );

    // Handle validation checks to see if foreign file was uploaded
    if (hasInvalidFiles) {
      throw new BadRequestException(`Only Field ${fieldname} accept one file`);
    }

    body = merge(body, multiPartResp.fields);
  } catch (error) {
    await removeFiles(true);
    file = undefined;

    throw error;
  }

  return {
    body,
    file,
    removeFile: (file: StorageFile) => options.storage?.removeFile(file),
    removeAll: () => removeFiles(),
  };
};

export const handleNoFiles = async (
  req: BunRequest,
  options: TransFormedUploadOptions,
) => {
  const multiPartResp = await req.getMultiParts(getBusBoyConfig(options));
  let body: Record<string, any> = {};
  const files: StorageFile[] = [];
  const expandedFiles: StorageExpandedFile<StorageFile> | undefined = undefined;

  const removeFiles = async (error?: boolean) => {
    await removeStorageFiles(options.storage!, files, error);
  };

  try {
    // Handle validation checks to see if foreign file was uploaded
    if (multiPartResp.files.size) {
      throw new BadRequestException(`File upload is not accepted`);
    }

    body = merge(body, multiPartResp.fields);
  } catch (error) {
    await removeFiles(true);
    multiPartResp.files.clear();

    throw error;
  }

  return {
    body,
    files,
    expandedFiles,
    removeFile: (file: StorageFile) => options.storage?.removeFile(file),
    removeAll: () => removeFiles(),
  };
};
