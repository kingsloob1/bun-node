/**
 * The typed-client section's GraphQL endpoint (`/playground/client/graphql`),
 * the target of the "A typed GraphQL operation" scenario in `typed-client.ts`.
 *
 * - **bun-node serves no GraphQL.** The "server" here is a few lines that
 *   answer two operations by hand (GraphQL over HTTP: a POST with a JSON
 *   body, or a GET with the operation in the query string), standing in for
 *   someone else's API. No GraphQL library is a dependency of the playground;
 *   the client, `createGraphQLClient` from `@kingsleyweb/bun-client/graphql`,
 *   is the point. It is the same stand-in as
 *   `examples/bun-common/14-typed-client/graphql.ts`.
 * - **The documents are typed by hand**, as a `TypedString<Result, Variables>`
 *   (what gql.tada's or graphql-codegen's string documents are), so the
 *   client's results and variables are typed without a code generator.
 */
import type { BunHttpAdapter } from "@kingsleyweb/bun-common";
import type { TypedString } from "@kingsleyweb/bun-client/graphql";

/** The result of {@link UserQuery}. */
export interface UserData {
  /** The user, or `null` when the id is unknown (with a GraphQL error beside it). */
  user: { id: string; name: string } | null;
}

/** The result of {@link RenameMutation}. */
export interface RenameData {
  /** The renamed user. */
  rename: { id: string; name: string };
}

/** `query User`: one user by id. */
export const UserQuery =
  "query User($id: ID!) { user(id: $id) { id name } }" as TypedString<
    UserData,
    { id: string }
  >;

/** `mutation Rename`: sets a user's name. */
export const RenameMutation =
  "mutation Rename($id: ID!, $name: String!) { rename(id: $id, name: $name) { id name } }" as TypedString<
    RenameData,
    { id: string; name: string }
  >;

/** The names the endpoint starts with, and returns to between runs (user id → name). */
export const SEED_NAMES: ReadonlyMap<string, string> = new Map([
  ["1", "Ada"],
  ["2", "Grace"],
]);

/** What a GraphQL request carries (the parts this endpoint reads). */
interface GraphQLRequest {
  /** Which operation of the document to run. */
  operationName?: string;
  /** The operation's variables. */
  variables?: Record<string, string>;
}

/** A GraphQL-over-HTTP answer: `data`, `errors`, or both (a partial result). */
interface GraphQLAnswer {
  /** The result. */
  data?: unknown;
  /** The errors, when the operation partly or wholly failed. */
  errors?: { message: string; path?: string[] }[];
}

/** The GraphQL stand-in's state, and the way back to its seed. */
export interface GraphQLEndpoint {
  /** The current names (user id → name). */
  names: Map<string, string>;
  /** Requests answered since the last {@link GraphQLEndpoint.reset}: method and operation name. */
  seen: { method: string; operationName: string | undefined }[];
  /** Puts the names back to {@link SEED_NAMES} and clears `seen`. */
  reset: () => void;
}

/**
 * Mounts the endpoint on `app` at `path`: `POST` and `GET`, both hidden from
 * the documents. An operation it does not know is a 400, as GraphQL over HTTP
 * says; an unknown user is a 200 with `data` and `errors` (a partial result).
 *
 * @param app The adapter to mount it on.
 * @param path The endpoint's path, e.g. `/playground/client/graphql`.
 */
export function mountGraphQL(
  app: BunHttpAdapter,
  path: string,
): GraphQLEndpoint {
  const endpoint: GraphQLEndpoint = {
    names: new Map(SEED_NAMES),
    seen: [],
    reset: () => {
      endpoint.names = new Map(SEED_NAMES);
      endpoint.seen = [];
    },
  };

  /** Answers one request, or `undefined` for an operation it cannot run. */
  const execute = ({
    operationName,
    variables = {},
  }: GraphQLRequest): GraphQLAnswer | undefined => {
    const id = variables.id ?? "";
    if (operationName === "User") {
      const name = endpoint.names.get(id);
      return name === undefined
        ? {
            data: { user: null },
            errors: [{ message: "No user with that id", path: ["user"] }],
          }
        : { data: { user: { id, name } } };
    }
    if (operationName === "Rename" && endpoint.names.has(id)) {
      const name = variables.name ?? "";
      endpoint.names.set(id, name);
      return { data: { rename: { id, name } } };
    }
    return undefined;
  };

  app
    .post(path, (req, res) => {
      const body = (req.body ?? {}) as GraphQLRequest;
      endpoint.seen.push({
        method: "POST",
        operationName: body.operationName,
      });
      const answer = execute(body);
      if (answer === undefined)
        res.status(400).json({ errors: [{ message: "Unknown operation" }] });
      else res.json(answer);
    })
    .describe({ hidden: true });

  app
    .get(path, (req, res) => {
      const query = req.query as { operationName?: string; variables?: string };
      endpoint.seen.push({ method: "GET", operationName: query.operationName });
      const answer = execute({
        operationName: query.operationName,
        variables:
          query.variables === undefined
            ? {}
            : (JSON.parse(query.variables) as Record<string, string>),
      });
      if (answer === undefined)
        res.status(400).json({ errors: [{ message: "Unknown operation" }] });
      else res.json(answer);
    })
    .describe({ hidden: true });

  return endpoint;
}
