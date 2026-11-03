/**
 * PR-G1's check of `graphql.md` §3.1's [I] "gql.tada documents carry their
 * source": which documents carry `loc.source.body`, and what
 * `createGraphQLClient` (bun-client `./graphql`) sends for each, against the
 * package's own hand-written test endpoint, in process.
 *
 *   bun graphql/documents.ts      # from this project, after a frozen install
 *
 * Writes nothing; prints what it found (`documents-results.txt`).
 */
import { parse as parseWeb, print as printWeb } from "@0no-co/graphql.web";
import { graphql } from "gql.tada";
import { parse as parseJs, print as printJs } from "graphql";
import { createGraphQLClient } from "../../../../../../packages/bun-client/lib/graphql";
import { createClient } from "../../../../../../packages/bun-client/lib/index";
import { graphqlEndpoint } from "../../../../../../packages/bun-client/__tests__/fixtures/graphql-endpoint";

const OP = "query User($id: ID!) { user(id: $id) { id } }";
const fragment = () => graphql("fragment F on User { id }");
/** Each kind of document, made fresh per call: a client keeps a document's text once it has found it. */
const make: Record<string, () => object> = {
  "gql.tada operation": () => graphql(OP),
  "gql.tada fragment": fragment,
  "gql.tada operation with a fragment": () =>
    graphql("query User($id: ID!) { user(id: $id) { ...F } }", [fragment()]),
  "graphql-js parse": () => parseJs(OP),
  "graphql-js parse, noLocation": () => parseJs(OP, { noLocation: true }),
  "@0no-co/graphql.web parse": () => parseWeb(OP),
};
for (const [name, doc] of Object.entries(make))
  console.log(`${name}: loc ${(doc() as { loc?: unknown }).loc ? "yes" : "no"}`);

const server = graphqlEndpoint({
  operations: { User: () => ({ body: { data: { user: { id: "1" } } } }) },
});
const api = createClient({ fetch: server.fetch });
const printers = [
  ["no print", undefined],
  ["graphql.web print", printWeb],
  ["graphql-js print", printJs],
] as const;
for (const [label, print] of printers) {
  const gh = createGraphQLClient({ client: api, url: "/graphql", ...(print && { print }) });
  for (const [name, doc] of Object.entries(make)) {
    if (name === "gql.tada fragment") continue;
    const sent = await gh.query(doc() as never, { id: "1" }).then(
      () => JSON.stringify(server.seen.at(-1)?.query),
      (error: Error) => `throws: ${error.message}`,
    );
    console.log(`${label} / ${name}: ${sent}`);
  }
}
