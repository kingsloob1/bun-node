import type { BunFile } from 'bun';
import {
  get,
  isArray,
  isObject,
  isString,
  values,
  each,
  isNull,
  isUndefined,
  isBoolean,
} from 'lodash-es';
import type { DeepWritable } from 'ts-essentials';
import { join as joinPath } from 'node:path';
import { format as formatDate, isValid as isDateValid } from 'date-fns';
// import { formatInTimeZone } from 'date-fns-tz';
import type { SendFileOptions } from './types/general';
import type { BunRequest } from './BunRequest';
import isNumeric from 'fast-isnumeric';
import { Readable, isReadable } from 'node:stream';
import { fileTypeFromBuffer } from 'file-type';

export class BunResponse {
  private response: Response | undefined = undefined;
  private options: DeepWritable<ResponseInit> = {};
  private headersObj = new Headers();

  constructor(public req: BunRequest) {}

  public header(key: string, value: string | string[]) {
    return this.setHeader(key, value);
  }

  public status(code: number): BunResponse {
    this.options.status = code;
    return this;
  }

  public option(option: ResponseInit): BunResponse {
    this.options = Object.assign(this.options, option);
    return this;
  }

  public statusText(text: string): BunResponse {
    this.options.statusText = text;
    return this;
  }

  public json<T extends Record<string, unknown>>(body: T): BunResponse {
    this.options.headers = this.headersObj;
    this.options.headers.set('Content-Type', 'application/json');
    this.response = Response.json(body, this.options);
    return this;
  }

  async send(
    body:
      | string
      | null
      | undefined
      | ReadableStream
      | BunFile
      | BunResponse
      | Response
      | ConstructorParameters<typeof Response>[0],
  ): Promise<BunResponse> {
    if (this.headersSent) {
      return this;
    }

    this.options.headers = this.headersObj;
    if (body instanceof BunResponse) {
      let response!: Response;

      try {
        const nativeRes = await body.getNativeResponse(1000);
        if (nativeRes instanceof Response) {
          response = nativeRes;
        }
      } catch {
        //
      }

      if (!response) {
        response = new Response(undefined, this.options);
      }

      this.response = response;
    } else if (body instanceof Response) {
      this.response = body;
    } else if (
      body instanceof Blob ||
      isReadable(body as unknown as Readable)
    ) {
      this.response = new Response(body, this.options);
    } else if (isObject(body) || isArray(body)) {
      this.options.headers.set('Content-Type', 'application/json');

      this.response = new Response(JSON.stringify(body), this.options);
    } else {
      let bodyToBeSent = body;
      if (
        !(
          isNull(bodyToBeSent) ||
          isUndefined(bodyToBeSent) ||
          isBoolean(bodyToBeSent)
        )
      ) {
        bodyToBeSent = String(bodyToBeSent);
      }

      //If no content type, Attempt to extract content type from buffer and send
      if (!this.options.headers.get('content-type') && isString(bodyToBeSent)) {
        let contentType = 'text/plain';

        try {
          const typeResp = await fileTypeFromBuffer(
            Buffer.from(bodyToBeSent, 'utf-8'),
          );

          if (typeResp?.mime) {
            contentType = typeResp?.mime;
          }
        } catch {
          //
        }

        this.options.headers.set('Content-Type', contentType);
      }

      this.response = new Response(bodyToBeSent, this.options);
    }

    return this;
  }

  end(body: unknown) {
    return this.send(body as Parameters<typeof this.send>[0]);
  }

  redirect(
    url: string,
    status: Parameters<typeof Response.redirect>[1] = 302,
  ): BunResponse {
    this.response = Response.redirect(url, status);
    return this;
  }

  getNativeResponse(
    timeout = isNumeric(Bun.env.HTTP_REQUEST_TIMEOUT)
      ? Number(Bun.env.HTTP_REQUEST_TIMEOUT)
      : undefined,
  ): Promise<Response> {
    const enableTimeout = isNumeric(timeout) && Number(timeout) > 0;

    return new Promise((resolve, reject) => {
      let elapsedTime = 0;
      const interval = setInterval(() => {
        if (this.response) {
          clearInterval(interval);
          resolve(this.response);
        } else {
          if (elapsedTime > (timeout as number)) {
            clearInterval(interval);
            reject(new Error('Request Timedout'));
            return;
          }

          if (enableTimeout) {
            elapsedTime += 1;
          }
        }
      }, 1);
    });
  }

  get headersSent() {
    return !!this.response;
  }

  setHeader(name: string, value: string | string[], replace = true) {
    if (replace) {
      this.headersObj.delete(name);
    }

    if (isArray(value)) {
      value.forEach((val) => {
        this.headersObj.append(name, val);
      });
    } else {
      if (replace) {
        this.headersObj.set(name, value);
      } else {
        this.headersObj.append(name, value);
      }
    }

    return this;
  }

