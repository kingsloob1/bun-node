import type { Socket, TCPSocketListener } from "bun";

/**
 * A TCP proxy in front of a real server, which a test can cut and restore.
 *
 * It exists so a test can show a client surviving a server outage **without
 * touching the server**: the shared Redis the suites use belongs to everyone
 * running them, so it is never stopped or reconfigured. Cutting the proxy
 * drops every live connection and stops listening, so a reconnect is refused
 * exactly as it would be by a restarting server; restoring listens again on
 * the same port.
 */
export interface TcpProxy {
  /** The port the proxy listens on, stable across `cut()` and `restore()`. */
  readonly port: number;
  /** How many client connections the proxy has accepted, in total. */
  readonly accepted: number;
  /** Drops every connection and stops listening, so connects are refused. */
  cut: () => void;
  /** Listens again, on the same port. A no-op while listening. */
  restore: () => void;
  /** Cuts, for good. */
  stop: () => void;
}

/** Per client connection: its upstream, and bytes that arrived before it. */
interface Downstream {
  /** The connection to the real server, once open. */
  up?: Socket<Upstream>;
  /** Bytes the client sent before the upstream connection opened. */
  pending: Uint8Array[];
}

/** Per upstream connection: the client connection it serves. */
interface Upstream {
  /** The client connection this one carries bytes for. */
  down: Socket<Downstream>;
}

/** Starts a proxy on an OS-assigned local port in front of `host:port`. */
export function startTcpProxy(host: string, port: number): TcpProxy {
  const live = new Set<Socket<Downstream> | Socket<Upstream>>();
  let listener: TCPSocketListener<Downstream> | undefined;
  let listenPort = 0;
  let accepted = 0;

  const listen = (): void => {
    listener = Bun.listen<Downstream>({
      hostname: "127.0.0.1",
      port: listenPort,
      socket: {
        open(down) {
          accepted += 1;
          down.data = { pending: [] };
          live.add(down);
          Bun.connect<Upstream>({
            hostname: host,
            port,
            data: { down },
            socket: {
              open(up) {
                live.add(up);
                down.data.up = up;
                for (const chunk of down.data.pending) {
                  up.write(chunk);
                }
                down.data.pending = [];
              },
              data(up, chunk) {
                up.data.down.write(chunk);
              },
              close(up) {
                live.delete(up);
                up.data.down.end();
              },
              error(up) {
                up.data.down.end();
              },
            },
          }).catch(() => down.end());
        },
        data(down, chunk) {
          if (down.data.up) {
            down.data.up.write(chunk);
          } else {
            down.data.pending.push(new Uint8Array(chunk));
          }
        },
        close(down) {
          live.delete(down);
          down.data.up?.end();
        },
        error(down) {
          down.data.up?.end();
        },
      },
    });
    listenPort = listener.port;
  };

  const cut = (): void => {
    listener?.stop(true);
    listener = undefined;
    for (const socket of live) {
      socket.terminate();
    }
    live.clear();
  };

  listen();

  return {
    get port() {
      return listenPort;
    },
    get accepted() {
      return accepted;
    },
    cut,
    restore: () => {
      if (!listener) {
        listen();
      }
    },
    stop: cut,
  };
}

/** A local port nothing listens on, so a connect to it is refused at once. */
export function closedPort(): number {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const { port } = listener;
  listener.stop(true);
  return port;
}

/**
 * A server that accepts connections and never answers, so a client's connect
 * attempt hangs until its own timeout — a connection timeout rather than a
 * refusal, without depending on how the network treats an unroutable address.
 */
export function silentServer(): { port: number; stop: () => void } {
  const sockets = new Set<Socket<undefined>>();
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        sockets.add(socket);
      },
      data() {},
      close(socket) {
        sockets.delete(socket);
      },
    },
  });
  return {
    port: listener.port,
    stop: () => {
      listener.stop(true);
      for (const socket of sockets) {
        socket.terminate();
      }
    },
  };
}
