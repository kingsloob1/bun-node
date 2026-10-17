/**
 * Spike adapter: an in-process message broker (topic → handlers) whose
 * records carry `payload`, `key` and `headers`. `publish` checks the record
 * as a sender (the producer's contract) and each delivery parses it as a
 * receiver (the consumer's), and answers synchronously when every schema
 * does, so a producer learns of a rejection before anything is enqueued.
 */
import type {
  Contract,
  GuardOptions,
  KeysOf,
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

export const broker = defineTransport({
  name: "broker",
  inbound: { key: "topic", parts: ["payload", "key", "headers"] },
  outbound: { key: "topic", parts: ["payload", "key", "headers"] },
});

/** A contract for the broker transport. */
export type BrokerContract = Contract<typeof broker.spec, unknown>;

/** Options for {@link createBroker}. */
export interface BrokerOptions {
  /** The producer-side check. Default `{ policy: "error" }`. */
  publish?: GuardOptions;
  /** The consumer-side parse. Default `{ policy: "error" }`. */
  deliver?: GuardOptions;
}

/** A consumer's record for one topic. */
export type RecordFor<C, T> = Extract<Received<C, "inbound">, { topic: T }>;

/** Creates a broker for `contract`'s topics. */
export function createBroker<C extends BrokerContract>(
  contract: C,
  options: BrokerOptions = {},
) {
  const check = createSender(contract, "outbound", options.publish);
  const parse = createReceiver(contract, "inbound", options.deliver);
  const topics = new Map<string, Set<(record: never) => void>>();

  /** Registers `handler` for `topic`; returns the unsubscribe. */
  function subscribe<T extends KeysOf<C, "inbound">>(
    topic: T,
    handler: (record: RecordFor<C, T>) => void,
  ): () => void {
    const set = topics.get(String(topic)) ?? new Set();
    topics.set(String(topic), set);
    set.add(handler);
    return () => void set.delete(handler);
  }

  /** Publishes a record: the number of deliveries, or the {@link ContractError} that stopped it. */
  function publish(
    record: Sent<C, "outbound">,
  ): MaybePromise<number | ContractError> {
    return andThen(check(record), (checked) => {
      if (checked instanceof ContractError) return checked;
      const handlers = topics.get(
        String((checked as { topic: unknown }).topic),
      );
      if (handlers === undefined || handlers.size === 0) return 0;
      return andThen(parse(checked), (parsed) => {
        if (parsed instanceof ContractError) return parsed;
        for (const h of handlers) (h as (r: unknown) => void)(parsed);
        return handlers.size;
      });
    });
  }

  return { subscribe, publish };
}
