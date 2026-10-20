/**
 * The gateways of the WebSocket differential, one module's worth, the same on
 * both sides. Shapes ported from Nest's own `integration/websockets` e2e
 * specs at v12.1.3 and v12.2.0 (`gateway`, `ws-gateway`, `error-gateway`,
 * `ws-error-gateway`, `request-scope-gateway`, `scoped-disconnect-context`,
 * `connection-hook-error`, `scoped-connection-hook-error`), not their code:
 * those run socket.io or one adapter at a time, with fixed ports.
 *
 * Every gateway is on the HTTP server's port, at a path of its own (both
 * adapters support `path` there). Gateway code reaches the client through
 * {@link Push} where it sends something itself, and records what it did in
 * {@link Trail}.
 */
import type {
  ArgumentsHost,
  CallHandler,
  ExceptionFilter,
  ExecutionContext,
  NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import {
  Catch,
  Inject,
  Injectable,
  Scope,
  UseFilters,
  UseInterceptors,
} from "@nestjs/common";
import { REQUEST } from "@nestjs/core";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WsException,
} from "@nestjs/websockets";
import { finalize, from, interval, map, take, throwError } from "rxjs";
import { Push, Trail } from "./harness";

/** A client as gateway code touches it. */
interface AnyClient {
  /** The pattern the interceptor below stores (from `getPattern()`). */
  pattern?: string;
  /** Closes the connection. */
  close: (code?: number, reason?: string) => void;
}

/** Stores the pattern on the client (`request.interceptor.ts` in Nest's specs). */
@Injectable()
class PatternInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ws = context.switchToWs();
    ws.getClient<AnyClient>().pattern = ws.getPattern();
    return next.handle();
  }
}

/** Sends the pattern and message of a `WsException` (`request.filter.ts`). */
@Catch(WsException)
class PatternFilter implements ExceptionFilter {
  constructor(@Inject(Push) private readonly push: Push) {}

  catch(exception: WsException, host: ArgumentsHost) {
    const ws = host.switchToWs();
    this.push.send(ws.getClient(), "exception", {
      pattern: ws.getPattern(),
      message: exception.message,
    });
  }
}

/** A filter that throws itself: the app bug both adapters must survive. */
@Catch()
class RethrowFilter implements ExceptionFilter {
  catch(): void {
    throw new Error("the filter threw");
  }
}

/** Messages, replies and exceptions: `gateway`, `ws-gateway`, `error-gateway`, `ws-error-gateway`. */
@WebSocketGateway({ path: "/main" })
export class MainGateway {
  constructor(@Inject(Trail) private readonly trail: Trail) {}

  /** `{ event, data }`: a reply on both wires. */
  @SubscribeMessage("push")
  push(@MessageBody() data: unknown) {
    this.trail.add(["ran", "push", data]);
    return { event: "pop", data };
  }

  /** A plain value: platform-ws sends it as is; ours acks with it. */
  @SubscribeMessage("value")
  value(@MessageBody() data: unknown) {
    this.trail.add(["ran", "value"]);
    return { got: data };
  }

  /** A Promise of a reply. */
  @SubscribeMessage("later")
  async later(@MessageBody() data: unknown) {
    await Bun.sleep(1);
    return { event: "later", data };
  }

  /** An Observable of several replies. */
  @SubscribeMessage("stream")
  stream() {
    return from([1, 2, 3]).pipe(map((n) => ({ event: "n", data: n })));
  }

  /** An Observable that never completes: it must end when the client goes. */
  @SubscribeMessage("forever")
  forever() {
    return interval(5).pipe(
      map((n) => ({ event: "tick", data: n })),
      finalize(() => this.trail.add(["finalized"])),
    );
  }

  /** Nothing to send. */
  @SubscribeMessage("quiet")
  quiet() {
    this.trail.add(["ran", "quiet"]);
    return undefined;
  }

  /** A property of the body (`@MessageBody("key")`). */
  @SubscribeMessage("key")
  key(@MessageBody("k") k: unknown) {
    return { event: "key", data: k ?? null };
  }

