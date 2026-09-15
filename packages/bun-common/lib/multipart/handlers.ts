import type {
  StorageExpandedFile,
  StorageFile,
  TransFormedUploadOptions,
  UploadField,
  UploadFieldMapEntry,
} from ".";
import type { BunRequest } from "../BunRequest";
import { filterUpload, getBusBoyConfig, removeStorageFiles } from ".";
import { each, isArray, keys, merge, unset } from "../utils/native";
import { UploadError } from "./errors";

/**
 * Accepts any file on any field — multer's `any()`. Answers the fields in
 * `body` and every kept file, typed by the storage (`TFile`), in `files`.
 *
 * @throws {UploadError} `FILTER_REJECTED` when the `filter` answers a string.
 */
export const handleMultipartAnyFiles = async <
  TFile extends StorageFile = StorageFile,
>(
  req: BunRequest,
  options: TransFormedUploadOptions<TFile>,
) => {
  const multiPartResp = await req.getMultiParts(getBusBoyConfig(options));
  let body: Record<string, unknown> = {};
  const files: TFile[] = [];

  const removeFiles = async (error?: boolean) => {
    await removeStorageFiles(options.storage, files, error);
  };

  try {
    await Promise.all(
      Array.from(multiPartResp.files.keys()).map(async (fileRecord) => {
        const file = await options.storage.handleFile(fileRecord, req);

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
    removeFile: (file: TFile) => options.storage.removeFile(file),
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

/**
 * Accepts files only on the fields in `fieldsMap`, each up to its `maxCount` —
 * multer's `fields()`. Answers `files` keyed by field name.
 *
 * @throws {UploadError} `LIMIT_UNEXPECTED_FILE` (`field` naming it) for a file
 *   on a field not in the map (`Field <name> doesn't accept files`) or more
 *   files on a field than its `maxCount` (`Field <name> accepts max <n>
 *   files`); `FILTER_REJECTED` when the `filter` answers a string.
 */
export const handleMultipartFileFields = async <
  TFile extends StorageFile = StorageFile,
>(
  req: BunRequest,
  fieldsMap: Map<string, UploadFieldMapEntry>,
  options: TransFormedUploadOptions<TFile>,
) => {
  const multiPartResp = await req.getMultiParts(getBusBoyConfig(options));
  let body: Record<string, unknown> = {};
  const files: Record<string, TFile[]> = {};

  const removeFiles = async (error?: boolean) => {
    const allFiles = ([] as TFile[]).concat(...Object.values(files));
    await removeStorageFiles(options.storage, allFiles, error);
  };

  try {
    await Promise.all(
      Array.from(multiPartResp.files.keys()).map(async (fileRecord) => {
        if (!isArray(files[fileRecord.fieldname])) {
          files[fileRecord.fieldname] = [];
        }

        const file = await options.storage.handleFile(fileRecord, req);

        if (await filterUpload(options, req, file)) {
          files[fileRecord.fieldname].push(file);
        }
      }),
    );

    // Handle validation checks
    for (const fileFieldName of keys(files)) {
      const fieldOptions = fieldsMap.get(fileFieldName);

      if (fieldOptions == null) {
        throw new UploadError("LIMIT_UNEXPECTED_FILE", {
          field: fileFieldName,
          message: `Field ${fileFieldName} doesn't accept files`,
        });
      }

      if (files[fileFieldName].length > fieldOptions.maxCount) {
        throw new UploadError("LIMIT_UNEXPECTED_FILE", {
          field: fileFieldName,
          message: `Field ${fileFieldName} accepts max ${fieldOptions.maxCount} files`,
        });
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
    removeFile: (file: TFile) => options.storage.removeFile(file),
    removeAll: () => removeFiles(),
  };
};

/**
 * Accepts up to `maxCount` files, all on `fieldname` — multer's `array()`.
 *
 * @throws {UploadError} `LIMIT_UNEXPECTED_FILE` for a file on another field
 *   (`Only Field <fieldname> accept files`, `field` naming the foreign field)
 *   or more than `maxCount` files (`Field <fieldname> accepts max <n> files`,
 *   `field` = `fieldname`); `FILTER_REJECTED` when the `filter` answers a
 *   string.
 */
export const handleMultipartMultipleFiles = async <
  TFile extends StorageFile = StorageFile,
>(
  req: BunRequest,
  fieldname: string,
  maxCount: number,
  options: TransFormedUploadOptions<TFile>,
) => {
  const multiPartResp = await req.getMultiParts(getBusBoyConfig(options));
  let body: Record<string, unknown> = {};
  const files: TFile[] = [];

  const removeFiles = async (error?: boolean) => {
    const allFiles = ([] as TFile[]).concat(...Object.values(files));
    await removeStorageFiles(options.storage, allFiles, error);
  };

  try {
    // The first file that arrived on a field other than `fieldname`.
    let foreignField: string | undefined;
    await Promise.all(
      Array.from(multiPartResp.files.keys()).map(async (fileRecord) => {
        if (fileRecord.fieldname !== fieldname || foreignField !== undefined) {
          foreignField ??= fileRecord.fieldname;
          return;
        }

        const file = await options.storage.handleFile(fileRecord, req);

        if (await filterUpload(options, req, file)) {
          files.push(file);
        }
      }),
    );

    // Handle validation checks to see if foreign file was uploaded
    if (foreignField !== undefined) {
      throw new UploadError("LIMIT_UNEXPECTED_FILE", {
        field: foreignField,
        message: `Only Field ${fieldname} accept files`,
      });
    }

    // Handle validation checks
    if (files.length > maxCount) {
      throw new UploadError("LIMIT_UNEXPECTED_FILE", {
        field: fieldname,
        message: `Field ${fieldname} accepts max ${maxCount} files`,
      });
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
    removeFile: (file: TFile) => options.storage.removeFile(file),
    removeAll: () => removeFiles(),
  };
};

/**
 * Accepts at most one file, on `fieldname` — multer's `single()`.
 *
 * Like multer, the upload is rejected with an {@link UploadError}
 * `LIMIT_UNEXPECTED_FILE` (message `Only Field <fieldname> accept one file`)
 * when a file arrives on any other field **or** more than one file arrives on
 * `fieldname`; `field` names the foreign field, or `fieldname` for a second
 * file. Both are checked before anything is stored, so a rejected upload
 * leaves nothing behind. No file at all is not an error: `file` is
 * `undefined`. A `filter` answering a string rejects with `FILTER_REJECTED`.
 */
export const handleMultipartSingleFile = async <
  TFile extends StorageFile = StorageFile,
>(
  req: BunRequest,
  fieldname: string,
  options: TransFormedUploadOptions<TFile>,
) => {
  const multiPartResp = await req.getMultiParts(getBusBoyConfig(options));
  let body: Record<string, unknown> = {};
  let file: TFile | undefined;

  const removeFiles = async (error?: boolean) => {
    if (file == null) return;
    await options.storage.removeFile(file, error);
  };

  try {
    const records = Array.from(multiPartResp.files.keys());

    // Validate before storing: a foreign field, or a second file on ours.
    const foreign = records.find((record) => record.fieldname !== fieldname);
    if (foreign || records.length > 1) {
      throw new UploadError("LIMIT_UNEXPECTED_FILE", {
        field: foreign?.fieldname ?? fieldname,
        message: `Only Field ${fieldname} accept one file`,
      });
    }

    const [fileRecord] = records;
    if (fileRecord) {
      const fileHandled = await options.storage.handleFile(fileRecord, req);

      if (await filterUpload(options, req, fileHandled)) {
        file = fileHandled;
      }
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
    removeFile: (file: TFile) => options.storage.removeFile(file),
    removeAll: () => removeFiles(),
  };
};

/**
 * Accepts fields only, rejecting any file — multer's `none()`. `files` is
 * always empty and `expandedFiles` always `undefined`; both stay for symmetry
 * with the other handlers.
 *
 * @throws {UploadError} `LIMIT_UNEXPECTED_FILE` (`File upload is not
 *   accepted`, `field` naming the first file's field) when any file arrives.
 */
export const handleNoFiles = async <TFile extends StorageFile = StorageFile>(
  req: BunRequest,
  options: TransFormedUploadOptions<TFile>,
) => {
  const multiPartResp = await req.getMultiParts(getBusBoyConfig(options));
  let body: Record<string, unknown> = {};
  const files: TFile[] = [];
  const expandedFiles: StorageExpandedFile<TFile> | undefined = undefined;

  const removeFiles = async (error?: boolean) => {
    await removeStorageFiles(options.storage, files, error);
  };

  try {
    // Handle validation checks to see if foreign file was uploaded
    const [firstFile] = multiPartResp.files.keys();
    if (firstFile) {
      throw new UploadError("LIMIT_UNEXPECTED_FILE", {
        field: firstFile.fieldname,
        message: `File upload is not accepted`,
      });
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
    removeFile: (file: TFile) => options.storage.removeFile(file),
    removeAll: () => removeFiles(),
  };
};
