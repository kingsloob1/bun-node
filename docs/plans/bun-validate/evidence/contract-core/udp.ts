/**
 * Spike adapter: request/reply over UDP datagrams, validated by a contract.
 * Wire format: one JSON object per datagram, `{ id, type, payload }`; an
 * invalid request gets `{ id, type: "error", payload: { issues } }` under
 * `"error"`. Everything contract-related is the four core calls.
 */
import type {
  Contract,
  ContractIssue,
  GuardOptions,
  MaybePromise,
  Received,
  Sent,
} from "./core";
import {
  andThen,
  ContractError,
  createReceiver,
  createSender,
  defineTransport,
} from "./core";

export const udp = defineTransport({
  name: "udp",
  inbound: { key: "type", parts: ["payload"] },
  outbound: { key: "type", parts: ["payload"] },
});

/** A contract for the UDP transport. */
export type UdpContract = Contract<typeof udp.spec, unknown>;

/** The adapter's own error frame; not part of any contract. */
export interface UdpErrorFrame {
  type: "error";
  payload: { issues: readonly ContractIssue[] };
}

/** Options for {@link serveUdp}: the inbound policy, and one for the replies. */
export interface UdpServeOptions extends GuardOptions {
  /** How replies are checked. Default: the same as the requests. */
  replies?: GuardOptions;
}

/** An error frame with one adapter-level issue. */
const errorFrame = (target: string, message: string): UdpErrorFrame => ({
  type: "error",
  payload: { issues: [{ target, path: "", message }] },
});

const encode = (id: unknown, frame: object): string =>
  JSON.stringify({ id, ...frame });

/** Serves `contract` on 127.0.0.1, an OS-assigned port. */
export async function serveUdp<C extends UdpContract>(
  contract: C,
  handler: (
    message: Received<C, "inbound">,
  ) => MaybePromise<Sent<C, "outbound"> | void>,
  options: UdpServeOptions = {},
): Promise<{ port: number; close: () => void }> {
  const receive = createReceiver(contract, "inbound", options);
  const check = createSender(contract, "outbound", options.replies ?? options);
  const socket = await Bun.udpSocket({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(sock, buf, port, address) {
        const reply = (id: unknown, frame: object): void =>
          void sock.send(encode(id, frame), port, address);
        let envelope: Record<string, unknown>;
        try {
          envelope = JSON.parse(buf.toString()) as Record<string, unknown>;
        } catch {
          return reply(null, errorFrame("datagram", "Not JSON"));
        }
        const { id, ...message } = envelope;
        void andThen(receive(message), (m) => {
          if (m instanceof ContractError)
            return reply(id, { type: "error", payload: { issues: m.issues } });
          return andThen(handler(m), (out) => {
            if (out === undefined) return;
            return andThen(check(out), (checked) => {
              const bad = checked instanceof ContractError;
              reply(
                id,
                bad
                  ? errorFrame("reply", "The reply failed its contract")
                  : checked,
              );
            });
          });
        });
      },
    },
  });
  return { port: socket.port, close: () => socket.close() };
}

/** A client for `contract` talking to 127.0.0.1:`port`; `raw` sends an unchecked, untyped message. */
export async function udpClient<C extends UdpContract>(
  contract: C,
  port: number,
  options: GuardOptions = {},
) {
  type Reply = Received<C, "outbound"> | UdpErrorFrame | ContractError;
  const check = createSender(contract, "inbound", options);
  const parse = createReceiver(contract, "outbound", options);
  const pending = new Map<number, (r: Reply) => void>();
  let next = 0;
  const socket = await Bun.udpSocket({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(_sock, buf) {
        const { id, ...frame } = JSON.parse(buf.toString()) as {
          id: number;
          type: string;
        };
        const settle = pending.get(id);
        pending.delete(id);
        if (settle)
          void andThen(
            frame.type === "error" ? (frame as UdpErrorFrame) : parse(frame),
            settle,
          );
      },
    },
  });
  const raw = (message: unknown): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, resolve);
      socket.send(encode(id, message as object), port, "127.0.0.1");
      setTimeout(
        () => pending.delete(id) && reject(new Error(`no reply to ${id}`)),
        1000,
      );
    });
  const request = async (message: Sent<C, "inbound">): Promise<Reply> => {
    const checked = await check(message);
    return checked instanceof ContractError ? checked : raw(checked);
  };
  return { request, raw, close: () => socket.close() };
}
