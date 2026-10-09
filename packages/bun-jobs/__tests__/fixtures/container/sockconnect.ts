import { connect } from "node:net";
import process from "node:process";

/** Connects to the Unix socket at `$SOCKET_PATH` and says whether it could. */
export default async () =>
  await new Promise<string>((resolve) => {
    const socket = connect(process.env.SOCKET_PATH ?? "/nowhere.sock");
    socket.on("connect", () => {
      socket.end("hello-from-container\n");
      resolve("CONNECTED");
    });
    socket.on("error", (error) => {
      resolve(`error ${(error as { code?: string }).code}`);
    });
  });
