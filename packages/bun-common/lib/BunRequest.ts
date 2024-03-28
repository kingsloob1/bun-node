import type { SocketAddress } from 'bun';
import {
  get,
  isArray,
  isString,
  each,
  cloneDeep,
  isNull,
  flattenDeep,
  isUndefined,
  isObject,
  keys,
  merge,
  values,
  isBoolean,
  omit,
  first,
} from 'lodash-es';
import type {
  BunRequestInterface,
  BunServer,
  MultiPartExpandedFileRecord,
  MultiPartFieldRecord,
  MultiPartFileRecord,
  MultiPartOptions,
  NestExpressBodyParserOptions,
} from './types/general';
import ucwords from 'locutus/php/strings/ucwords';
import {
  parseDomain,
  ParseResultType,
  type ParseResult,
  Validation,
} from 'parse-domain';
import busboy from 'busboy';
import { fileTypeFromBuffer, type FileTypeResult } from 'file-type';
import { Readable } from 'stream';
import qs from 'qs';
import { streamToBuffer } from './utils/general';
import type { StorageExpandedFile, StorageFile } from './multipart';

export class BunRequest implements BunRequestInterface {
  private headerNamesWithMultiple: string[] = [
    'cache-control',
    'X-Forwarded-For',
  ];
  public headers: Record<string, string | string[]> = {};
  public headersObj: InstanceType<typeof Headers>;
  public parsedUrl: InstanceType<typeof URL>;
  public maxHeadersCount = 0;
  public reusedSocket = false;
  private _body:
    | string
    | Record<string, unknown>
    | Buffer
    | unknown[]
    | null
    | undefined = undefined;
  public cookies = {};
  public signedCookies = false;
  public url: string;
  public params: Record<string, string> = {};
  public query: Record<string, unknown> = {};
  public route = null;
  private readonly socketAddress: SocketAddress | null = null;
  private readonly parsedDomainResult: ParseResult;
  private _files: Record<string, File> = {};
  private _contentType: 'json' | 'text' | 'buffer' | 'form' | undefined =
    undefined;
  private _isFormParsed = false;
  private _buffer: Buffer | undefined = undefined;
  private _storageFiles:
    | StorageFile[]
    | Record<string, StorageFile[]>
    | StorageExpandedFile<StorageFile> = [];
  public subdomains: string[] = [];

  constructor(
    private request: Request,
    private server: BunServer,
    private options: {
      canHandleUpload: Boolean;
    } = {
      canHandleUpload: true,
    },
  ) {
    this.headersObj = request.headers as Headers;
    this.parsedUrl = new URL(request.url);
    this.headers = this.getHeaders();
    this.socketAddress = this.server.requestIP(this.request);
    this.url = this.request.url;
    this.parsedDomainResult = parseDomain(this.parsedUrl.hostname, {
      validation: Validation.Lax,
    });

    this.parsedUrl.searchParams.forEach((v, k) => {
      this.query[k] = v;
    });

    this.extractSubdomains();
  }

  get buffer() {
    return this._buffer;
  }

  get body():
    | string
    | Record<string, unknown>
    | Buffer
    | unknown[]
    | null
    | undefined {
    return this._body;
  }

  set body(
    data:
      | string
      | Record<string, unknown>
      | Buffer
      | unknown[]
      | null
      | undefined,
  ) {
    this._body = data;
  }

  get storageFiles() {
    return this._storageFiles;
  }

  get storageFile() {
    if (isArray(this._storageFiles)) {
      return first(this._storageFiles);
    }

    if (isObject(this._storageFiles)) {
      return first(values(this._storageFiles)) as
        | StorageFile
        | StorageExpandedFile<StorageFile>;
    }

    return undefined;
  }

  set storageFiles(
    files:
      | StorageFile[]
      | StorageExpandedFile<StorageFile>
      | Record<string, StorageFile[]>,
  ) {
    this.setStorageFiles(files);
  }

  get files() {
    return this.storageFiles;
  }

