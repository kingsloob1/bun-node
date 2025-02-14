/* eslint-disable ts/ban-ts-comment */

/* eslint-disable ts/no-unsafe-function-type */

import type { BunRequestOptions } from "@kingsleyweb/bun-common/lib/BunHttpAdapter";
import type {
  CorsOptions,
  CorsOptionsDelegate,
} from "@nestjs/common/interfaces/external/cors-options.interface";
import type { BunFile, Server } from "bun";
import type { CorsOptions as MainCorsOptions } from "cors";
import { type AddressInfo, isIPv4, isIPv6 } from "node:net";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { isPromise } from "node:util/types";
import {
  type BodyParserOptions,
  type BodyParserType,
  BunRequest,
  BunResponse,
  BunRouter,
  type BunRouterOptions,
  type BunServeNormalOptions,
  type BunServeNormalTlsOptions,
  type BunServeOptions,
  type BunServer,
  type matchedRoute,
  type NextFunction,
  type RouterErrorMiddlewareHandler,
  type RouterHandler,
  type RouterMiddlewareHandler,
  type ServeStaticOptions,
} from "@kingsleyweb/bun-common";
import {
  InternalServerErrorException,
  Logger,
  RequestMethod,
  VERSION_NEUTRAL,
  VersioningType,
} from "@nestjs/common";
import { AbstractHttpAdapter } from "@nestjs/core/adapters/http-adapter";
import cors from "cors";
import EventEmitter from "eventemitter3";
import getPort from "get-port";
import {
  each,
  get,
  isFunction,
  isNull,
  isObject,
  isString,
  isUndefined,
  omit,
  set,
} from "lodash-es";
import pollUntil from "until-promise";
import { BunNestWebsocketAdapter } from "./BunWebSocketAdapter";

export type VersionedRoute = (
  req: BunRequest,
  res: BunResponse,
  next: NextFunction,
) => Function;

export type WebsocketOptions = ConstructorParameters<
  typeof BunNestWebsocketAdapter
>[1];

export type MiddlewareFactoryRespType = (
  path: string,
  callback: Function,
) => unknown;

type ApplyVersionFilterParameters = Parameters<
  AbstractHttpAdapter["applyVersionFilter"]
>;

// @ts-ignore
export class BunHttpAdapter extends AbstractHttpAdapter<
  BunServer,
  BunRequest,
  BunResponse
