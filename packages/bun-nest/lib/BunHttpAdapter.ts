import { type AddressInfo, isIPv4, isIPv6 } from "node:net";
import process from "node:process";
import { isPromise } from "node:util/types";
import {
  BunRequest,
  BunResponse,
  BunRouter,
  type BunServeOptions,
  type BunServer,
  type NestExpressBodyParserOptions,
  type NestExpressBodyParserType,
  type NextFunction,
  type RouterErrorMiddlewareHandler,
  type RouterHandler,
  type RouterMiddlewareHandler,
  type ServeStaticOptions,
  type matchedRoute,
} from "@kingsleyweb/bun-common";
import {
  BadGatewayException,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  type RequestMethod,
  StreamableFile,
  VERSION_NEUTRAL,
  VersioningType,
} from "@nestjs/common";
import type {
  VersionValue,
  VersioningOptions,
} from "@nestjs/common/interfaces";
import type { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface";
import { AbstractHttpAdapter } from "@nestjs/core";
import { type Server, peek } from "bun";
import cors, { type CorsOptions as BunCorsOptions } from "cors";
import getPort from "get-port";
import {
  get,
  has,
  isFunction,
  isNull,
  isObject,
  isString,
  isUndefined,
  omit,
  set,
} from "lodash-es";
import pollUntil from "until-promise";
import { BunWebSocketAdapter } from "./BunWebSocketAdapter";

type VersionedRoute = (
  req: BunRequest,
  res: BunResponse,
  next: () => void,
) => Function;

type WebsocketOptions = ConstructorParameters<typeof BunWebSocketAdapter>[1];

export class BunHttpAdapter extends AbstractHttpAdapter<
  BunServer,
  BunRequest,
  BunResponse
> {
  public override instance: InstanceType<typeof BunRouter>;
  private readonly logger = new Logger("bun");
  private _websocketAdapter!: BunWebSocketAdapter;
  private _serverInstance: BunServer | undefined = undefined;
  private _listeningHost = "127.0.0.1";
  private _listeningPort: string | number = 3000;
  protected isServerListening = false;
  private serverOptions: BunServeOptions | undefined = undefined;
  private _httpServerHandlers: ((...args: unknown[]) => unknown)[] = [];
  private _notFoundHandlers: RouterMiddlewareHandler[] = [];
  private _errorHandlers: RouterErrorMiddlewareHandler[] = [];
  private _hasRegisteredBodyParser = false;

  constructor(
    private requestTimeout = 0,
    wsOptions?: WebsocketOptions,
  ) {
    const router = new BunRouter();
    super(router);
    this.instance = router;
    super.setInstance(router);

    this._websocketAdapter = new BunWebSocketAdapter(this, {
      router,
      newInstance: false,
      getServer: () => {
        return this.getBunServer();
      },
      ...wsOptions,
    } as unknown as WebsocketOptions);
    this.instance.setBunWebSocket(this._websocketAdapter);

    // Bypass event handlers added to httpServer and call of address
    const proxiedHttpServer = new Proxy(
      {},
      {
        get: (_, prop) => {
          switch (true) {
            case ["on", "once", "addEventListener"].includes(prop as string): {
              return (
                event: "error",
                handler: (...args: unknown[]) => unknown,
              ) => {
                if (event === "error") {
                  this._httpServerHandlers.push(handler);
                }
              };
            }

            case ["off", "removeListener"].includes(prop as string): {
              return (
                event: string,
                handler: (...args: unknown[]) => unknown,
              ) => {
                if (event === "error") {
                  const errorHandlerIndex = this._httpServerHandlers.findIndex(
                    (savedHandler) => savedHandler === handler,
                  );

                  if (errorHandlerIndex > -1) {
                    this._httpServerHandlers.splice(errorHandlerIndex, 1);
                  }
                }
              };
            }

            case prop === "address": {
              let port = this._listeningPort || 3000;
              let hostname = this._listeningHost || "127.0.0.1";
              let address: AddressInfo | undefined;

              if (this.isServerListening && this._serverInstance) {
                hostname = this._serverInstance.hostname;
                port = this._serverInstance.port;
                address = get(this._serverInstance, "address", undefined) as
                  | AddressInfo
                  | undefined;
              }

              return () => {
                if (address) {
                  return address;
                }

                return {
                  address: hostname,
                  family: "IPv4",
                  port,
                };
              };
            }

            case prop === "then": {
              return new Promise(async (resolve) => {
                await pollUntil(
                  () => this._serverInstance && this.isServerListening,
                  (isReady) => !!isReady,
                );

                resolve(this._serverInstance);
              });
            }

            default: {
              return this._serverInstance && has(this._serverInstance, prop)
                ? get(this._serverInstance, prop, undefined)
                : undefined;
            }
          }
        },
      },
    );

    this.setHttpServer(proxiedHttpServer as unknown as BunServer);
  }

  get webSocketAdapter() {
    return this._websocketAdapter;
  }

  public get isListening() {
    return this.isServerListening;
  }

  public get listeningHost() {
    return this._listeningHost;
  }

  public get listeningPort() {
    return this._listeningPort;
  }

  public async getListenAddress() {
    await pollUntil(
      () => this._serverInstance?.url,
      (url) => !!url,
    );

    return this._serverInstance?.url;
  }

  // Adjust use to behave like express use
  public override use(path: RouterHandler): this;
  public override use(path: string, handler: RouterHandler): this;
  public override use(
    path: string | RouterHandler,
    handler?: RouterHandler,
  ): this {
    const mainHandler: RouterMiddlewareHandler | RouterErrorMiddlewareHandler =
      isString(path) && handler && isFunction(handler)
        ? handler
        : isFunction(path)
          ? path
          : (((_, __, next) => {
              if (next) {
                next();
              }
            }) as RouterMiddlewareHandler);

    if (this && this.instance && this.instance.use) {
      if (isString(path) && isFunction(mainHandler)) {
        this.instance.all(path, mainHandler);
      } else {
        this.instance.use(mainHandler);
      }
    } else {
      // console.log(
      //   'Called before "use" is instantiated =====> ',
      //   path,
      //   mainHandler.toString(),
      // );
    }

    return this;
  }

  public getHeader(response: BunResponse, name: string) {
    return response.getHeader(name);
  }

  public appendHeader(response: BunResponse, name: string, value: string) {
    response.appendHeader(name, value);
  }

  public getBunServer() {
    return this._serverInstance;
  }

  public async setListenOptions(
    options: Partial<BunServeOptions> & {
      hostname?: string;
      port: string | number;
    },
    restartInstance = false,
  ): Promise<Server | undefined> {
    const hostname = options.hostname || "127.0.0.1";
    const port = options.port;

    this._listeningHost = hostname;
    this._listeningPort = port;

    this.serverOptions = omit(options, ["hostname", "port"]);

    if (restartInstance && this.isServerListening && this._serverInstance) {
      this._serverInstance.stop(false);
      this.isServerListening = false;
      return await this.listen(this._listeningPort, this._listeningHost);
    }

    return undefined;
  }

  private registerBodyParser(
    prefix?: string | undefined,
    rawBody?: boolean,
    options?: NestExpressBodyParserOptions,
  ) {
    if (this._hasRegisteredBodyParser) {
      return;
    }

    const middlewareHandler: RouterMiddlewareHandler = async (req, _, next) => {
      const buffer = await req.handleBodyParsing(true, options);
      if (rawBody) {
        set(req, "rawBody", buffer);
      }

      if (next) {
        next();
      }
    };

    if (isString(prefix) && prefix) {
      this.use(prefix, middlewareHandler);
    } else {
      this.use(middlewareHandler);
    }
  }

  public useBodyParser(
    _: NestExpressBodyParserType,
    rawBody: boolean,
    options: NestExpressBodyParserOptions,
  ) {
    this.registerBodyParser(undefined, rawBody, options);
  }

  public override async listen(
    port: string | number,
    callback?: (...args: unknown[]) => void,
  ): Promise<BunServer>;
  public override async listen(
    port: string | number,
    hostname: string,
    callback?: (...args: unknown[]) => void,
  ): Promise<BunServer>;
  public override async listen(
    port: number | string,
    hostname?: string | ((...args: unknown[]) => void),
    callback?: (...args: unknown[]) => void,
  ) {
    if (this.isServerListening) {
      return this.httpServer;
    }

    hostname = isFunction(hostname) ? "127.0.0.1" : hostname;
    if (!hostname || !(isIPv4(hostname) || isIPv6(hostname))) {
      hostname = "127.0.0.1";
    }

    callback = isFunction(hostname)
      ? hostname
      : isFunction(callback)
        ? callback
        : () => undefined;

    port = Number(port);
    const portsToTest: number[] = [port];

    while (portsToTest.length < 10) {
      portsToTest.push(port + portsToTest.length);
    }

    const availablePort = await getPort({
      host: hostname,
      port: portsToTest,
    });

    this._listeningHost = hostname;
    this._listeningPort = availablePort;
    let isListening = false;

    try {
      // eslint-disable-next-line ts/no-this-alias
      const that = this;
      const serverInstance = Bun.serve({
        ...(this.serverOptions || {}),
        port: this._listeningPort,
        hostname: this._listeningHost,
        development: Bun.env.NODE_ENV !== "production",
        async fetch(nativeRequest: Request, server) {
          const req = new BunRequest(nativeRequest, server, {
            canHandleUpload: true,
          });

          const res = new BunResponse(req);
          let routeUsed: matchedRoute | true | undefined;

          try {
            routeUsed = await that.instance.handle({
              requestHost: req.host,
              requestMethod: req.method,
              response: res,
              request: req,
              requestUrl: req.originalUrl,
            });
          } catch (e) {
            let err = e;
            if (!isObject(err)) {
              err = new Error(String(e));
            }

            set(err as unknown as Record<string, unknown>, "req", req);
            throw err;
          }

          let hasNativeResponse = false;
          if (routeUsed) {
            hasNativeResponse = true;
          } else if (that._notFoundHandlers.length) {
            let continueProcessingHandlers = true;
            const next: NextFunction = (err) => {
              if (!(isUndefined(err) || isNull(err))) {
                continueProcessingHandlers = false;
              }
            };

            for await (const handler of that._notFoundHandlers) {
              if (!continueProcessingHandlers) {
                break;
              }

              const resp = await handler(req, res, next);
              continueProcessingHandlers = !!resp;
            }

            hasNativeResponse = true;
          }

          if (hasNativeResponse) {
            const nativeResponse = await res.getNativeResponse(
              that.requestTimeout,
            );
            return nativeResponse;
          }

          return new Response(undefined, {
            status: 400,
            statusText: "Not Found",
          });
        },
        websocket: that.webSocketAdapter.wsHandler,
        async error(err) {
          const req = get(err, "req", undefined) as BunRequest | undefined;
          if (!req) {
            throw err;
          }

          let continueProcessingHandlers = true;
          const next: NextFunction = (err) => {
            if (!(isUndefined(err) || isNull(err))) {
              continueProcessingHandlers = false;
            }
          };

          const response = new BunResponse(req);
          for await (const handler of that._errorHandlers) {
            if (!continueProcessingHandlers) {
              break;
            }

            const resp = await handler(err, req, response, next);
            continueProcessingHandlers = !!resp;
          }

          if (that._errorHandlers.length) {
            const nativeResponse = await response.getNativeResponse(1000);
            return nativeResponse;
          } else {
            throw err;
          }
        },
      });

      isListening = true;
      this._serverInstance = serverInstance;

      await pollUntil(
        () => isListening,
        (isListening) => !!isListening,
      );

      this._serverInstance = serverInstance;
      this.isServerListening = true;

      if (callback) {
        callback(serverInstance);
      }
      return serverInstance;
    } catch (e) {
      const errorMessage = "Error while binding to listener...";
      console.log(errorMessage);
      console.log(e);
      this.logger.log(errorMessage);
      this.logger.log(e);
      process.exit(1);
    }
  }

  public reply(
    response: BunResponse,
    body:
      | StreamableFile
      | string
      | Record<string, unknown>
      | BunResponse
      | Response
      | null
      | undefined,
    statusCode?: number,
  ) {
    if (statusCode) {
      response = response.status(statusCode);
    }

    const responseContentType = response.getHeader("Content-Type");
    if (body instanceof StreamableFile) {
      const streamHeaders = body.getHeaders();
      if (
        responseContentType === undefined &&
        streamHeaders.type !== undefined
      ) {
        response.setHeader("Content-Type", streamHeaders.type);
      }
      if (
        response.getHeader("Content-Disposition") === undefined &&
        streamHeaders.disposition !== undefined
      ) {
        response.setHeader("Content-Disposition", streamHeaders.disposition);
      }
      if (
        response.getHeader("Content-Length") === undefined &&
        streamHeaders.length !== undefined
      ) {
        response.setHeader("Content-Length", String(streamHeaders.length));
      }

      return response.send(body.getStream());
    }

    const bodyToBeSent = body as Parameters<BunResponse["send"]>[0];

    return response.send(bodyToBeSent);
  }

  public status(response: BunResponse, statusCode: number) {
    return response.status(statusCode);
  }

  public end(response: BunResponse, message?: string) {
    return response.headersSent ? undefined : response.send(message);
  }

  public render(response: BunResponse, view: string, options: any) {
    const file = Bun.file(view);
    response.setHeader("Content-Type", file.type);
    return response.status(options.status || 200).send(file.stream());
  }

  public redirect(response: BunResponse, statusCode: number, url: string) {
    response.setHeader("Location", url);
    return response.status(statusCode || 302);
  }

  public isHeadersSent(response: BunResponse) {
    return !isPromise(peek(response.getNativeResponse()));
  }

  public setHeader(response: BunResponse, name: string, value: string) {
    response.setHeader(name, value);
  }

  public setErrorHandler(handler: RouterErrorMiddlewareHandler) {
    this._errorHandlers.push(handler);
  }

  public setNotFoundHandler(handler: RouterMiddlewareHandler) {
    this._notFoundHandlers.push(handler);
  }

  public useStaticAssets(path: string, options: ServeStaticOptions) {
    const prefix = String(options.prefix || "").toLocaleLowerCase();

    return this.get(
      `${prefix}/*`,
      async (req: BunRequest, res: BunResponse) => {
        let properPath = req.path.toLocaleLowerCase();
        if (properPath.startsWith(prefix)) {
          properPath = properPath.substring(prefix.length);
        }

        if (!properPath.startsWith("/")) {
          properPath = `/${properPath}`;
        }

        const filePath = path + properPath;
        try {
          const file = Bun.file(filePath);
          if (await file.exists()) {
            res.setHeader(
              "Content-Type",
              file.type || "application/octet-stream",
            );

            res.setHeader("Content-Length", String(file.size));
            return res.status(200).send(file);
          } else {
            throw new NotFoundException(`${req.path} cannot be found`);
          }
        } catch (e) {
          if (!(e instanceof NotFoundException)) {
            const errorMessage = "Error in use static assets is ====> ";
            console.log(errorMessage);
            console.log(e);
            this.logger.log(errorMessage);
            this.logger.log(e);
          }

          if (e instanceof HttpException) {
            throw e;
          }

          // cd ../
          throw new BadGatewayException(
            "An error occurred while fetching static assets file",
          );
          //
        }
      },
    );
  }

  public setViewEngine(engineOrOptions: unknown) {
    if (engineOrOptions) return this;
    return this;
  }

  public createMiddlewareFactory(
    requestMethod: RequestMethod,
  ): (path: string, callback: Function) => unknown {
    if (requestMethod) {
      return this.use.bind(this.instance) as unknown as (
        path: string,
        callback: Function,
      ) => unknown;
    }

    return this.use.bind(this.instance) as unknown as (
      path: string,
      callback: Function,
    ) => unknown;
  }

  public getRequestHostname(request: BunRequest): string {
    const defaultHostname = "127.0.0.1";
    const headerHost = request.host;
    return headerHost || defaultHostname;
  }

  public getRequestMethod(request: BunRequest): string {
    return request.method;
  }

  public getRequestUrl(request: BunRequest): string {
    return request.originalUrl;
  }

  public registerParserMiddleware(prefix?: string, rawBody?: boolean) {
    this.registerBodyParser(prefix, rawBody, {
      inflate: true,
    });
  }

  public enableCors(options: CorsOptions) {
    const corsResp = cors(
      options as unknown as BunCorsOptions,
    ) as unknown as RouterMiddlewareHandler;

    // Add Middle ware to ensure cors header is added
    this.use(corsResp);

    // Add options route Handler
    this.options("*", (req: BunRequest, res: BunResponse, next) => {
      return corsResp(req, res, next as NextFunction);
    });

    return this;
  }

  public async initHttpServer() {
    if (this._serverInstance) {
      this.httpServer = this._serverInstance;
    }
  }

  public async close() {
    try {
      if (this._serverInstance && this.isServerListening) {
        await this._serverInstance.stop(false);
      }
    } catch (err) {
      //
    }

    this._serverInstance = undefined;
    this.isServerListening = false;
    this._httpServerHandlers = [];
    this._errorHandlers = [];
    this._notFoundHandlers = [];
  }

  public getType(): string {
    return "express";
  }

  public applyVersionFilter(
    handler: Function,
    version: VersionValue,
    versioningOptions: VersioningOptions,
  ): VersionedRoute {
    const callNextHandler: VersionedRoute = (_, __, next) => {
      if (!next) {
        throw new InternalServerErrorException(
          "HTTP adapter does not support filtering on version",
        );
      }

      return next() as unknown as Function;
    };

    const handlerForNoVersioning: VersionedRoute = (req, res, next) =>
      handler(req, res, next);

    if (
      version === VERSION_NEUTRAL ||
      // URL Versioning is done via the path, so the filter continues forward
      versioningOptions.type === VersioningType.URI
    ) {
      return handlerForNoVersioning;
    }

    // Custom Extractor Versioning Handler
    if (versioningOptions.type === VersioningType.CUSTOM) {
      const handlerForCustomVersioning: VersionedRoute = (req, res, next) => {
        const extractedVersion = versioningOptions.extractor(req);

        if (Array.isArray(version)) {
          if (
            Array.isArray(extractedVersion) &&
            version.filter((v) => extractedVersion.includes(v as string)).length
          ) {
            return handler(req, res, next);
          }

          if (
            isString(extractedVersion) &&
            version.includes(extractedVersion)
          ) {
            return handler(req, res, next);
          }
        } else if (isString(version)) {
          // Known bug here - if there are multiple versions supported across separate
          // handlers/controllers, we can't select the highest matching handler.
          // Since this code is evaluated per-handler, then we can't see if the highest
          // specified version exists in a different handler.
          if (
            Array.isArray(extractedVersion) &&
            extractedVersion.includes(version)
          ) {
            return handler(req, res, next);
          }

          if (isString(extractedVersion) && version === extractedVersion) {
            return handler(req, res, next);
          }
        }

        return callNextHandler(req, res, next);
      };

      return handlerForCustomVersioning;
    }

    // Media Type (Accept Header) Versioning Handler
    if (versioningOptions.type === VersioningType.MEDIA_TYPE) {
      const handlerForMediaTypeVersioning: VersionedRoute = (
        req,
        res,
        next,
      ) => {
        const MEDIA_TYPE_HEADER = "Accept";
        const acceptHeaderValue: string | undefined =
          req.getHeader(MEDIA_TYPE_HEADER) ||
          req.getHeader(MEDIA_TYPE_HEADER.toLowerCase()) ||
          undefined;

        const acceptHeaderVersionParameter = acceptHeaderValue
          ? acceptHeaderValue.split(";")[1]
          : undefined;

        // No version was supplied
        if (isUndefined(acceptHeaderVersionParameter)) {
          if (Array.isArray(version)) {
            if (version.includes(VERSION_NEUTRAL)) {
              return handler(req, res, next);
            }
          }
        } else {
          const headerVersion = acceptHeaderVersionParameter.split(
            versioningOptions.key,
          )[1];

          if (headerVersion) {
            if (Array.isArray(version)) {
              if (version.includes(headerVersion)) {
                return handler(req, res, next);
              }
            } else if (isString(version)) {
              if (version === headerVersion) {
                return handler(req, res, next);
              }
            }
          }
        }

        return callNextHandler(req, res, next);
      };

      return handlerForMediaTypeVersioning;
    }

    // Header Versioning Handler
    if (versioningOptions.type === VersioningType.HEADER) {
      const handlerForHeaderVersioning: VersionedRoute = (req, res, next) => {
        const customHeaderVersionParameter: string | undefined =
          req.getHeader(versioningOptions.header) ||
          req.getHeader(versioningOptions.header.toLowerCase()) ||
          undefined;

        // No version was supplied
        if (isUndefined(customHeaderVersionParameter)) {
          if (Array.isArray(version)) {
            if (version.includes(VERSION_NEUTRAL)) {
              return handler(req, res, next);
            }
          }
        } else {
          if (Array.isArray(version)) {
            if (version.includes(customHeaderVersionParameter)) {
              return handler(req, res, next);
            }
          } else if (isString(version)) {
            if (version === customHeaderVersionParameter) {
              return handler(req, res, next);
            }
          }
        }

        return callNextHandler(req, res, next);
      };

      return handlerForHeaderVersioning;
    }

    return handlerForNoVersioning;
  }
}