  /** A thrown `WsException`. */
  @SubscribeMessage("fail")
  fail() {
    throw new WsException("nope");
  }

  /** An Observable erroring with one (`ws-error.gateway.ts`). */
  @SubscribeMessage("failLater")
  failLater() {
    return throwError(() => new WsException("test"));
  }

  /** A `WsException` with an object. */
  @SubscribeMessage("failObject")
  failObject() {
    throw new WsException({ code: 42, why: "object" });
  }

  /** Not a `WsException`: "Internal server error", and logged. */
  @SubscribeMessage("boom")
  boom() {
    throw new Error("secret detail");
  }

  /** A `WsException` whose cause echoes a payload too deep to serialise. */
  @SubscribeMessage("deep")
  deep() {
    throw new WsException("deep");
  }

  /** The pattern, through an interceptor (`getClient` in Nest's specs). */
  @UseInterceptors(PatternInterceptor)
  @SubscribeMessage("getClient")
  getClient(@ConnectedSocket() client: AnyClient, @MessageBody() data: object) {
    return { event: "popClient", data: { ...data, path: client.pattern } };
  }

  /** The pattern, in a filter (`getClientWithError`). */
  @UseFilters(PatternFilter)
  @SubscribeMessage("getClientWithError")
  getClientWithError() {
    return throwError(() => new WsException("This is an error"));
  }

  /** A filter that throws: logged on both, nothing more for the client. */
  @UseFilters(RethrowFilter)
  @SubscribeMessage("rethrow")
  rethrow() {
    throw new WsException("to the throwing filter");
  }

  /** Closes the connection from the server with a code and reason. */
  @SubscribeMessage("kick")
  kick(@ConnectedSocket() client: AnyClient) {
    client.close(4002, "server says bye");
  }

  /** The disconnect hook's arguments past the client. */
  handleDisconnect(_client: unknown, ...rest: unknown[]) {
    this.trail.add(["disconnect", rest.length, rest[0]]);
  }
}

/** A gateway turning the client away in `handleConnection` (`connection-hook-error`). */
@WebSocketGateway({ path: "/hook-sync" })
export class SyncRejectingGateway {
  handleConnection() {
    throw new WsException("Unauthorized");
  }

  @SubscribeMessage("push")
  push(@MessageBody() data: unknown) {
    return { event: "pop", data };
  }
}

/** The same, rejecting after an await. */
@WebSocketGateway({ path: "/hook-async" })
export class AsyncRejectingGateway {
  async handleConnection() {
    await Promise.resolve();
    throw new WsException("Unauthorized");
  }

  @SubscribeMessage("push")
  push(@MessageBody() data: unknown) {
    return { event: "pop", data };
  }
}

/** Closes the client in `handleConnection`; what it sent after must not be handled. */
@WebSocketGateway({ path: "/closing" })
export class ClosingGateway {
  constructor(@Inject(Trail) private readonly trail: Trail) {}

  handleConnection(client: AnyClient) {
    client.close(4000, "go away");
  }

  @SubscribeMessage("push")
  push() {
    this.trail.add(["ran", "closing-push"]);
    return { event: "pop", data: null };
  }
}

let nextConnectionState = 0;

/** One per connection: `REQUEST` is the client (`request-scope.gateway.ts`). */
@Injectable({ scope: Scope.REQUEST })
export class ConnectionState {
  /** Which instance this is. */
  readonly instanceId = ++nextConnectionState;
  /** How many snapshots it has taken. */
  private sequence = 0;

  constructor(@Inject(REQUEST) private readonly client: unknown) {}

  /** The state as the client should see it. */
  snapshot(client: unknown, source: string) {
    this.sequence += 1;
    return {
      instanceId: this.instanceId,
      sequence: this.sequence,
      source,
      matchesClient: this.client === client,
    };
  }
}

/** Request-scoped per connection (`request-scope-gateway`, `scoped-disconnect-context`). */
@WebSocketGateway({ path: "/scoped" })
export class ScopedGateway {
  constructor(
    @Inject(ConnectionState) private readonly state: ConnectionState,
    @Inject(Push) private readonly push: Push,
    @Inject(Trail) private readonly trail: Trail,
  ) {}

