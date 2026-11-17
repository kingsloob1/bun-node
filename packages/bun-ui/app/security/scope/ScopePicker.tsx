/**
 * The scope picker (ui.md §2, the user's decision): the scopes the operator
 * can read — global, and every group and service when they can read
 * globally, else the scopes their roles are bound on — in a select, with a
 * filter once there are many. Choosing one moves the screen to it (the URL
 * changes, so the link shares it).
 */
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { TextInput } from "../../kit/components/inputs";
import { dataOf } from "../api/client";
import { queryKeys } from "../api/keys";
import { useSecurityClient } from "../context";
import { useGlobalCanFn } from "../meta/hooks";
import { useMe } from "../meta/me";
import { boundScopes, scopeLabel } from "./scope";
import { useScope } from "./useScope";

/** The most pages of groups and of services the picker reads (200 each). */
const MAX_PAGES = 5;

/** Above this many scopes, a filter is shown. */
const FILTER_FROM = 20;

/** Reads every page of a list, up to {@link MAX_PAGES}. */
async function readAll(
  page: (
    cursor: string | undefined,
  ) => Promise<{ items: readonly { id: string }[]; next?: string }>,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let n = 0; n < MAX_PAGES; n++) {
    const answer = await page(cursor);
    ids.push(...answer.items.map((item) => item.id));
    if (answer.next === undefined) break;
    cursor = answer.next;
  }
  return ids;
}

/** See the module's description. */
export function ScopePicker() {
  const { client } = useSecurityClient();
  const me = useMe();
  const can = useGlobalCanFn();
  const { scope, setScope } = useScope();
  const [filter, setFilter] = useState("");
  const id = useId();
  const global = can("policy:read");
  const listed = useQuery({
    queryKey: queryKeys.scopes(),
    enabled: global,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const groups = can("groups:read")
        ? await readAll((cursor) =>
            dataOf(
              client.get("/groups", {
                query: {
                  limit: 200,
                  ...(cursor === undefined ? {} : { cursor }),
                },
                signal,
              }),
            ),
          )
        : [];
      const services = can("services:read")
        ? await readAll((cursor) =>
            dataOf(
              client.get("/services", {
                query: {
                  limit: 200,
                  ...(cursor === undefined ? {} : { cursor }),
                },
                signal,
              }),
            ),
          )
        : [];
      return [
        ...groups.map((group) => `group:${group}`),
        ...services.map((service) => `service:${service}`),
      ];
    },
  });
  const readable = global
    ? ["global", ...(listed.data ?? [])]
    : boundScopes(me.roles);
  const options =
    scope !== null && !readable.includes(scope)
      ? [scope, ...readable]
      : readable;
  const needle = filter.trim().toLowerCase();
  const shown =
    needle === ""
      ? options
      : options.filter(
          (option) => option === scope || option.toLowerCase().includes(needle),
        );
  if (options.length === 0) return null;
  return (
    <div
      className="scope-picker"
      data-testid="scope-picker"
    >
      <label
        htmlFor={id}
        className="scope-picker-label"
      >
        Scope
      </label>
      {options.length > FILTER_FROM ? (
        <TextInput
          type="search"
          value={filter}
          onChange={setFilter}
          placeholder="Filter scopes"
          aria-label="Filter scopes"
          data-testid="scope-filter"
        />
      ) : null}
      <select
        id={id}
        className="input"
        value={scope ?? ""}
        onChange={(event) => setScope(event.target.value)}
        data-testid="scope-select"
      >
        {scope === null ? <option value="">Choose a scope</option> : null}
        {shown.map((option) => (
          <option
            key={option}
            value={option}
          >
            {scopeLabel(option)}
          </option>
        ))}
      </select>
    </div>
  );
}
