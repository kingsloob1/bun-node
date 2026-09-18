/**
 * Internals shared by the two WebSocket upgrade paths — a `ws()` route
 * (`BunWebSocket.setRouteHandler`) and a bare `res.upgradeToWebsocket()` — so
 * both layer router defaults, per-request values and explicit arguments the
 * same way. Type-only imports: `BunResponse` and `BunWebSocket` both use this
 * module, and neither may pull the other in at runtime through it.
 */
import type {
  WebSocketCustomDataFn,
  WebSocketRouteOptions,
  WebSocketUpgradeHook,
} from "../BunWebSocket";
import { isFunction, isObject } from "./native";

/**
 * Merges header layers for a `101`, earliest first. A later layer replaces an
 * earlier one's values **per header name** (every value of that name, so a
 * repeated header is not appended to); names it does not mention are kept.
 * `undefined` when no layer contributes a header, so an upgrade without any
 * sends exactly Bun's default.
 */
export function mergeUpgradeHeaders(
  ...layers: (Bun.HeadersInit | Headers | undefined)[]
): Headers | undefined {
  let merged: Headers | undefined;
  for (const layer of layers) {
    if (layer === undefined) {
      continue;
    }
    const replaced = new Set<string>();
    for (const [name, value] of new Headers(layer)) {
      merged ??= new Headers();
      // `Headers` iterates lower-cased names, so this is per name regardless
      // of how either layer spelled it.
      if (!replaced.has(name)) {
        merged.delete(name);
        replaced.add(name);
      }
      merged.append(name, value);
    }
  }
  return merged;
}

/**
 * Normalises one of the accepted upgrade functions into a
 * {@link WebSocketUpgradeHook}:
 *
 * - `"hook"` — an `onUpgrade` option: used as it is.
 * - `"custom"` — the deprecated `customDataToWsClientFn` shape: its result
 *   always becomes `custom`, whatever its shape, as
 *   `(req, res) => ({ custom: await fn(req, res) })`.
 *
 * `undefined` for anything that is not a function.
 */
export function toUpgradeHook<TCustom>(
  fn:
    | WebSocketUpgradeHook<TCustom>
    | WebSocketCustomDataFn<TCustom>
    | undefined,
  kind: "hook" | "custom",
): WebSocketUpgradeHook<TCustom> | undefined {
  if (!isFunction(fn)) {
    return undefined;
  }
  if (kind === "hook") {
    return fn as WebSocketUpgradeHook<TCustom>;
  }
  const mapping = fn as WebSocketCustomDataFn<TCustom>;
  return async (req, res) => ({ custom: await mapping(req, res) });
}

/**
 * The upgrade hook a route's third argument names — `ws()`,
 * `setRouteHandler()`: a function is always the deprecated custom-data
 * mapping (its result is `custom`, whatever its shape), and an options object
 * contributes its `onUpgrade`. `undefined` for anything else, so the route
 * falls back to the instance-wide hook.
 */
export function routeUpgradeHook<TCustom>(
  fnOrOptions:
    | WebSocketRouteOptions<TCustom>
    | WebSocketCustomDataFn<TCustom>
    | undefined,
): WebSocketUpgradeHook<TCustom> | undefined {
  if (isFunction(fnOrOptions)) {
    return toUpgradeHook(
      fnOrOptions as WebSocketCustomDataFn<TCustom>,
      "custom",
    );
  }
  if (isObject(fnOrOptions)) {
    return toUpgradeHook(
      (fnOrOptions as WebSocketRouteOptions<TCustom>).onUpgrade,
      "hook",
    );
  }
  return undefined;
}
