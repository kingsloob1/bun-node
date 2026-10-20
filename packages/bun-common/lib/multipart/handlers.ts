import type {
  StorageExpandedFile,
  StorageFile,
  TransFormedUploadOptions,
  UploadField,
  UploadFieldMapEntry,
} from ".";
import type { BunRequest } from "../BunRequest";
import type { MultiPartFileRecord } from "../types/general";
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

        if (
          options.filter == null ||
          (await filterUpload(options, req, file))
        ) {
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
 * @throws {UploadError} `LIMIT_UNEXPECTED_FILE`, with multer's message
 *   (`Unexpected file field`) and `field` naming the file's field as multer
 *   does, for a file on a field not in the map or more files on a field than
 *   its `maxCount` (multer raises the same code for both); `FILTER_REJECTED`
 *   when the `filter` answers a string.
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

        if (
          options.filter == null ||
          (await filterUpload(options, req, file))
        ) {
          files[fileRecord.fieldname].push(file);
        }
      }),
    );

    // Handle validation checks
    for (const fileFieldName of keys(files)) {
      const fieldOptions = fieldsMap.get(fileFieldName);

      if (
        fieldOptions == null ||
        files[fileFieldName].length > fieldOptions.maxCount
      ) {
        throw new UploadError("LIMIT_UNEXPECTED_FILE", {
          field: fileFieldName,
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
 * @throws {UploadError} `LIMIT_UNEXPECTED_FILE`, with multer's message
 *   (`Unexpected file field`), for a file on another field (`field` naming
 *   that field) or more than `maxCount` files (`field` = `fieldname`), as
 *   multer reports both; `FILTER_REJECTED` when the `filter` answers a
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

        if (
          options.filter == null ||
          (await filterUpload(options, req, file))
        ) {
          files.push(file);
        }
      }),
    );

    // Handle validation checks to see if foreign file was uploaded
    if (foreignField !== undefined) {
      throw new UploadError("LIMIT_UNEXPECTED_FILE", { field: foreignField });
    }

    // Handle validation checks
    if (files.length > maxCount) {
      throw new UploadError("LIMIT_UNEXPECTED_FILE", { field: fieldname });
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
 * `LIMIT_UNEXPECTED_FILE` (multer's message, `Unexpected file field`) when a
 * file arrives on any other field **or** more than one file arrives on
 * `fieldname`; `field` names the foreign field, or `fieldname` for a second
 * file, as multer's does. Both are checked before anything is stored, so a rejected upload
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
    // Validate before storing: a foreign field, or a second file on ours.
    let foreign: MultiPartFileRecord | undefined;
    let fileRecord: MultiPartFileRecord | undefined;
    let count = 0;
    for (const record of multiPartResp.files.keys()) {
      count++;
      fileRecord ??= record;
      if (foreign === undefined && record.fieldname !== fieldname) {
        foreign = record;
      }
    }
    if (foreign || count > 1) {
      throw new UploadError("LIMIT_UNEXPECTED_FILE", {
        field: foreign?.fieldname ?? fieldname,
      });
    }

    if (fileRecord) {
      const fileHandled = await options.storage.handleFile(fileRecord, req);

      if (
        options.filter == null ||
        (await filterUpload(options, req, fileHandled))
      ) {
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
 * @throws {UploadError} `LIMIT_UNEXPECTED_FILE`, with multer's message
 *   (`Unexpected file field`) and `field` naming the first file's field, as
 *   multer's `none()` does, when any file arrives.
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
