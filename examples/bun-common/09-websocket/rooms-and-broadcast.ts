/**
 * Rooms and broadcast — pub/sub topics, per-client data that changes over a
 * connection's life, an authenticated upgrade and server statistics.
 *
 * ```bash
 * bun 09-websocket/rooms-and-broadcast.ts
 * ```
 *
 * Bun's WebSockets have publish/subscribe built in: a socket subscribes to a
 * topic, and a publish reaches every subscriber without the application
 * keeping a list. The two publishes differ in who they reach:
 *
 * - `ws.publish(topic, data)` — every subscriber *except* `ws` (unless
 *   `wsOptions.publishToSelf` is set);
 * - `server.publish(topic, data)` — every subscriber.
 *
 * The upgrade route is an ordinary route, so middleware registered ahead of it
 * runs first. Here it checks a token and sets `req.user`, which the
 * connection then carries as `ws.data.user`.
 *
 * Rooms are a query parameter here (`/chat?room=lobby`). A path parameter
 * works as well: a `/chat/:room` route's handlers run, and see the room as
 * `ws.data.params.room`.
 */
import type {
  RouterMiddlewareHandler,
  WebSocketClient,
} from "@kingsleyweb/bun-common";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { show, step, title, waitFor } from "../shared/console";
import { connect } from "./helpers/client";

/** A signed-in user, as the token middleware puts it on `req.user`. */
interface User {
  /** Stable user id. */
  id: string;
  /** Display name. */
  name: string;
}

/** Per-connection state in `ws.data.custom`, changed as the user moves. */
interface Membership {
  /** The room the connection is in now. */
  room: string;
  /** When it entered that room (`Date.now()`). */
  joinedAt: number;
}

/** A command a client sends, as JSON. */
interface Command {
  /** `say` talks in the current room, `join` moves rooms, `who` counts the room. */
  type: "say" | "join" | "who";
  /** What to say, for `say`. */
  text?: string;
  /** Where to go, for `join`. */
  room?: string;
}

/** Who each token belongs to. A real application would verify a session. */
const USERS: Record<string, User> = {
  "token-alice": { id: "u1", name: "alice" },
  "token-bob": { id: "u2", name: "bob" },
  "token-carol": { id: "u3", name: "carol" },
};

/** The pub/sub topic for a room. */
function roomTopic(room: string): string {
  return `room:${room}`;
}

/**
 * A connection's membership. `ws.data.custom` is typed by the adapter's type
 * argument; this route's `customDataToWsClientFn` is what put it there.
 */
function membershipOf(ws: WebSocketClient<Membership>): Membership {
  return ws.data.custom;
}

/** A connection's user name, from `ws.data.user`. */
function nameOf(ws: WebSocketClient): string {
  return String(ws.data.user?.name ?? "someone");
}

/** Parses a client's message into a {@link Command}, or `undefined`. */
function parseCommand(message: string | Uint8Array): Command | undefined {
  if (typeof message !== "string") {
    return undefined;
  }

  try {
    const value: unknown = JSON.parse(message);
    if (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      (value.type === "say" || value.type === "join" || value.type === "who")
    ) {
      return value as Command;
    }
  } catch {
    // not JSON
  }

  return undefined;
}

title("WebSockets: rooms and broadcast");

/* ------------------------------------------------------------------ */
step("An authenticated chat route");

// The type argument is what `ws.data.custom` holds on this adapter's routes.
const adapter = new BunHttpAdapter<Membership>(0);

/** The server side of every open connection. */
const connections = new Set<WebSocketClient<Membership>>();
adapter.webSocketAdapter.on("open", (ws) => {
  connections.add(ws);
});
adapter.webSocketAdapter.on("close", (ws) => {
  connections.delete(ws);
});

// Runs before the upgrade route: refuse unknown tokens with a plain HTTP
// response, and put the user on the request for the connection to carry.
const requireToken: RouterMiddlewareHandler = (req, res, next) => {
  const user = USERS[String(req.query.token ?? "")];
  if (!user) {
    res.status(401).send("unknown token");
    return;
  }

  Object.assign(req, { user });
  next();
};
adapter.use("/chat", requireToken);

adapter.ws(
  "/chat",
  {
    open(ws) {
      const { room } = membershipOf(ws);
      ws.subscribe(roomTopic(room));
      ws.subscribe("announcements");

      // `cork` batches several sends into one write. `open`, `message` and
      // `drain` are corked already; outside them it is worth doing yourself.
      ws.cork(() => {
        ws.sendText(`you are ${nameOf(ws)}, in ${room}`);
        ws.sendText(`subscribed to ${ws.subscriptions.join(", ")}`);
      });

      // Everyone else in the room.
      ws.publish(roomTopic(room), `${nameOf(ws)} joined ${room}`);
    },

    message(ws, message) {
      const command = parseCommand(message);
      const membership = membershipOf(ws);

      if (!command) {
        ws.sendText("unrecognised command");
        return;
      }

      if (command.type === "say") {
        // Everyone in the room, the speaker included.
        adapter.server?.publish(
          roomTopic(membership.room),
          `[${membership.room}] ${nameOf(ws)}: ${command.text ?? ""}`,
        );
      } else if (command.type === "join") {
        const next = command.room ?? "lobby";
        ws.unsubscribe(roomTopic(membership.room));
        ws.publish(
          roomTopic(membership.room),
          `${nameOf(ws)} left for ${next}`,
        );

        // `ws.data.custom` is the same object for the connection's whole
        // life, so changing it is how per-client state is kept.
        membership.room = next;
        membership.joinedAt = Date.now();

        ws.subscribe(roomTopic(next));
        ws.publish(roomTopic(next), `${nameOf(ws)} joined ${next}`);
        ws.sendText(`you are now in ${next}`);
      } else {
        const count = adapter.server?.subscriberCount(
          roomTopic(membership.room),
        );
        ws.sendText(`${membership.room} has ${count ?? 0} member(s)`);
      }
    },

    close(ws) {
      // The socket is closed by now, so it can no longer publish: the server
      // still can.
      adapter.server?.publish(
        roomTopic(membershipOf(ws).room),
        `${nameOf(ws)} left`,
      );
    },
  },
  // This route's own `customDataToWsClientFn`. It runs after the middleware,
  // so the token has already been checked when it reads the room.
  (req) => {
    return {
      room: String(req.query.room ?? "lobby"),
      joinedAt: Date.now(),
    } satisfies Membership;
  },
);

