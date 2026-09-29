/**
 * Prototype targets for ../bench/servers.ts:
 *
 *   proto-native       bun-common adapter + native routes, default options
 *   proto-native-lean  the same with body/cookie/query parsing off
 *   proto-nest-native  the Nest app on bun-nest's adapter + native routes
 *   proto-index[-lean] the stock adapter (fetch) + the JS candidate index
 *   proto-nest-index   the Nest app + the JS candidate index
 *   proto-index-rc[-lean], proto-nest-index-rc
 *                      the same plus the ring-buffer FIFO route cache
 *   proto-ceiling[-lean]  NOT exact: native routes with each key's layers
 *                      computed once (BNR_CEILING) — the most native routing
 *                      can save while handle()/BunRequest/BunResponse stay
 */
import { BunHttpAdapter } from "../../../../../packages/bun-common/lib/BunHttpAdapter";
import { withNativeRoutes } from "./adapter";
import { installCandidateIndex, installRingCache } from "./candidate-index";

export async function startPrototype(
  target: string,
  routes: number,
  register: (app: never) => void,
): Promise<number> {
  switch (target) {
    case "proto-native":
    case "proto-native-lean":
    case "proto-ceiling":
    case "proto-ceiling-lean": {
      const Proto = withNativeRoutes(BunHttpAdapter);
      const app = new Proto(
        0,
        target.endsWith("-lean") ? { request: { parseBody: false, parseCookies: false, parseQuery: false } } : {},
      );
      app.nativeRoutesEnabled = true;
      register(app as never);
      const server = (await app.listen(0)) as Bun.Server<unknown>;
      return server.port!;
    }
    case "proto-index":
    case "proto-index-lean":
    case "proto-index-rc":
    case "proto-index-rc-lean": {
      const app = new BunHttpAdapter(
        0,
        target.endsWith("-lean") ? { request: { parseBody: false, parseCookies: false, parseQuery: false } } : {},
      );
      installCandidateIndex(app.instance);
      if (target.includes("-rc")) installRingCache(app.instance);
      register(app as never);
      const server = await app.listen(0);
      return server.port!;
    }
    case "proto-nest-index":
    case "proto-nest-index-rc": {
      const { BunHttpAdapter: NestAdapter } = await import("../../../../../packages/bun-nest/lib/BunHttpAdapter");
      const { startNest } = await import("../bench/nest-app");
      return await startNest(routes, () => {
        const adapter = new NestAdapter();
        installCandidateIndex(adapter.instance);
        if (target.includes("-rc")) installRingCache(adapter.instance);
        return adapter;
      });
    }
    case "proto-nest-native": {
      const { BunHttpAdapter: NestAdapter } = await import("../../../../../packages/bun-nest/lib/BunHttpAdapter");
      const Proto = withNativeRoutes(NestAdapter as never) as unknown as typeof NestAdapter;
      const { startNest } = await import("../bench/nest-app");
      return await startNest(routes, () => {
        const adapter = new Proto();
        (adapter as unknown as { nativeRoutesEnabled: boolean }).nativeRoutesEnabled = true;
        return adapter;
      });
    }
    default:
      throw new Error(`unknown prototype target ${target}`);
  }
}
