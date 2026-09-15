/**
 * Quick start: a NestJS application served by `Bun.serve`, through
 * `@kingsleyweb/bun-nest`'s `BunHttpAdapter`.
 *
 * ```bash
 * bun 01-quick-start/index.ts
 * ```
 *
 * Pass the adapter to `NestFactory.create` in place of
 * `@nestjs/platform-express` and nothing else in the app changes — modules,
 * controllers, decorators, pipes and exceptions are plain NestJS. Underneath,
 * routing is bun-common's `BunRouter`, and every request is a `BunRequest` /
 * `BunResponse` pair, which is what `@Req()` and `@Res()` hand you.
 *
 * Worth knowing:
 *
 * - `app.listen(0)` asks the OS for a free port; `app.getUrl()` says which.
 * - `app.close()` force-closes the Bun server, keep-alive connections
 *   included, so the port is released at once.
 * - `reflect-metadata` sits last only because the import-sort rule puts
 *   side-effect imports there. Every import runs before this module's own
 *   code, so it is still loaded before any decorator is evaluated.
 */
import type { JsonValue } from "@kingsleyweb/bun-common";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Module,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { show, step, title } from "../shared/console";
import "reflect-metadata";

/** One item on the list. */
interface Todo {
  /** Its id, assigned on creation. */
  id: number;
  /** What needs doing. */
  title: string;
  /** Whether it is done. */
  done: boolean;
}

/** What a client posts to create a todo. */
interface CreateTodo {
  /** What needs doing. Required. */
  title?: string;
  /** Whether it starts out done. Defaults to `false`. */
  done?: boolean;
}

const todos: Todo[] = [
  { id: 1, title: "Install Bun", done: true },
  { id: 2, title: "Serve NestJS from Bun", done: false },
];

@Controller("todos")
class TodosController {
  /** `GET /todos`, optionally `?done=true|false`. */
  @Get()
  list(@Query("done") done?: string): Todo[] {
    if (done === undefined) {
      return todos;
    }

    return todos.filter((todo) => String(todo.done) === String(done));
  }

  /** `GET /todos/:id` — `ParseIntPipe` turns the param into a number. */
  @Get(":id")
  one(@Param("id", ParseIntPipe) id: number): Todo {
    const todo = todos.find((candidate) => candidate.id === id);
    if (!todo) {
      throw new NotFoundException(`No todo with id ${id}`);
    }

    return todo;
  }

  /** `POST /todos` — the parsed JSON body arrives through `@Body()`. */
  @Post()
  create(@Body() body: CreateTodo): Todo {
    if (!body?.title) {
      throw new BadRequestException("title is required");
    }

    const todo: Todo = {
      id: todos.length + 1,
      title: body.title,
      done: body.done ?? false,
    };
    todos.push(todo);
    return todo;
  }
}

@Module({ controllers: [TodosController] })
class AppModule {}

title("Quick start: NestJS on Bun");

/* ------------------------------------------------------------------ */
step("Create the app with a BunHttpAdapter and listen on a free port");

const app = await NestFactory.create(AppModule, new BunHttpAdapter(), {
  logger: false,
  abortOnError: false,
});
await app.listen(0);
const url = await app.getUrl();
show("listening on", url);

/** Calls the app over HTTP and answers with the status and the JSON body. */
async function call(path: string, init?: RequestInit) {
  const response = await fetch(`${url}${path}`, init);
  return {
    status: response.status,
    body: (await response.json()) as JsonValue,
  };
}

/** Request options for a JSON `POST`. */
function postJson(body: JsonValue): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/* ------------------------------------------------------------------ */
step("GET with and without a query string");
show("GET /todos", await call("/todos"));
show("GET /todos?done=false", await call("/todos?done=false"));

/* ------------------------------------------------------------------ */
step("GET with a route param");
show("GET /todos/2", await call("/todos/2"));
show("GET /todos/99 (NotFoundException)", await call("/todos/99"));
show("GET /todos/abc (ParseIntPipe)", await call("/todos/abc"));

/* ------------------------------------------------------------------ */
step("POST a JSON body — 201 Created by default");
show("POST /todos", await call("/todos", postJson({ title: "Write docs" })));
show("POST /todos without a title", await call("/todos", postJson({})));

/* ------------------------------------------------------------------ */
step("A route nobody declared");
show("GET /nope", await call("/nope"));

/* ------------------------------------------------------------------ */
step("Close");
await app.close();
show("closed; the port is free again");