  handleConnection(client: unknown) {
    this.push.send(
      client,
      "connectedState",
      this.state.snapshot(client, "connection"),
    );
  }

  @SubscribeMessage("state")
  onState(@ConnectedSocket() client: unknown) {
    return { event: "state", data: this.state.snapshot(client, "message") };
  }

  async handleDisconnect(client: unknown) {
    await Promise.resolve();
    this.trail.add([
      "scoped-disconnect",
      this.state.snapshot(client, "disconnect"),
    ]);
  }
}

/** Ends the session of the connection it was built for (`scoped-connection-hook-error`, 12.2.0). */
@Injectable({ scope: Scope.REQUEST })
export class Session {
  constructor(@Inject(REQUEST) private readonly client: AnyClient) {}

  /** Closes the connection with 4401. */
  end(reason: string) {
    this.client.close(4401, reason);
  }
}

/** A request-scoped filter, built with the connection's {@link Session}. */
@Catch(WsException)
@Injectable({ scope: Scope.REQUEST })
class EndSessionFilter implements ExceptionFilter {
  constructor(@Inject(Session) private readonly session: Session) {}

  catch(exception: WsException) {
    this.session.end(exception.message);
  }
}

/** Rejected in `handleConnection`; its request-scoped filter closes the client. */
@UseFilters(EndSessionFilter)
@WebSocketGateway({ path: "/session" })
export class SessionGateway {
  handleConnection() {
    throw new WsException("Unauthorized");
  }
}

/** Holds each `hold` message until the test releases it (the concurrency bound). */
@Injectable()
export class Gate {
  /** Messages started, in order. */
  readonly started: unknown[] = [];
  /** Releases waiting holds, oldest first. */
  private readonly releases: (() => void)[] = [];
  /** Set by {@link open}: holds pass at once. */
  private isOpen = false;

  /** Waits until released. */
  async hold(id: unknown): Promise<void> {
    this.started.push(id);
    if (this.isOpen) {
      return;
    }
    await new Promise<void>((resolve) => this.releases.push(resolve));
  }

  /** Releases every waiting hold, and lets every later one pass. */
  open(): void {
    this.isOpen = true;
    this.releaseAll();
  }

  /** Releases the oldest waiting hold; whether there was one. */
  release(): boolean {
    const next = this.releases.shift();
    next?.();
    return next !== undefined;
  }

  /** Releases every waiting hold. */
  releaseAll(): void {
    while (this.release()) {
      // drain
    }
  }
}

/** The concurrency bound (0bd0810ed) and backpressure (db4e586c5) of 12.2.0. */
@WebSocketGateway({ path: "/flow" })
export class FlowGateway {
  constructor(
    @Inject(Gate) private readonly gate: Gate,
    @Inject(Trail) private readonly trail: Trail,
  ) {}

  /** Records the disconnect: how a test sees the server drop a client that does not read. */
  handleDisconnect() {
    this.trail.add(["flow-disconnect"]);
  }

  /** Holds its slot until released. */
  @SubscribeMessage("hold")
  async hold(@MessageBody() id: unknown) {
    await this.gate.hold(id);
    return { event: "held", data: id };
  }

  /** Answers at once. */
  @SubscribeMessage("ping")
  ping(@MessageBody() id: unknown) {
    return { event: "pong", data: id };
  }

  /** A large reply: `size` bytes of payload. */
  @SubscribeMessage("big")
  big(@MessageBody() body: { id: number; size: number }) {
    this.gate.started.push(body.id);
    return { event: "big", data: { id: body.id, fill: "x".repeat(body.size) } };
  }

  /** `count` large replies from one message, as fast as the Observable goes. */
  @SubscribeMessage("flood")
  flood(@MessageBody() body: { count: number; size: number }) {
    const fill = "y".repeat(body.size);
    return interval(0).pipe(
      take(body.count),
      map((n) => ({ event: "flood", data: { n, fill } })),
    );
  }
}
