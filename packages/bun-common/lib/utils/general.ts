import { randomBytes as createRandomBytes } from 'crypto';
import { stat } from 'fs/promises';
import { extname } from 'path';
import { isReadable, type Readable } from 'stream';
import { promisify } from 'util';

export function streamToBuffer(stream: Readable): Promise<Buffer> {
  if (isReadable(stream)) {
    return new Promise((resolve, reject) => {
      const buffs: Uint8Array[] = [];
      stream.on('data', function (d: Uint8Array) {
        buffs.push(d);
      });

      stream.on('end', function () {
        resolve(Buffer.concat(buffs));
      });

      stream.on('error', function (e) {
        reject(e);
      });
    });
  }

  throw new Error('Stream is not readable');
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
  return buffer.toString('hex') + ext;
};