await adapter.listen(0);
const chat = `${adapter.url.replace(/^http/, "ws")}/chat`;
show("listening", adapter.url);

/* ------------------------------------------------------------------ */
step("A bad token is refused before the upgrade");

const refusal = await adapter.fetch("/chat?token=nope", {
  headers: {
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    "sec-websocket-version": "13",
  },
});
show("the upgrade request is answered", {
  status: refusal.status,
  body: await refusal.text(),
});

try {
  await connect(`${chat}?token=nope`);
  show("unexpectedly connected");
} catch (error) {
  show("a real client cannot connect", (error as Error).message);
}

/* ------------------------------------------------------------------ */
step("Three users, two rooms");

const alice = await connect(`${chat}?token=token-alice&room=lobby`);
await alice.waitForText("her subscriptions", (text) => {
  return text.startsWith("subscribed");
});
const bob = await connect(`${chat}?token=token-bob&room=lobby`);
const carol = await connect(`${chat}?token=token-carol&room=kitchen`);

await alice.waitForText("bob joining", (text) => text === "bob joined lobby");
await carol.waitForText("her subscriptions", (text) => {
  return text.startsWith("subscribed");
});
show("alice has heard", alice.texts());
show("carol, in the kitchen, has heard", carol.texts());

/* ------------------------------------------------------------------ */
step("Talking in a room reaches only that room");

alice.socket.send(JSON.stringify({ type: "say", text: "hi lobby" }));
await bob.waitForText("alice's hello", (text) => text.endsWith("hi lobby"));
await alice.waitForText("her own line, via server.publish", (text) => {
  return text.endsWith("hi lobby");
});
show(
  "did carol hear it?",
  carol.texts().some((text) => text.includes("hi lobby")),
);

/* ------------------------------------------------------------------ */
step("Per-client data changes: bob moves to the kitchen");

bob.socket.send(JSON.stringify({ type: "join", room: "kitchen" }));
await carol.waitForText(
  "bob arriving",
  (text) => text === "bob joined kitchen",
);
await alice.waitForText("bob leaving", (text) => {
  return text === "bob left for kitchen";
});

bob.socket.send(JSON.stringify({ type: "who" }));
show(
  "bob asks who is here",
  await bob.waitForText("the head count", (text) => {
    return text.startsWith("kitchen has");
  }),
);

/* ------------------------------------------------------------------ */
step("Broadcast to everyone");

adapter.server?.publish("announcements", "maintenance at noon");
await Promise.all(
  [alice, bob, carol].map(async (client) => {
    return client.waitForText("the announcement", (text) => {
      return text === "maintenance at noon";
    });
  }),
);
show("alice, bob and carol all received the announcement");

/* ------------------------------------------------------------------ */
step("Server statistics and per-client state");

const server = adapter.server;
show("subscribers per topic", {
  lobby: server?.subscriberCount(roomTopic("lobby")),
  kitchen: server?.subscriberCount(roomTopic("kitchen")),
  announcements: server?.subscriberCount("announcements"),
});
show("open WebSockets", server?.pendingWebSockets);
show(
  "each connection",
  [...connections].map((ws) => {
    return {
      user: ws.data.user,
      room: membershipOf(ws).room,
      subscriptions: ws.subscriptions,
      inLobby: ws.isSubscribed(roomTopic("lobby")),
      remoteAddress: ws.remoteAddress,
      readyState: ws.readyState,
    };
  }),
);

/* ------------------------------------------------------------------ */
step("Leaving: the close handler tells the room");

carol.socket.close(1000, "bye");
await bob.waitForText("carol leaving", (text) => text === "carol left");
await waitFor("carol to leave the kitchen", () => {
  return server?.subscriberCount(roomTopic("kitchen")) === 1;
});
show("kitchen subscribers now", server?.subscriberCount(roomTopic("kitchen")));

/* ------------------------------------------------------------------ */
step("Shutting down");

alice.socket.close();
bob.socket.close();
await Promise.all([alice.waitClosed(), bob.waitClosed(), carol.waitClosed()]);
await waitFor("the server to see every connection close", () => {
  return connections.size === 0;
});
await adapter.close();
show("closed");
