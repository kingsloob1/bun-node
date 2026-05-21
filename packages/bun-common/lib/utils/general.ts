import type { Constructor } from "../types/general";
import { Buffer } from "node:buffer";
import { randomBytes as createRandomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { isReadable, Readable } from "node:stream";
import { promisify } from "node:util";
import mime from "mime";

export function streamToBuffer(stream: Readable): Promise<Buffer> {
  if (isReadable(stream)) {
    return new Promise((resolve, reject) => {
      const buffs: Uint8Array[] = [];
      stream.on("data", function (d: Uint8Array) {
        buffs.push(d);
      });

      stream.on("end", function () {
        resolve(Buffer.concat(buffs));
      });

      stream.on("error", function (e) {
        reject(e);
      });
    });
  }

  throw new Error("Stream is not readable");
}

export const randomBytes = promisify(createRandomBytes);

export const pathExists = async (path: string) => {
  try {
    await stat(path);
  } catch {
    return false;
  }

  return true;
};

export const getUniqueFilename = async (filename: string) => {
  const buffer = await randomBytes(16);
  const ext = extname(filename);
  return buffer.toString("hex") + ext;
};

export const isMime = (str: string) => {
  return !!mime.getExtension(str);
};

export const getMimeFromStr = (str: string) => {
  return isMime(str) ? str : mime.getType(str);
};

export function applyMixins<T extends Constructor>(
  derivedCtor: T,
  baseCtors: Constructor[],
): void {
  baseCtors.forEach((baseCtor) => {
    Object.getOwnPropertyNames(baseCtor.prototype).forEach((name) => {
      Object.defineProperty(
        derivedCtor.prototype,
        name,
        Object.getOwnPropertyDescriptor(baseCtor.prototype, name) ||
          Object.create(null),
      );
    });
  });
}

export function isNodeReadableStream(value: any): value is Readable {
  return (
    value instanceof Readable ||
    (value !== null &&
      typeof value === "object" &&
      typeof value.pipe === "function" &&
      typeof value.read === "function")
  );
}