> {
  declare public instance: BunRouter;
  declare public httpServer: BunServer;
  #requestOpts!: BunRequestOptions;

  public _logger!: Logger;
  private _websocketAdapter!: BunNestWebsocketAdapter;
  private _serverInstance: BunServer | undefined = undefined;
  private _listeningHost = "127.0.0.1";
  private _listeningPort: string | number = 3000;
  protected isServerListening = false;
  private serverOptions:
    | BunServeNormalOptions
    | BunServeNormalTlsOptions
    | undefined = undefined;

  private _notFoundHandlers: RouterMiddlewareHandler[] = [];
  private _errorHandlers: RouterErrorMiddlewareHandler[] = [];
  private _hasRegisteredBodyParser = false;
  public readonly eventEmitter = new EventEmitter();

  constructor(
    protected requestTimeout = 0,
    options?: {
      request?: BunRequestOptions;
      websocket?: Partial<WebsocketOptions>;
      logger?: Logger;
      router?: BunRouterOptions;
      server?: BunServeNormalOptions | BunServeNormalTlsOptions;
    },
  ) {
    const websocketOptions = options?.websocket || {};
    const routerOptions = options?.router || {
      caseSensitive: true,
      debug: false,
    };
    const router = new BunRouter(routerOptions);
    super(router);

    const logger = options?.logger || new Logger();
    this.setInstance(router);

    this.requestOpts = options?.request || {
      parseBody: true,
      parseCookies: true,
    };

    this.logger = logger;
    this.serverOptions = options?.server || {};
    this.webSocketAdapter = new BunNestWebsocketAdapter(this, {
      router: this,
      newInstance: false,
      getServer: () => {
        return this.getBunServer();
      },
      ...websocketOptions,
    } as unknown as WebsocketOptions);

    this.defineHttpServer();
  }

  get requestOpts() {
    return this.#requestOpts;
  }

  set requestOpts(opts: BunRequestOptions) {
    this.#requestOpts = opts;
  }

  setRequestOpts(opts: BunRequestOptions) {
    this.requestOpts = opts;
    return this;
  }

  get logger() {
    if (this._logger) {
      return this._logger;
    }

    return this.logger;
  }

  set logger(logger: Logger) {
    this._logger = logger;
  }

  setLogger(logger: Logger) {
    this.logger = logger;
    return this;
  }

  get serverAddress(): AddressInfo {
    let port = Number(this._listeningPort || 3000);
    let hostname = this._listeningHost || "127.0.0.1";
    let address: AddressInfo | undefined;

    if (this.isServerListening && this._serverInstance) {
      hostname = this._serverInstance.hostname;
      port = Number(this._serverInstance.port);
      address = get(this._serverInstance, "address", undefined) as
        | AddressInfo
        | undefined;
    }

    if (address) {
      return address;
    }

    return {
      address: hostname,
      family: "IPv4",
      port,
    };
  }

  address() {
    return this.serverAddress;
  }

  get url() {
    return (
      this.server?.url?.origin ||
      `http://${this.listeningHost}:${this.listeningPort}`
    );
  }

  get webSocketAdapter() {
    return this._websocketAdapter;
  }

  set webSocketAdapter(adapter: BunNestWebsocketAdapter) {
    this._websocketAdapter = adapter;
    this.instance.setBunWebSocket(this.webSocketAdapter);
  }

  public get isListening() {
    return !!this._serverInstance?.url || this.isServerListening;
  }

  public get listening() {
    return this.isListening;
  }

  public get listeningHost() {
    if (this._serverInstance?.url?.hostname) {
      return String(this._serverInstance.url.hostname);
    }

    if (this.serverAddress?.address) {
      return String(this.serverAddress.address);
    }

    return this._listeningHost;
  }

  public get listeningPort() {
    if (this._serverInstance?.url?.port) {
      return Number(this._serverInstance.url.port);
    }

    if (this.serverAddress?.port) {
      return Number(this.serverAddress.port);
    }

    return Number(this._listeningPort);
  }

  get timeout() {
    return this.requestTimeout;
  }

  public setTimeout(reqTimeout: number, callback: CallableFunction) {
    this.requestTimeout = reqTimeout;
    return pollUntil(
      () => this.getBunServer(),
      (server) => !!server,
    ).then(callback as unknown as (server: Server | undefined) => unknown);
  }

  public getHeader(response: BunResponse, name: string) {
    return response.getHeader(name);
  }

  public appendHeader(response: BunResponse, name: string, value: string) {
    response.appendHeader(name, value);
    return this;
  }

  private registerBodyParser(
    prefix?: string | undefined,
    rawBody?: boolean,
    options?: BodyParserOptions,
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

    return this;
  }

  public useBodyParser(
    _: BodyParserType,
    rawBody: boolean,
    options: BodyParserOptions,
  ) {
    return this.registerBodyParser(undefined, rawBody, options);
  }

  public async setListenOptions(
    options: Partial<BunServeOptions> & {
      hostname?: string;
      port: string | number;
    },
  ): Promise<Server | undefined> {
    const hostname = options.hostname || "127.0.0.1";
    const port = options.port;

    const mainServeOptions = omit(options, ["hostname", "port"]);
    const serverOptions = this.serverOptions || {};

    each(mainServeOptions, (value, key) => {
      set(serverOptions, key, value);
    });

    this.serverOptions = serverOptions;
    return await this.listen(port, hostname);
  }

  public async listen(
    port: string | number,
    callback?: (...args: unknown[]) => void,
  ): Promise<BunServer>;
  public async listen(
    port: string | number,
    hostname: string,
    callback?: (...args: unknown[]) => void,
  ): Promise<BunServer>;
  public async listen(
    port: number | string,
    hostname?: string | ((...args: unknown[]) => void),
    callback?: (...args: unknown[]) => void,
  ) {
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
    if (!(this.listeningHost === hostname && this.listeningPort === port)) {
      await this._serverInstance?.stop(true);
      this._serverInstance = undefined;
      this.isServerListening = false;
    }

    if (this.isServerListening || this._serverInstance) {
      if (callback) {
        await callback(this._serverInstance);
      }

      return this._serverInstance;
    }

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

    try {
      // eslint-disable-next-line ts/no-this-alias
      const that = this;
      const httpServer = Bun.serve({
        ...(this.serverOptions || {}),
        port: this._listeningPort,
        hostname: this._listeningHost,
        development: Bun.env.NODE_ENV !== "production",
        async fetch(nativeRequest: Request, server) {
          const req = await BunRequest.init(
            nativeRequest,
            server,
            that.requestOpts,
          );

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
            if (res.upgradeToWsData) {
              const success = server.upgrade(nativeRequest, {
                data: res.upgradeToWsData,
              });

              if (success) {
                return undefined;
              }

              let response = new Response(
                "An error occurred while upgrading websocket",
                {
                  status: 400,
                },
              );
              try {
                response = await res.getNativeResponse(100);
              } catch {
                //
              }

              return response;
            }

            const nativeResponse = await res.getNativeResponse(
              that.requestTimeout,
            );
            return nativeResponse;
          }

          return new Response(undefined, {
            status: 404,
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

      this._serverInstance = httpServer;
      const address = await this.getListenAddress();

      if (!(address && this._serverInstance)) {
        throw new Error(
          `Ooops an error occurred while listening on ${this._listeningHost}:${this._listeningPort}`,
        );
      }

      this.isServerListening = true;
      this.eventEmitter.emit("listening", this._serverInstance);

      if (callback) {
        await callback(this._serverInstance);
      }

      return this._serverInstance;
    } catch (e) {
      console.log(e);
      const errorMessage = "Error while binding to listener...";
      this.logger.log(errorMessage);
      this.logger.log(e);
      process.exit(1);
    }
  }

  public async getListenAddress(): Promise<URL> {
    const url = await pollUntil(
      () => this._serverInstance?.url,
      (url) => !!url,
    );

    return url as URL;
  }

  public reply(
    response: BunResponse,
    body:
      | ReadableStream
      | BunFile
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
    const nativeResp = Bun.peek(response.getNativeResponse());
    if (isPromise(nativeResp)) {
      return false;
    }

    return !!nativeResp;
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
    const prefix = String(options.prefix || "").toLowerCase();

    return this.instance.get(`${prefix}/*`, async (req, res) => {
      let properPath = req.path.toLocaleLowerCase();
      if (properPath.startsWith(prefix)) {
        properPath = properPath.substring(prefix.length);
      }

      if (!properPath.startsWith("/")) {
        properPath = `/${properPath}`;
      }

      const filePath = join(path, properPath);
      const file = Bun.file(filePath);
      if (await file.exists()) {
        res.setHeader("Content-Type", file.type || "application/octet-stream");

        res.setHeader("Content-Length", String(file.size));
        return res.status(200).send(file);
      } else {
        throw new Error("NOT_FOUND");
      }
    });
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

    return this;
  }

  public enableCors(
    options: CorsOptions | CorsOptionsDelegate<BunRequest>,
    prefix?: string,
  ) {
    const handler: RouterHandler = async (
      req: BunRequest,
      res: BunResponse,
      next: NextFunction,
    ) => {
      let corsHandler: RouterHandler | undefined;
      if (isFunction(options)) {
        try {
          const promisedFn = promisify(options);
          const corsOpts = await promisedFn(req);

          corsHandler = cors(corsOpts as unknown as MainCorsOptions);
        } catch (e) {
          return res.status(400).end(e);
        }
      } else {
        corsHandler = cors(options as unknown as MainCorsOptions);
      }

      if (!corsHandler) {
        corsHandler = cors();
      }

      return corsHandler(req, res, next);
    };

    if (prefix) {
      this.use(prefix, handler);
      const router = new BunRouter();
      router.options("*", handler);
      this.instance.group(prefix, router);
      return this;
    }

    this.use(handler);
    this.instance.options("*", handler);
    return this;
  }

  public async close() {
    try {
      if (this._serverInstance && this.isServerListening) {
        await this._serverInstance.stop(false);
      }
    } catch (err) {
      console.error(
        "An error occurred while closing bun http adapter ====> ",
        err,
      );
    }
    this.eventEmitter.emit("close");
    this._serverInstance = undefined;
    this.isServerListening = false;
    this._errorHandlers = [];
    this._notFoundHandlers = [];
  }

  public getType(): string {
    return "express";
  }

  get server() {
    return this._serverInstance;
  }

  public getBunServer() {
    return this.server;
  }

  public defineHttpServer() {
    if (this.httpServer) {
      return this.httpServer;
    }

    // Bypass event handlers added to httpServer and call of address
    this.httpServer = new Proxy({} as unknown as BunServer, {
      get: (_, prop) => {
        switch (true) {
          case [
            "emit",
            "on",
            "once",
            "addListener",
            "off",
            "removeListener",
            "eventNames",
            "listeners",
            "listenerCount",
            "removeAllListeners",
          ].includes(prop as string): {
            let method = get(this.eventEmitter, prop) as
              | CallableFunction
              | undefined;

            if (method) {
              method = method.bind(this.eventEmitter);
              return method;
            }

            return () => null;
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
            if (Reflect.has(this, prop)) {
              return Reflect.get(this, prop, this);
            }

            if (
              this._serverInstance &&
              Reflect.has(this._serverInstance, prop)
            ) {
              return Reflect.get(
                this._serverInstance,
                prop,
                this._serverInstance,
              );
            }

            return undefined;
          }
        }
      },
    });

    return this.httpServer;
  }

  public getHttpServer() {
    return this.defineHttpServer();
  }

  public setHttpServer(server: Server) {
    this.httpServer = server;
    return this;
  }

  public async init() {
    if (this.server) {
      return;
    }

    this.defineHttpServer();
  }

  public async initHttpServer() {
    await this.init();
    return this.httpServer;
  }

  override use(...callbacks: RouterHandler[]): this;
  override use(path: string, ...callbacks: RouterHandler[]): this;
  override use(
    path?: string | RouterHandler,
    ...callbacks: RouterHandler[]
  ): this {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        this.instance.use(path, ...callbacks);
        return this;
      }

      callbacks.unshift(path);
    }

    this.instance.use(...callbacks);
    return this;
  }

  override get(path: string, ...callbacks: RouterHandler[]): this;
  override get(...callbacks: RouterHandler[]): this;
  override get(
    path?: string | RouterHandler,
    ...callbacks: RouterHandler[]
  ): this {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        this.instance.get(path, ...callbacks);
        return this;
      }

      callbacks.unshift(path);
    }

    this.instance.get(...callbacks);
    return this;
  }

  override post(path: string, ...callbacks: RouterHandler[]): this;
  override post(...callbacks: RouterHandler[]): this;
  override post(
    path?: string | RouterHandler,
    ...callbacks: RouterHandler[]
  ): this {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        this.instance.post(path, ...callbacks);
        return this;
      }

      callbacks.unshift(path);
    }

    this.instance.post(...callbacks);
    return this;
  }

  override head(path: string, ...callbacks: RouterHandler[]): this;
  override head(...callbacks: RouterHandler[]): this;
  override head(
    path?: string | RouterHandler,
    ...callbacks: RouterHandler[]
  ): this {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        this.instance.head(path, ...callbacks);
        return this;
      }

      callbacks.unshift(path);
    }

    this.instance.head(...callbacks);
    return this;
  }

  override delete(path: string, ...callbacks: RouterHandler[]): this;
  override delete(...callbacks: RouterHandler[]): this;
  override delete(
    path?: string | RouterHandler,
    ...callbacks: RouterHandler[]
  ): this {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        this.instance.delete(path, ...callbacks);
        return this;
      }

      callbacks.unshift(path);
    }

    this.instance.delete(...callbacks);
    return this;
  }

  override put(path: string, ...callbacks: RouterHandler[]): this;
  override put(...callbacks: RouterHandler[]): this;
  override put(
    path?: string | RouterHandler,
    ...callbacks: RouterHandler[]
  ): this {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        this.instance.put(path, ...callbacks);
        return this;
      }

      callbacks.unshift(path);
    }

    this.instance.put(...callbacks);
    return this;
  }

  override patch(path: string, ...callbacks: RouterHandler[]): this;
  override patch(...callbacks: RouterHandler[]): this;
  override patch(
    path?: string | RouterHandler,
    ...callbacks: RouterHandler[]
  ): this {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        this.instance.patch(path, ...callbacks);
        return this;
      }

      callbacks.unshift(path);
    }

    this.instance.patch(...callbacks);
    return this;
  }

  override all(path: string, ...callbacks: RouterHandler[]): this;
  override all(...callbacks: RouterHandler[]): this;
  override all(
    path?: string | RouterHandler,
    ...callbacks: RouterHandler[]
  ): this {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        this.instance.all(path, ...callbacks);
        return this;
      }

      callbacks.unshift(path);
    }

    this.instance.all(...callbacks);
    return this;
  }

  override search(path: string, ...callbacks: RouterHandler[]): this;
  override search(...callbacks: RouterHandler[]): this;
  override search(
    path?: string | RouterHandler,
    ...callbacks: RouterHandler[]
  ): this {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        this.instance.search(path, ...callbacks);
        return this;
      }

      callbacks.unshift(path);
    }

    this.instance.search(...callbacks);
    return this;
  }

  override options(path: string, ...callbacks: RouterHandler[]): this;
  override options(...callbacks: RouterHandler[]): this;
  override options(
    path?: string | RouterHandler,
    ...callbacks: RouterHandler[]
  ): this {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        this.instance.options(path, ...callbacks);
        return this;
      }

      callbacks.unshift(path);
    }

    this.instance.options(...callbacks);
    return this;
  }

  public setViewEngine(engine: string) {
    if (engine) return this;
    return this;
  }

  public getRequestMethodStr(requestMethod: RequestMethod): string {
    let method = "";
    switch (requestMethod) {
      case RequestMethod.GET: {
        method = "get";
        break;
      }

      case RequestMethod.POST: {
        method = "post";
        break;
      }

      case RequestMethod.PUT: {
        method = "put";
        break;
      }

      case RequestMethod.DELETE: {
        method = "delete";
        break;
      }

      case RequestMethod.PATCH: {
        method = "patch";
        break;
      }

      case RequestMethod.ALL: {
        method = "all";
        break;
      }

      case RequestMethod.OPTIONS: {
        method = "options";
        break;
      }

      case RequestMethod.HEAD: {
        method = "head";
        break;
      }

      case RequestMethod.SEARCH: {
        method = "search";
        break;
      }

      case RequestMethod.PROPFIND: {
        method = "propfind";
        break;
      }

      case RequestMethod.PROPPATCH: {
        method = "proppatch";
        break;
      }

      case RequestMethod.MKCOL: {
        method = "mkcol";
        break;
      }

      case RequestMethod.COPY: {
        method = "copy";
        break;
      }

      case RequestMethod.MOVE: {
        method = "move";
        break;
      }

      case RequestMethod.LOCK: {
        method = "lock";
        break;
      }

      case RequestMethod.UNLOCK: {
        method = "unlock";
        break;
      }
    }

    if (method) {
      return method;
    }

    throw new InternalServerErrorException(
      `An invalid request method was encountered with value ${requestMethod}`,
    );
  }

  public createMiddlewareFactory(
    requestMethod: RequestMethod,
  ): MiddlewareFactoryRespType {
    return ((path, callback) => {
      const method = this.getRequestMethodStr(requestMethod);
      return this.instance.add(
        method,
        path,
        callback as unknown as RouterHandler,
      );
    }) as MiddlewareFactoryRespType;
  }

  public applyVersionFilter(
    handler: ApplyVersionFilterParameters[0],
    version: ApplyVersionFilterParameters[1],
    versioningOptions: ApplyVersionFilterParameters[2],
  ): VersionedRoute {
    const callNextHandler: VersionedRoute = (_, __, next) => {
      if (!next) {
        throw new InternalServerErrorException(
          "HTTP adapter does not support filtering on version",
        );
      }

      return next() as unknown as Function;
    };

    const versionNeutralStr = VERSION_NEUTRAL as unknown as string;

    if (
      version === versionNeutralStr ||
      // URL Versioning is done via the path, so the filter continues forward
      versioningOptions.type === VersioningType.URI
    ) {
      const handlerForNoVersioning: VersionedRoute = (req, res, next) =>
        handler(req, res, next);
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
            if (version.includes(versionNeutralStr)) {
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
            if (version.includes(versionNeutralStr)) {
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

    throw new Error("Unsupported versioning options");
  }
}

export class BunNestHttpAdapter extends BunHttpAdapter {}
