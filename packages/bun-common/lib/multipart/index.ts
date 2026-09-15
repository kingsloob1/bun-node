import type { BusboyConfig, FileInfo } from "busboy";
import type { FileTypeResult } from "file-type";
import type { Buffer } from "node:buffer";
import type { BunRequest } from "../BunRequest";
import type { MultiPartFileRecord, MultiPartOptions } from "../types/general";
import type { DiskStorageOptions, MemoryStorageOptions } from "./storage";
import { isString, omit } from "../utils/native";
import { UploadError } from "./errors";
import { DiskStorage, MemoryStorage } from "./storage";

export {
  UPLOAD_ERROR_MESSAGES,
  UploadError,
  type UploadErrorCode,
  type UploadErrorOptions,
} from "./errors";

export interface StorageFile {
  size: number;
  mimetype: string;
  encoding: string;
  fieldname: string;
  originalFilename: string;
  validatedMimeType: FileTypeResult | undefined;
}

export interface DiskStorageFile extends StorageFile {
  type: "disk";
  dest?: string | null;
  filename?: string | null;
  path: string;
}

export interface MemoryStorageFile extends StorageFile {
  type: "memory";
  buffer: Buffer;
}

export interface CustomStorageFile extends StorageFile {
  type: "custom";
  file: Buffer;
}

export interface StorageExpandedFile<T extends StorageFile> {
  [key: string]: T[] | StorageExpandedFile<T>;
}

export type RawMultipartFile = FileInfo & {
  fieldname: string;
  file: Buffer;
};

/**
 * Where uploaded files go: stores each one, and removes what it stored.
 *
 * @typeParam T The file record this storage produces.
 * @typeParam K The options it was built with.
 */
