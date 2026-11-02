import { Client, fetchExchange, cacheExchange, gql } from "@urql/core";
export const client = new Client({ url: "/graphql", exchanges: [cacheExchange, fetchExchange] });
export const q = gql`query Q($id: ID!) { user(id: $id) { id name } }`;
