import type {
  BunRequest,
  BunResponse,
  BunRouter,
  BunServer,
  NextFunction,
} from "@kingsleyweb/bun-common";
import type {
  NestApplicationOptions,
  VersioningOptions,
  VersionValue,
} from "@nestjs/common/interfaces";
/* eslint-disable ts/no-unsafe-function-type */
import { BunHttpAdapter as BunCommonHttpAdapter } from "@kingsleyweb/bun-common";
import {
  InternalServerErrorException,
  Logger,
  type RequestMethod,
  StreamableFile,
  VERSION_NEUTRAL,
  VersioningType,
} from "@nestjs/common";
import { AbstractHttpAdapter } from "@nestjs/core";
import { isString, isUndefined } from "lodash-es";
import { BunWebSocketAdapter } from "./BunWebSocketAdapter";

export type VersionedRoute = (
  req: BunRequest,
  res: BunResponse,
  next: NextFunction,
) => Function;

export type WebsocketOptions = ConstructorParameters<
  typeof BunWebSocketAdapter
>[1];

export type MiddlewareFactoryRespType = (
  path: string,
  callback: Function,
) => unknown;

abstract class AdjustedAbstractHttpAdapter extends AbstractHttpAdapter<
  BunServer,
  BunRequest,
  BunResponse
> {
  declare public instance: BunRouter;
  declare public httpServer: BunServer;

  abstract override applyVersionFilter(
    handler: Function,
    version: VersionValue,
    versioningOptions: VersioningOptions,
  ): VersionedRoute;
}

export class BunNestHttpAdapter
  extends BunCommonHttpAdapter
  implements AdjustedAbstractHttpAdapter
{
  constructor(
    protected requestTimeout = 0,
    wsOptions?: WebsocketOptions,
  ) {
    super(requestTimeout, wsOptions);
    const logger = new Logger();
    this.setLogger(logger);

    this.webSocketAdapter = new BunWebSocketAdapter(this, {
      router: this,
      newInstance: false,
      getServer: () => {
        return this.getBunServer();
      },
      ...wsOptions,
    } as unknown as WebsocketOptions);
  }

  public override reply(
    response: BunResponse,
    body: StreamableFile | Parameters<BunCommonHttpAdapter["reply"]>[1],
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

    return super.reply(response, body, statusCode);
  }

  public setViewEngine(engineOrOptions: unknown) {
    if (engineOrOptions) return this;
    return this;
  }

  public createMiddlewareFactory(
    requestMethod: RequestMethod,
  ): MiddlewareFactoryRespType {
    if (requestMethod) {
      return this.use.bind(
        this.instance,
      ) as unknown as MiddlewareFactoryRespType;
    }

    return this.use.bind(this.instance) as unknown as MiddlewareFactoryRespType;
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

  public override initHttpServer(options?: NestApplicationOptions) {
    console.log("Info sent in Nest init http server ======> ", options);
    return this.init();
  }
}

export class BunHttpAdapter extends BunNestHttpAdapter {}