  setHeaders(headers: Headers | Map<string, string>) {
    const keys = Array.from(headers.keys());
    keys.forEach((key) => {
      const value = headers.get(key);

      if (value) {
        this.headersObj.set(key, value);
      }
    });

    return this;
  }

  getHeader(name: string) {
    return this.headersObj.get(name);
  }

  getHeaderNames() {
    return Array.from(this.headersObj.keys());
  }

  getHeaders() {
    return Array.from(this.headersObj.keys()).reduce(
      (prev, val) => {
        prev[val] = this.headersObj.get(val);
        return prev;
      },
      {} as Record<string, string | null>,
    );
  }

  append(key: string, value: string | string[]) {
    if (!isArray(value)) {
      value = [value];
    }

    value.forEach((val) => {
      this.headersObj.append(key, val);
    });

    return this;
  }

  appendHeader(key: string, value: string | string[]) {
    return this.append(key, value);
  }

  hasHeader(name: string) {
    return this.headersObj.has(name);
  }

  removeHeader(name: string) {
    this.headersObj.delete(name);
    return this;
  }

  async attachment(path?: string) {
    if (path) {
      const file = Bun.file(path);
      if (await file.exists()) {
        this.headersObj.set(
          'Content-Disposition',
          `attachment; filename="${file.name}"`,
        );
        this.headersObj.set('Content-Type', file.type);
        return this;
      }
    }

    this.headersObj.set('Content-Disposition', `attachment`);
    return this;
  }

  async download(
    path: string,
    filename?: string,
    options?: SendFileOptions,
    cb?: () => unknown,
  ) {
    await this.sendFile(path, {
      ...(options || {}),
      download: true,
      filename,
    });

    if (cb) {
      cb();
    }

    return this;
  }

  async handleNotFound() {
    if (this.headersSent) {
      return this;
    }

    this.options.status = 404;
    this.options.statusText = 'Not Found';
    this.response = new Response(undefined, this.options);
    return this;
  }

  async sendFile(
    path: string,
    options: SendFileOptions & {
      download?: boolean;
      filename?: string;
    },
  ) {
    options = options || {};
    const maxAge = get(options, 'maxAge', 0);
    const root = get(options, 'root', process.cwd());
    const lastModified = get(options, 'lastModified', true);
    const headers = get(options, 'headers', {});
    const download = get(options, 'download', false);
    const filename = get(options, 'filename');
    // const dotFiles = get(options, 'dotfiles', 'ignore');
    // const acceptRanges = get(options, 'accepRanges', true);
    const cacheControl = get(options, 'cacheControl', true);
    const immutable = get(options, 'immutable', false);

    const file = Bun.file(joinPath(root, path));
    const exists = await file.exists();

    if (!exists) {
      return this.handleNotFound();
    }

    if (isObject(headers)) {
      each(headers, (value, key) => {
        this.headersObj.set(key, value);
      });
    }

    if (download) {
      this.headersObj.set(
        'Content-Disposition',
        `attachment; filename="${filename || file.name}"`,
      );
    }

    if (lastModified) {
      const date = new Date(file.lastModified * 1000);
      if (isDateValid(date)) {
        const formattedDateStr = formatDate(
          date,
          'eee, dd MMM yyyy hh:mm:ss GMT',
        );
        this.headersObj.set('Last-Modified', formattedDateStr);
      }
    }

    if (cacheControl) {
      this.headersObj.delete('Cache-Control');

      if (maxAge && maxAge !== '0') {
        this.headersObj.append('Cache-Control', String(maxAge));
      }

      if (immutable) {
        this.headersObj.append('Cache-Control', 'immutable');
      }
    } else {
      this.headersObj.delete('Cache-Control');
    }

    this.headersObj.set(
      'Content-Disposition',
      `attachment; filename="${filename || file.name}"`,
    );
    this.headersObj.set('Content-Type', file.type);
    this.options.headers = this.headersObj;

    if (this.headersSent) {
      return this;
    }

    this.response = new Response(file, this.options);
    return this;
  }

  async get(name: string, defaultVal: string | string[]) {
    const value = this.headersObj.get(name);
    if (!isString(value)) {
      return defaultVal;
    }

    return values;
  }

  public sendStatus(status: number) {
    if (this.headersSent) {
      return;
    }

    this.options.headers = this.headersObj;
    this.response = new Response(String(status), this.options);
    return this;
  }

  public set(name: string, value: string | string[], replace = true) {
    return this.setHeader(name, value, replace);
  }
}
