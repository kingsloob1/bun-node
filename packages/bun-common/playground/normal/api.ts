import type { RouterMiddlewareHandler } from "../../lib";
import { Buffer } from "node:buffer";
import * as path from "node:path";
import { BunHttpAdapter } from "../../lib";

const port = 3000;
const hostname = "127.0.0.1";
const httpAdapter = new BunHttpAdapter(1000);

const apiHandler: RouterMiddlewareHandler = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  res.send("happy Guy");

  req.on("close", () => {
    res.end();
    console.log("Connection is Closed");
  });
};

httpAdapter.instance.get("/", () => {
  return Bun.file(path.join(__dirname, "index.html"));
});

// API route
httpAdapter.instance.get("/api", apiHandler);

// Websocket route
httpAdapter.instance.ws("/websocket/main", {
  ping(ws) {
    console.log("Websocket ping here ====> ", { data: ws.data });
  },
  pong(ws) {
    console.log("Websocket pong here ====> ", { data: ws.data });
  },
  open(ws) {
    console.log("Websocket open here ====> ", { data: ws.data });

    // Close after 15 seconds
    setTimeout(() => {
      ws.close(1000, "Time for webscoket to die");
    }, 15000);
  },
  message(ws, message) {
    console.log("Websocket message here ====> ", {
      data: ws.data,
      message: Buffer.from(message).toString(),
    });

    setTimeout(() => {
      ws.sendText(`${Buffer.from(message).toString()}`);
    }, 500);
  },
});

// Set not found handler
httpAdapter.setNotFoundHandler((req, res) => {
  const errText = `Path ${req.path} is currently not available =====> `;
  console.log(errText);
  return res.status(404).end(errText);
});

httpAdapter.listen(port, hostname, () => {
  console.log(
    `API server running at http://${httpAdapter.serverAddress.address}:${httpAdapter.serverAddress.port}`,
  );
});
