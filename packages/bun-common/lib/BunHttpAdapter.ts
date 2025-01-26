import type { BunFile, Server } from "bun";
import type { Server as NodeServer } from "node:http";
import type {
  BodyParserOptions,
  BodyParserType,
  BunServeOptions,
  BunServer,
  Logger,
  matchedRoute,
  NextFunction,
  RouterErrorMiddlewareHandler,
  RouterHandler,
  RouterMiddlewareHandler,
  ServeStaticOptions,
} from "./index";
import { type AddressInfo, isIPv4, isIPv6 } from "node:net";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { isPromise } from "node:util/types";
import cors, {
  type CorsOptions as BunCorsOptions,
  type CorsOptionsDelegate,
} from "cors";
import EventEmitter from "eventemitter3";
import getPort from "get-port";
import {
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
import { BunRouter } from "./BunRouter";
import { BunRequest, BunResponse, BunWebSocket } from "./index";

export type BunRequestOptions = ConstructorParameters<typeof BunRequest>[2];
export type WebsocketOptions = ConstructorParameters<typeof BunWebSocket>[0];
export type BunRouterOptions = ConstructorParameters<typeof BunRouter>[0];

export class BunHttpAdapter extends BunRouter {
  #requestOpts!: BunRequestOptions;
  #nodeHttpServer!: NodeServer;
  private _instance!: InstanceType<typeof BunRouter>;
  private _websocketAdapter!: BunWebSocket;
  private _serverInstance: BunServer | undefined = undefined;
  private _listeningHost = "127.0.0.1";
  private _listeningPort: string | number = 3000;
  protected isServerListening = false;
  private serverOptions: BunServeOptions | undefined = undefined;
  private _notFoundHandlers: RouterMiddlewareHandler[] = [];
  private _errorHandlers: RouterErrorMiddlewareHandler[] = [];
  private _hasRegisteredBodyParser = false;
  public readonly eventEmitter = new EventEmitter();

  constructor(
    protected requestTimeout = 0,
    options?: {
      request?: BunRequestOptions;
      websocket?: WebsocketOptions;
      logger?: Logger;
      router?: BunRouterOptions;
    },
  ) {
    const websocketOptions = options?.websocket || {};
    const routerOptions = options?.router || {
      caseSensitive: true,
      debug: false,
    };

    const logger = options?.logger || console;

    super({
      caseSensitive: false,
      ...routerOptions,
      logger,
    });

    this.requestOpts = options?.request || {
      parseBody: true,
      parseCookies: true,
    };

    this.logger = logger;
    this.webSocketAdapter = new BunWebSocket({
      router: this,
      newInstance: false,
      getServer: () => {
        return this.getBunServer();
      },
      ...websocketOptions,
    } as unknown as WebsocketOptions);

    this.initNodeHttpServer();
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

  get instance(): InstanceType<typeof BunRouter> {
    return this._instance || this;
  }

  set instance(instance: BunRouter) {
    this._instance = instance;
  }

  public getInstance() {
    return this.instance;
  }

  public setInstance(instance: BunRouter) {
    this.instance = instance;
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

  set webSocketAdapter(adapter: BunWebSocket) {
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
    callback();

    return Promise.resolve(this.getBunServer() || Bun.peek(this.init()));
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
      return this;
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

    this.serverOptions = omit(options, ["hostname", "port"]);
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
      await this.init();
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
    const prefix = String(options.prefix || "").toLocaleLowerCase();

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
    options: BunCorsOptions | CorsOptionsDelegate<BunRequest>,
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

          corsHandler = cors(corsOpts);
        } catch (e) {
          return res.status(400).end(e);
        }
      } else {
        corsHandler = cors(options);
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

  public async init() {
    if (this._serverInstance) {
      return this._serverInstance;
    }

    // eslint-disable-next-line ts/no-this-alias
    const that = this;
    const serverInstance = Bun.serve({
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

    this._serverInstance = serverInstance;
    return serverInstance;
  }

  public initNodeHttpServer() {
    if (this.#nodeHttpServer) {
      return this.#nodeHttpServer;
    }

    // Bypass event handlers added to httpServer and call of address
    this.#nodeHttpServer = new Proxy({} as unknown as NodeServer, {
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

    return this.#nodeHttpServer;
  }

  public nodeHttpServer() {
    return this.initNodeHttpServer();
  }
}
