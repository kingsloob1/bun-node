import { graphql } from "gql.tada";
import { print } from "@0no-co/graphql.web";
export const doc = graphql(`query Q($id: ID!) { user(id: $id) { id name } }`);
export const text = print(doc);
