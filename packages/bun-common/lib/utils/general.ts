import { randomBytes as createRandomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { type Readable, isReadable } from "node:stream";
import { promisify } from "node:util";
import { Buffer } from "node:buffer";

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
  } catch (err) {
    return false;
  }

  return true;
};

export const getUniqueFilename = async (filename: string) => {
  const buffer = await randomBytes(16);
  const ext = extname(filename);
  return buffer.toString("hex") + ext;
};
