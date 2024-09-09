import { get, isObject, set } from "lodash-es";
import { BunRequest, BunResponse, BunRouter } from "../../lib";
import type { matchedRoute, RouterMiddlewareHandler } from "../../lib";

const port = 3000;
const hostname = "127.0.0.1";
const router = new BunRouter();

const eventsHandler: RouterMiddlewareHandler = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  res.send("happy Guy");

  req.on("close", () => {
    res.end();
    console.log("Connection is Closed");
  });
};

// SSE route
router.get(`/api`, eventsHandler);

const serverInstance = Bun.serve({
  port,
  hostname,
  development: Bun.env.NODE_ENV !== "production",
  async fetch(nativeRequest: Request, server) {
    // server.timeout(nativeRequest, 10 * 60 * 60);
    const req = new BunRequest(nativeRequest, server, {
      canHandleUpload: true,
      parseCookies: true,
    });

    const res = new BunResponse(req);
    let routeUsed: matchedRoute | true | undefined;

    try {
      routeUsed = await router.handle({
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

      const nativeResponse = await res.getNativeResponse(1000);
      return nativeResponse;
    }

    return new Response(undefined, {
      status: 404,
      statusText: "Not Found",
    });
  },
  websocket: {
    open(ws) {
      console.log(`OPEN WS...`, ws);
    },
    message(ws, message) {
      console.log(`Message WS...`, {
        ws,
        message,
      });
    },
    close(ws, code, reason) {
      console.log(`Close WS...`, {
        ws,
        code,
        reason,
      });
    },
  },
  async error(err) {
    const req = get(err, "req", undefined) as BunRequest | undefined;
    if (!req) {
      throw err;
    }

    console.log(err);

    throw err;
  },
});

console.log(
  `API server running at http://${serverInstance.hostname}:${serverInstance.port}`,
);
