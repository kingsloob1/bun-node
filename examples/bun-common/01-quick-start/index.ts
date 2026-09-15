/**
 * Quick start — a small JSON API on `BunHttpAdapter`: routes, a JSON body,
 * params, an error handler and a not-found handler, served on a real port.
 *
 * ```bash
 * bun 01-quick-start/index.ts
 * ```
 *
 * - The adapter *is* a router: `get`/`post`/`use` register straight on it.
 * - A 4-argument callback is an error handler, and like every middleware it
 *   runs in registration order — so it is registered after the routes.
 * - `listen(0)` asks the OS for a free port; `close()` force-closes it.
 */
import type { RouterErrorMiddlewareHandler } from "@kingsleyweb/bun-common";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { show, step, title } from "../shared/console";

/** A todo as the API stores and returns it. */
interface Todo {
  /** Assigned by the server. */
  id: number;
  /** What needs doing. */
  title: string;
  /** Whether it is done. */
  done: boolean;
}

/** An error that carries the HTTP status it should be answered with. */
class HttpError extends Error {
  constructor(
    /** The status the error handler responds with. */
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

title("Quick start: a todo API");

const todos = new Map<number, Todo>();
const app = new BunHttpAdapter();

app.get("/todos", (_req, res) => {
  res.json({ todos: [...todos.values()] });
});

app.post("/todos", (req, res) => {
  // Unvalidated client input: `unknown` until the check below narrows it.
  const { title } = (req.body ?? {}) as { title?: unknown };
  if (typeof title !== "string" || title === "") {
    throw new HttpError(400, "title is required");
  }
  const todo = { id: todos.size + 1, title, done: false };
  todos.set(todo.id, todo);
  res.status(201).json({ todo });
});

app.get("/todos/:id", (req, res, next) => {
  const todo = todos.get(Number(req.params.id));
  // next() with nothing left to run is what reaches the not-found handler.
  return todo ? res.json({ todo }) : next();
});

app.use(((error, _req, res, _next) => {
  const status = error instanceof HttpError ? error.status : 500;
  res.status(status).json({ error: String((error as Error).message) });
}) satisfies RouterErrorMiddlewareHandler);

app.setNotFoundHandler((req, res) => {
  res.status(404).json({ error: `nothing at ${req.method} ${req.path}` });
});

/* ------------------------------------------------------------------ */
step("Serving on an OS-assigned port");

await app.listen(0);
show("listening at", app.url);

/** Calls the running API and prints what came back. */
async function call(method: string, path: string, body?: object) {
  const response = await fetch(`${app.url}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  show(`${method} ${path} → ${response.status}`, await response.json());
}

/* ------------------------------------------------------------------ */
step("Exercising it");

await call("POST", "/todos", { title: "write the docs" });
await call("POST", "/todos", {});
await call("GET", "/todos/1");
await call("GET", "/todos/99");
await call("GET", "/todos");

await app.close();
show("closed; still listening?", app.isListening);
