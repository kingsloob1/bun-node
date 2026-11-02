import { parse, print } from "graphql";
export const text = print(parse(`query Q($id: ID!) { user(id: $id) { id name } }`));
