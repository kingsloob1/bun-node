/**
 * `seconds(n)`, `minutes(n)`, `hours(n)`, `days(n)` and `weeks(n)`, the
 * duration helpers of `@nestjs/throttler` 6 (`utilities.ts`), so
 * `ttl: seconds(60)` migrates unchanged.
 *
 * One difference, on purpose: `@nestjs/throttler`'s return milliseconds as a
 * bare number, and a bare number is exactly what bun-nest's `ttl` refuses
 * (is `60` a minute or 60 ms? a production `THROTTLE_TTL=60` was read as
 * 60 ms, which turned its throttling off). These return a duration object
 * (`{ seconds: 60 }`) instead, which carries its unit; `ttl: 60_000` fails
 * loudly, at the type level and at startup.
 */

/** A duration in seconds, as `ttl` takes it: `seconds(30)` is `{ seconds: 30 }`. */
export function seconds(howMany: number): { readonly seconds: number } {
  return { seconds: howMany };
}

/** A duration in minutes, as `ttl` takes it: `minutes(1)` is `{ minutes: 1 }`. */
export function minutes(howMany: number): { readonly minutes: number } {
  return { minutes: howMany };
}

/** A duration in hours, as `ttl` takes it: `hours(1)` is `{ hours: 1 }`. */
export function hours(howMany: number): { readonly hours: number } {
  return { hours: howMany };
}

/** A duration in days (24 h), as `ttl` takes it: `days(1)` is `{ days: 1 }`. */
export function days(howMany: number): { readonly days: number } {
  return { days: howMany };
}

/** A duration in weeks (7 days), as `ttl` takes it: `weeks(1)` is `{ weeks: 1 }`. */
export function weeks(howMany: number): { readonly weeks: number } {
  return { weeks: howMany };
}
