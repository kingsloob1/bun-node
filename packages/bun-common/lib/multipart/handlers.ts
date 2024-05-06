import { BadRequestException } from "@nestjs/common";
import { isArray, isEmpty, isUndefined, keys } from "lodash-es";
import type { BunRequest } from "../BunRequest";
import {
  type StorageExpandedFile,
  type StorageFile,
  type TransFormedUploadOptions,
  type UploadField,
  type UploadFieldMapEntry,
  filterUpload,
  getBusBoyConfig,
  removeStorageFiles,
} from ".";

export const handleMultipartAnyFiles = async (
  req: BunRequest,
  options: TransFormedUploadOptions,
) => {
  const parts = await req.getMultiParts(getBusBoyConfig(options));
  const body: Record<string, any> = {};
  const files: StorageFile[] = [];
  let expandedFiles: StorageExpandedFile<StorageFile> | undefined;

  const removeFiles = async (error?: boolean) => {
    await removeStorageFiles(options.storage!, files, error);
    if (expandedFiles) {
      await options.storage!.removeFile(expandedFiles);
    }
  };

  try {
    for await (const part of parts) {
      if (part.type === "file") {
        const file = await options.storage!.handleFile(part, req);

        if (await filterUpload(options, req, file)) {
          files.push(file);
        }
      } else if (part.type === "expanded-file" && options.inflate) {
        expandedFiles = await options.storage!.handleExpandedFiles(part, req);
      } else if (part.type === "field") {
        body[part.fieldname] = part.value;
      }
    }
  } catch (error) {
    await removeFiles(true);
    throw error;
  }

  return { body, files, expandedFiles, remove: () => removeFiles() };
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
  const parts = await req.getMultiParts(getBusBoyConfig(options));
  const body: Record<string, any> = {};
  const files: Record<string, StorageFile[]> = {};
  let expandedFiles: StorageExpandedFile<StorageFile> | undefined;

  const removeFiles = async (error?: boolean) => {
    const allFiles = ([] as StorageFile[]).concat(...Object.values(files));
    await removeStorageFiles(options.storage!, allFiles, error);

    if (expandedFiles) {
      await options.storage!.removeFile(expandedFiles);
    }
  };

  try {
    for await (const part of parts) {
      if (part.type === "file") {
        const fieldOptions = fieldsMap.get(part.fieldname);

        if (fieldOptions == null) {
          throw new BadRequestException(
            `Field ${part.fieldname} doesn't accept files`,
          );
        }

        if (files[part.fieldname] == null) {
          files[part.fieldname] = [];
        }

        if (files[part.fieldname].length + 1 > fieldOptions.maxCount) {
          throw new BadRequestException(
            `Field ${part.fieldname} accepts max ${fieldOptions.maxCount} files`,
          );
        }

        const file = await options.storage!.handleFile(part, req);

        if (await filterUpload(options, req, file)) {
          files[part.fieldname].push(file);
        }
      } else if (part.type === "field") {
        body[part.fieldname] = part.value;
      } else if (part.type === "expanded-file" && options.inflate) {
        for await (const fieldname of keys(part.values)) {
          const fieldOptions = fieldsMap.get(fieldname);

          if (fieldOptions == null) {
            throw new BadRequestException(
              `Field ${fieldname} doesn't accept files`,
            );
          }

          const values = part.values[fieldname];
          if (isArray(values) && values.length > fieldOptions.maxCount) {
            throw new BadRequestException(
              `Field ${fieldname} accepts max ${fieldOptions.maxCount} files`,
            );
          }
        }

        expandedFiles = await options.storage!.handleExpandedFiles(part, req);
      }
    }
  } catch (error) {
    await removeFiles(true);
    throw error;
  }

  return {
    body,
    files,
    expandedFiles,
    remove: () => removeFiles(),
  };
};