export interface Storage<T extends StorageFile = StorageFile, K = unknown> {
  /** Stores one received file and answers its record. */
  handleFile: (file: MultiPartFileRecord, req: BunRequest) => Promise<T>;
  /**
   * Removes a file this storage produced; `force` overrides a storage's own
   * keep-by-default setting. The library only ever passes back a `T` that this
   * storage's `handleFile` returned.
   *
   * Declared through a method signature (the "bivariance hack") so a
   * `Storage<MyFile>` implementing `removeFile(file: MyFile)` still counts as a
   * plain `Storage`, which is where upload options accept it.
   *
   * `NoInfer`: `T` is decided by `handleFile` alone. The built-in storages
   * accept any value here (they search nested objects), and without it that
   * `unknown` parameter would win inference and erase their file types.
   */
  removeFile: {
    // A method signature on purpose: only methods compare bivariantly.
    // eslint-disable-next-line ts/method-signature-style
    bivarianceHack(file: NoInfer<T>, force?: boolean): Promise<void> | void;
  }["bivarianceHack"];
  /** Options the storage was built with, when it keeps them. */
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

/**
 * Uploads written to disk by a {@link DiskStorage} built from these options —
 * so every {@link DiskStorageOptions} field (`dest`, `filename`,
 * `removeAfter`, strings or functions) is accepted here directly.
 */
export type DiskUploadOptions = MultiPartOptions &
  DiskStorageOptions & {
    /** Selects a `DiskStorage`. */
    storageType: "disk";
    /**
     * Decides per stored file: `true` keeps it, `false` leaves it out (and
     * removes it from storage), a string or a throw rejects the upload.
     */
    filter?: UploadFilterHandler;
  };

/**
 * Uploads kept in memory by a {@link MemoryStorage} built from these options.
 */
export type MemoryUploadOptions = MultiPartOptions &
  MemoryStorageOptions & {
    /** Selects a `MemoryStorage`. The default. */
    storageType: "memory";
    /**
     * Decides per stored file: `true` keeps it, `false` leaves it out (and
     * removes it from storage), a string or a throw rejects the upload.
     */
    filter?: UploadFilterHandler;
  };

/**
 * Uploads handled by a storage of your own.
 *
 * @typeParam TFile The file record that storage produces.
 */
export type CustomUploadOptions<TFile extends StorageFile = StorageFile> =
  MultiPartOptions & {
    /** Selects the `storage` given. */
    storageType: "custom";
    /**
     * Decides per stored file: `true` keeps it, `false` leaves it out (and
     * removes it from storage), a string or a throw rejects the upload.
     */
    filter?: UploadFilterHandler;
    /** The storage that stores and removes files. Required. */
    storage: Storage<TFile>;
  };

/** Every accepted upload configuration; `TFile` is a custom storage's file. */
export type UploadOptions<TFile extends StorageFile = StorageFile> =
  | DiskUploadOptions
  | MemoryUploadOptions
  | CustomUploadOptions<TFile>;

export const DEFAULT_UPLOAD_OPTIONS: MemoryUploadOptions = {
  storageType: "memory",
};

/**
 * Upload options with their storage built, as the multipart handlers take
 * them. `storage` is always present: {@link transformUploadOptions} throws a
 * `TypeError` for a `storageType` outside the union rather than answer none.
 *
 * @typeParam TFile The file record the storage produces — what the handlers
 *   answer in `file`/`files`.
 */
export type TransFormedUploadOptions<TFile extends StorageFile = StorageFile> =
  (
    | DiskUploadOptions
    | MemoryUploadOptions
    | Omit<CustomUploadOptions<TFile>, "storage">
  ) & {
    /** The storage every file is handed to. */
    storage: Storage<TFile>;
  };

/** No options: the default, an in-memory storage. */
export function transformUploadOptions(
  opts?: undefined,
): MemoryUploadOptions & {
  /** The `MemoryStorage` built for these options. */
  storage: MemoryStorage;
};
/** Disk options: a `DiskStorage` built from their `dest`/`filename`/`removeAfter`. */
export function transformUploadOptions(
  opts: DiskUploadOptions,
): DiskUploadOptions & {
  /** The `DiskStorage` built from these options. */
  storage: DiskStorage;
};
/** Memory options: a `MemoryStorage` built from their `removeAfter`. */
export function transformUploadOptions(
  opts: MemoryUploadOptions,
): MemoryUploadOptions & {
  /** The `MemoryStorage` built for these options. */
  storage: MemoryStorage;
};
/** Custom options: the given `storage`, kept with its own type. */
export function transformUploadOptions<
  TOptions extends CustomUploadOptions<StorageFile>,
>(opts: TOptions): TOptions;
/** Any upload options, when which kind is not known statically. */
export function transformUploadOptions(
  opts?: UploadOptions,
): TransFormedUploadOptions;
/**
 * @throws {TypeError} for a `storageType` other than `"disk"`, `"memory"` or
 *   `"custom"` (reachable from plain JS), and for `"custom"` without a
 *   `storage`.
 */
export function transformUploadOptions(
  opts?: UploadOptions,
): TransFormedUploadOptions {
  opts ??= DEFAULT_UPLOAD_OPTIONS;
  // Read before narrowing: past the three known kinds `opts` is `never`, yet
  // plain JS can still get there.
  const storageType: unknown = opts.storageType;

  let storage: Storage;
  if (opts.storageType === "disk") {
    storage = new DiskStorage(opts);
  } else if (opts.storageType === "memory") {
    storage = new MemoryStorage({ removeAfter: opts.removeAfter });
  } else if (opts.storageType === "custom") {
    if (!opts.storage) {
      throw new TypeError(
        'Upload options with storageType "custom" requires a storage handler',
      );
    }

    storage = opts.storage;
  } else {
    throw new TypeError(
      `Unknown upload storageType ${JSON.stringify(storageType)}: expected "disk", "memory" or "custom"`,
    );
  }

  return {
    ...opts,
    storage,
  };
}

/**
 * Runs the upload's `filter` on one stored file. Answers `true` to keep it.
 *
 * A file the filter leaves out (`false`) is removed from storage with `force`
 * before `false` is returned, so a rejected disk file does not linger; a string
 * answer or a throw removes it the same way and rejects the upload.
 *
 * @throws {UploadError} `FILTER_REJECTED`, with the string as its message and
 *   the file's field as `field`, when the filter answers a string. An error
 *   the filter throws is rethrown as it is, as multer passes a `fileFilter`
 *   error on.
 */
export const filterUpload = async <TFile extends StorageFile>(
  uploadOptions: TransFormedUploadOptions<TFile>,
  req: BunRequest,
  file: TFile,
): Promise<boolean> => {
  if (uploadOptions.filter == null) {
    return true;
  }

  try {
    const filterResp = await uploadOptions.filter(req, file);

    if (isString(filterResp)) {
      throw new UploadError("FILTER_REJECTED", {
        field: file.fieldname,
        message: filterResp,
      });
    }

    if (filterResp) {
      return true;
    }
  } catch (error) {
    await uploadOptions.storage.removeFile(file, true);
    throw error;
  }

  await uploadOptions.storage.removeFile(file, true);
  return false;
};

// `BunRequest` rather than `InstanceType<typeof BunRequest>`: the latter
// resolves the class's type parameters to their constraints instead of their
// defaults, which would leave `params`/`query`/`body` as `unknown`.
export type BunMultipartRequest = BunRequest & {
  storageFile?: StorageFile;
  storageFiles?: StorageFile[] | Record<string, StorageFile[]>;
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
    "storageType",
    "filter",
    "storage",
    "dest",
    "filename",
    "removeAfter",
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

export type UploadFieldMapEntry = Required<Pick<UploadField, "maxCount">>;
