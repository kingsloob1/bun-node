import { HttpException, HttpStatus } from "@nestjs/common";

/** The default message of a {@link ThrottlerException}, `@nestjs/throttler`'s word for word. */
export const throttlerMessage = "ThrottlerException: Too Many Requests";

/**
 * What `BunThrottlerGuard` throws past a limit: a `429 Too Many Requests`
 * `HttpException`, answered by Nest's exception layer, so an exception
 * filter can shape it. `@nestjs/throttler`'s `ThrottlerException`, same
 * status and default message, so the default body is
 * `{ "statusCode": 429, "message": "ThrottlerException: Too Many Requests" }`
 * as there.
 */
export class ThrottlerException extends HttpException {
  constructor(
    /** The message; default {@link throttlerMessage}. The module's `errorMessage` option sets it. */
    message?: string,
  ) {
    super(
      `${message === undefined || message === "" ? throttlerMessage : message}`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