export const handleMultipartMultipleFiles = async (
  req: BunRequest,
  fieldname: string,
  maxCount: number,
  options: TransFormedUploadOptions,
) => {
  const parts = await req.getMultiParts(getBusBoyConfig(options));
  const body: Record<string, any> = {};
  const files: StorageFile[] = [];
  let expandedFiles: StorageExpandedFile<StorageFile> | undefined;

  const removeFiles = async (error?: boolean) => {
    await removeStorageFiles(options.storage!, files, error);
    if (expandedFiles) {
      await options.storage!.removeFile(expandedFiles);
    }
  };

  try {
    for await (const part of parts) {
      if (part.type === "file") {
        if (part.fieldname !== fieldname) {
          throw new BadRequestException(
            `Field ${part.fieldname} doesn't accept files`,
          );
        }

        if (files.length + 1 > maxCount) {
          throw new BadRequestException(
            `Field ${part.fieldname} accepts max ${maxCount} files`,
          );
        }

        const file = await options.storage!.handleFile(part, req);

        if (await filterUpload(options, req, file)) {
          files.push(file);
        }
      } else if (part.type === "field") {
        body[part.fieldname] = part.value;
      } else if (part.type === "expanded-file" && options.inflate) {
        for await (const savedFieldName of keys(part.values)) {
          if (savedFieldName !== fieldname) {
            throw new BadRequestException(
              `Field ${savedFieldName} doesn't accept files`,
            );
          }

          const savedFieldNameValues = part.values[savedFieldName];
          if (
            isArray(savedFieldNameValues) &&
            savedFieldNameValues.length > maxCount
          ) {
            throw new BadRequestException(
              `Field ${savedFieldName} accepts max ${maxCount} files`,
            );
          }
        }

        expandedFiles = await options.storage!.handleExpandedFiles(part, req);
      }
    }
  } catch (error) {
    await removeFiles(!!error);
    throw error;
  }

  return { body, files, expandedFiles, remove: () => removeFiles() };
};

export const handleMultipartSingleFile = async (
  req: BunRequest,
  fieldname: string,
  options: TransFormedUploadOptions,
) => {
  const parts = await req.getMultiParts(getBusBoyConfig(options));
  const body: Record<string, any> = {};

  let file: StorageFile | undefined;
  let expandedFiles: StorageExpandedFile<StorageFile> | undefined;

  const removeFiles = async (error?: boolean) => {
    if (file == null) return;
    await options.storage!.removeFile(file, error);
    if (expandedFiles) {
      await options.storage!.removeFile(expandedFiles);
    }
  };

  try {
    for await (const part of parts) {
      if (part.type === "file") {
        if (part.fieldname !== fieldname) {
          throw new BadRequestException(
            `Field ${part.fieldname} doesn't accept file`,
          );
        } else if (!isUndefined(file)) {
          throw new BadRequestException(
            `Field ${fieldname} accepts only one file`,
          );
        }

        const _file = await options.storage!.handleFile(part, req);

        if (await filterUpload(options, req, _file)) {
          file = _file;
        }
      } else if (part.type === "field") {
        body[part.fieldname] = part.value;
      } else if (part.type === "expanded-file") {
        for await (const savedFieldName of keys(part.values)) {
          if (savedFieldName !== fieldname) {
            throw new BadRequestException(
              `Field ${savedFieldName} doesn't accept files`,
            );
          }

          const savedFieldNameValues = part.values[savedFieldName];
          if (
            isArray(savedFieldNameValues) &&
            savedFieldNameValues.length > 1
          ) {
            throw new BadRequestException(
              `Field ${savedFieldName} accepts only one file`,
            );
          }
        }

        expandedFiles = await options.storage!.handleExpandedFiles(part, req);
      }
    }
  } catch (error) {
    await removeFiles(true);
    throw error;
  }

  return {
    body,
    file,
    expandedFile: expandedFiles,
    remove: () => removeFiles(),
  };
};

export const handleNoFiles = async (
  req: BunRequest,
  options: TransFormedUploadOptions,
) => {
  const parts = await req.getMultiParts(getBusBoyConfig(options));
  const body: Record<string, any> = {};
  const files: StorageFile[] = [];
  const expandedFiles: StorageExpandedFile<StorageFile> | undefined = undefined;

  const removeFiles = async (error?: boolean) => {
    await removeStorageFiles(options.storage!, files, error);
    if (expandedFiles) {
      await options.storage!.removeFile(expandedFiles);
    }
  };

  try {
    for await (const part of parts) {
      if (part.type === "file") {
        throw new BadRequestException(`File upload is not accepted`);
      } else if (part.type === "expanded-file" && options.inflate) {
        if (!isEmpty(part.values)) {
          throw new BadRequestException(`File upload is not accepted`);
        }
      } else if (part.type === "field") {
        body[part.fieldname] = part.value;
      }
    }
  } catch (error) {
    await removeFiles(true);
    throw error;
  }

  return { body, files, expandedFiles, remove: () => removeFiles() };
};
