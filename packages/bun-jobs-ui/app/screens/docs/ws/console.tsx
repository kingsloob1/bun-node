import type { EventName, JobsApiMode } from "../../../api/types";
import type { WsConsole, wsModel } from "@kingsleyweb/bun-api-docs-ui/embed";
import { parseChannel } from "../../events/eventLog";
import { eventsLink } from "./links";

/**
 * The console seam for the reference (`WsConsole`): `channelLink` is
 * `eventsLink` on the filled address, `messageLink` an event message's
 * kind's broad channel (`queues` / `runners` / `workers`) when the document
 * has it, else `all`, filtered to the one type.
 */
export function eventsConsole(
  mode: JobsApiMode,
  available: boolean,
): WsConsole {
  return {
    available,
    label: "Events console",
    unavailableReason: (
      <>
        The Events console is not available here: it needs the API&apos;s
        socket, the <code>events.connect</code> permission and the manage
        screens.
      </>
    ),
    noChannelReason: (channel) => (
      <>
        The Events console has no channel <code>{channel}</code> in mode{" "}
        <code>{mode}</code>.
      </>
    ),
    channelLink: (channel, types) =>
      eventsLink(channel, types as readonly EventName[], mode),
    messageLink: (message, doc: wsModel.WsDoc) => {
      if (message.event === null) {
        return null;
      }
      // Each kind's broad channel. Worker events are off `all` and `queues`,
      // so `workers` is the only one that carries them.
      const broad =
        message.event.kind === "queue"
          ? "queues"
          : message.event.kind === "worker"
            ? "workers"
            : "runners";
      const channel = [broad, "all"].find((key) =>
        doc.channels.some((candidate) => candidate.key === key),
      );
      if (channel === undefined) {
        return null;
      }
      const params = new URLSearchParams({
        channel,
        types: message.event.type,
      });
      return parseChannel(channel, mode) === null
        ? null
        : `/events?${params.toString()}`;
    },
  };
}