  get file() {
    return this.storageFile;
  }

  setStorageFiles(
    files:
      | StorageFile[]
      | Record<string, StorageFile[]>
      | StorageExpandedFile<StorageFile>,
  ) {
    if (
      (isArray(files) && files.every((file) => isObject(file))) ||
      isObject(files)
    ) {
      this._storageFiles = files;
    }
  }

  private extractSubdomains() {
    let subdomains: string[] = [];
    if (this.parsedDomainResult.type === ParseResultType.Listed) {
      subdomains = this.parsedDomainResult.subDomains;
    }

    if (
      [ParseResultType.NotListed, ParseResultType.Reserved].includes(
        this.parsedDomainResult.type,
      )
    ) {
      const list = get(this.parsedDomainResult, 'labels', []);
      subdomains = list.slice(0, -2);
    }

    this.subdomains = subdomains;
    return subdomains;
  }

  get isFormDataParsed() {
    return this._isFormParsed;
  }

  public async getMultiParts(
    options: MultiPartOptions,
  ): Promise<
    (MultiPartFileRecord | MultiPartFieldRecord | MultiPartExpandedFileRecord)[]
  > {
    if (this._isFormParsed) {
      return [];
    }

    if (!this.buffer) {
      return [];
    }

    const buffer = await this.buffer;
    return new Promise((resolve, reject) => {
      let parts: (
        | MultiPartFileRecord
        | MultiPartFieldRecord
        | MultiPartExpandedFileRecord
      )[] = [];
      let { inflate, fileInflator, fieldInflator } = options;
      const busBoyOpts = omit(options, [
        'inflate',
        'fileInflator',
        'fieldInflator',
      ]);

      if (!isBoolean(inflate)) {
        inflate = true;
      }

      const recursivelyReplacePlaceholder = (
        obj: Record<string, unknown>,
        replacement: unknown,
        valueToReplace: unknown,
      ) => {
        values(obj).forEach((value, key) => {
          if (value === valueToReplace) {
            obj[key] = replacement;
          } else if (isObject(value)) {
            recursivelyReplacePlaceholder(
              value as Record<string, unknown>,
              replacement,
              valueToReplace,
            );
          } else if (isString(value) && value === 'x') {
            obj[key] = replacement;
          }
        });
      };

      if (inflate) {
        if (!fileInflator) {
          fileInflator = async (
            fieldname: string,
            file: Buffer,
            // opts: FileInfo,
          ) => {
            const parsedObj = qs.parse(`${fieldname}=x`, {
              depth: 100,
              ignoreQueryPrefix: true,
              allowDots: true,
              allowEmptyArrays: true,
              arrayLimit: 999999999,
              allowSparse: true,
            });

            if (isObject(parsedObj)) {
              recursivelyReplacePlaceholder(parsedObj, file, 'x');
              return { [fieldname]: parsedObj };
            }

            return { [fieldname]: file };
          };
        }

        if (!fieldInflator) {
          fieldInflator = async (
            fieldname: string,
            value: string,
            // opts: FieldInfo,
          ) => {
            try {
              let parsedData: Record<string, unknown> | undefined = undefined;

              try {
                const parsedJSONstring = value.replace(/\\\\"/g, '"');
                const parsedValue = JSON.parse(parsedJSONstring);
                parsedData = { [fieldname]: parsedValue };
              } catch {
                //
              }

              if (!isObject(parsedData)) {
                parsedData = qs.parse(`${fieldname}=${value}`, {
                  depth: 100,
                  ignoreQueryPrefix: true,
                  allowDots: true,
                  allowEmptyArrays: true,
                  arrayLimit: 999999999,
                  allowSparse: true,
                });
              }

              if (isObject(parsedData)) {
                return parsedData;
              } else {
                throw new Error('Failed to parse form data field');
              }
            } catch {
              //
            }

            return { [fieldname]: value };
          };
        }
      }

      try {
        const bb = busboy({ ...busBoyOpts, headers: this.headers });
        let filesState: boolean[] = [];
        let fieldState: boolean[] = [];

        bb.on('file', async (name, file, info) => {
          const filesStateIndex = filesState.length;
          filesState[filesStateIndex] = false;

          const fileBuffer = await streamToBuffer(file as unknown as Readable);
          let mimeTypeResp: FileTypeResult | undefined = undefined;

          try {
            mimeTypeResp = await fileTypeFromBuffer(fileBuffer);
          } catch (e) {
            if (Bun.env.NODE_ENV === 'development') {
              console.log('Error here is =====> ', e);
            }

            throw e;
            //
          }

          let pushFile = false;

          if (inflate && fileInflator) {
            try {
              const parsedData = await fileInflator(name, fileBuffer, info);
              const fileData: MultiPartFileRecord = {
                ...info,
                validatedMimeType: mimeTypeResp,
                fieldname: name,
                originalFilename: info.filename,
                file: fileBuffer,
                type: 'file',
              };

              //Replace file buffer with file formatted data
              recursivelyReplacePlaceholder(parsedData, fileData, fileBuffer);
              const expandedFileIndex = parts.findIndex(
                (part) => part.type === 'expanded-file',
              );

              const expandedFileMap = (
                expandedFileIndex > -1
                  ? parts[expandedFileIndex]
                  : {
                      type: 'expanded-file',
                      values: {},
                    }
              ) as MultiPartExpandedFileRecord;

              keys(parsedData).forEach((key) => {
                if (!parsedData) {
                  return;
                }

                let parsedDataValue:
                  | unknown[]
                  | unknown
                  | Record<string, unknown>
                  | string
                  | null
                  | undefined = parsedData[key];

                const expandedFileData = expandedFileMap.values[key];
                if (expandedFileData) {
                  if (isArray(expandedFileData) && isArray(parsedDataValue)) {
                    parsedDataValue = [
                      ...(expandedFileData as unknown[]),
                      ...parsedDataValue,
                    ];
                  } else if (
                    isObject(expandedFileData) &&
                    isObject(parsedDataValue)
                  ) {
                    parsedDataValue = merge(
                      {},
                      expandedFileData as Record<string, unknown>,
                      parsedDataValue,
                    );
                  }
                }

                expandedFileMap.values[key] = parsedDataValue as
                  | MultiPartExpandedFileRecord
                  | MultiPartFileRecord[];
              });

              if (expandedFileIndex > -1) {
                parts[expandedFileIndex] = expandedFileMap;
              } else {
                parts.push(expandedFileMap);
              }
            } catch {
              pushFile = true;
            }
          } else {
            pushFile = true;
          }

          if (pushFile) {
            parts.push({
              ...info,
              validatedMimeType: mimeTypeResp,
              fieldname: name,
              originalFilename: info.filename,
              file: fileBuffer,
              type: 'file',
            });
          }

          filesState[filesStateIndex] = true;
        });

        bb.on('field', async (name, val, info) => {
          const fieldStateIndex = fieldState.length;
          fieldState[fieldStateIndex] = false;

          let pushField = false;
          if (inflate && fieldInflator) {
            try {
              const parsedData = await fieldInflator(name, val, info);
              if (isObject(parsedData)) {
                keys(parsedData).forEach((key) => {
                  if (!parsedData) {
                    return;
                  }

                  let parsedDataValue:
                    | unknown[]
                    | unknown
                    | Record<string, unknown>
                    | string
                    | null
                    | undefined = parsedData[key];
                  const partsIndex = parts.findIndex(
                    (part) => part.type === 'field' && part.fieldname === key,
                  );
                  if (partsIndex > -1) {
                    const partData = parts[partsIndex] as MultiPartFieldRecord;
                    const value = partData.value;

                    if (isArray(value) && isArray(parsedDataValue)) {
                      parsedDataValue = [
                        ...(value as unknown[]),
                        ...parsedDataValue,
                      ];
                    } else if (isObject(value) && isObject(parsedDataValue)) {
                      parsedDataValue = merge(
                        {},
                        value as Record<string, unknown>,
                        parsedDataValue,
                      );
                    }
                  }

                  const data: MultiPartFieldRecord = {
                    ...info,
                    fieldname: key,
                    value: parsedDataValue,
                    type: 'field' as const,
                  };

                  if (partsIndex > -1) {
                    parts[partsIndex] = data;
                  } else {
                    parts.push(data);
                  }
                });
              } else {
                pushField = true;
              }
            } catch {
              pushField = true;
            }
          } else {
            pushField = true;
          }

          if (pushField) {
            parts.push({
              ...info,
              fieldname: name,
              value: val,
              type: 'field',
            });
          }

          fieldState[fieldStateIndex] = true;
        });

        bb.on('close', async () => {
          await Promise.all([
            new Promise((resolve) => {
              const interval = setInterval(() => {
                if (
                  fieldState.length === 0 ||
                  fieldState.findIndex((state) => state === false) === -1
                ) {
                  clearInterval(interval);
                  resolve(true);
                }
              }, 1);
            }),
            new Promise((resolve) => {
              const interval = setInterval(() => {
                if (
                  filesState.length === 0 ||
                  filesState.findIndex((state) => state === false) === -1
                ) {
                  clearInterval(interval);
                  resolve(true);
                }
              }, 1);
            }),
          ]);

          filesState = [];
          fieldState = [];
          resolve(parts);
        });

        bb.on('error', (error) => {
          parts = [];
          reject(error);
        });
        Readable.from(buffer).pipe(bb);
      } catch (err) {
        parts = [];
        reject(err);
      }
    });
  }

  private async handleUrlFormEncodingParsing(data: string) {
    try {
      const parsedData = qs.parse(data, {
        depth: 100,
        ignoreQueryPrefix: true,
        allowDots: true,
        allowEmptyArrays: true,
        arrayLimit: 999999999,
        allowSparse: true,
      });

      if (isObject(parsedData) || isArray(parsedData)) {
        this._body = parsedData;
        this._contentType = 'form';
        this.setHeader('Content-Type', 'application/x-www-form-urlencoded');
        return true;
      }
    } catch (err) {
      //
    }

    throw new Error('Oops.. Form is not url encoded');
  }

  private async handleJsoonBodyParsing(data: string) {
    try {
      this._body = JSON.parse(data);
      this._contentType = 'json';
      this.setHeader('Content-Type', 'application/json');
      return true;
    } catch (err) {
      //
    }

    throw new Error('Oops.. Form is not JSON stringified');
  }

  public async handleBodyParsing(): Promise<undefined>;
  public async handleBodyParsing(returnBuffer: false): Promise<undefined>;
  public async handleBodyParsing(
    returnBuffer: true,
    options?: NestExpressBodyParserOptions,
  ): Promise<Buffer>;
  public async handleBodyParsing(
    returnBuffer = false,
    // options?: NestExpressBodyParserOptions,
  ): Promise<Buffer | undefined> {
    if (this.request.bodyUsed || !this.options.canHandleUpload) {
      if (returnBuffer && this._buffer) {
        return Buffer.from(this._buffer);
      }

      return;
    }

    let buffer: Buffer | undefined = undefined;
    try {
      buffer = Buffer.from(await this.request.arrayBuffer());
    } catch (e) {
      throw e;
      //
    }

    if (!buffer) {
      throw new Error('Invalid buffer object');
    }

    this._buffer = buffer;

    const bufferText = buffer.toString();
    const contentTypeHeader = this.getHeader('Content-Type');

    if (!contentTypeHeader) {
      try {
        await this.handleJsoonBodyParsing(bufferText);
      } catch {
        try {
          await this.handleUrlFormEncodingParsing(bufferText);
        } catch {
          this._body = buffer;
          this._buffer = buffer;
          this._contentType = 'buffer';
          this.setHeader('Content-Type', 'application/octet-stream');
        }
      }
    } else {
      switch (true) {
        case contentTypeHeader?.includes('application/json'): {
          try {
            await this.handleJsoonBodyParsing(bufferText);
          } catch (err) {
            //
          }
          break;
        }

        case contentTypeHeader?.includes('application/x-www-form-urlencoded'): {
          try {
            await this.handleUrlFormEncodingParsing(bufferText);
          } catch (err) {
            //
          }
          break;
        }

        case contentTypeHeader?.includes('multipart/form-data'): {
          //Leave the interceptors to handle this..
          break;
        }

        default: {
          try {
            this._body = buffer;
            this._buffer = buffer;
            this._contentType = 'buffer';
            this.setHeader('Content-Type', 'application/octet-stream');
          } catch (err) {
            //
          }
          break;
        }
      }
    }

    if (returnBuffer) {
      return buffer;
    }
  }

  get isBodyParsed() {
    return !!this._contentType;
  }

  get path() {
    return `${this.parsedUrl.pathname}${this.parsedUrl.search}${this.parsedUrl.hash}`;
  }

  get method() {
    return this.request.method.toUpperCase();
  }

  get host() {
    return this.parsedUrl.host || this.headersObj.get('Host') || '127.0.0.1';
  }

  get protocol() {
    return this.parsedUrl.protocol;
  }

  get hostname() {
    return this.parsedUrl.hostname;
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
        let value: string | string[] | null = this.headersObj.get(val);
        const valLower = val.toLowerCase().trim();

        if (isNull(value)) {
          return prev;
        }

        if (
          isString(value) &&
          (valLower.startsWith('accept-') ||
            ['cache-control', 'X-Forwarded-For'].includes(valLower))
        ) {
          value = value.split(',').map((ip) => ip.trimStart());
        }

        prev[val] = value;
        return prev;
      },
      {} as Record<string, string[] | string>,
    );
  }

  getRawHeaderNames() {
    return this.getHeaderNames().map((name) => ucwords(name));
  }

  hasHeader(name: string) {
    return this.headersObj.has(name);
  }

  removeHeader(name: string) {
    this.headersObj.delete(name);
    this.headers = this.getHeaders();
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
  }

  get ip() {
    return this.socketAddress?.address || '';
  }

  get ips() {
    return (this.headersObj.get('X-Forwarded-For') || '')
      .split(',')
      .map((ip) => ip.trimStart());
  }

  get originalUrl() {
    return this.path;
  }

  get headersDistinct() {
    const distinctHeaders = cloneDeep(this.headers);
    each(distinctHeaders, (value, key) => {
      distinctHeaders[key] = isArray(value) ? value : [value];
    });

    return distinctHeaders as Record<string, string[]>;
  }

  get httpVersion() {
    return '1.1' as const;
  }

  private get httpVersionArr() {
    return this.httpVersion.trim().split('.');
  }

  get httpVersionMajor() {
    return this.httpVersionArr[0];
  }

  get httpVersionMinor() {
    return this.httpVersionArr[1];
  }

  get rawHeaders() {
    return flattenDeep(Object.entries(this.headers));
  }

  get secure() {
    return this.protocol.toLowerCase() === 'https';
  }

  get xhr() {
    return (
      String(
        this.getHeader('X-Requested-With') ||
          this.getHeader('x-requested-with'),
      ) === 'XMLHttpRequest'
    );
  }

  //To-Do Refactor this method
  accepts(mime: string) {
    return String(this.headersObj.get('Accepts') || '')
      .toLowerCase()
      .includes(mime.toLowerCase());
  }

  get(name: string, defaultVal: string | string[] | undefined = undefined) {
    if (!isUndefined(defaultVal) && !this.hasHeader(name)) {
      return defaultVal as string | string[];
    }

    return this.getHeader(name);
  }

  //To-Do Refactor this method
  is(mime: string) {
    return !!mime;
  }

  end() {
    //
  }
}
