/**
 * better-auth's `where` clauses as SQL, for bun-auth's SQL adapter.
 *
 * A clause list is `{ field, operator, value, connector, mode }` entries
 * (`CleanedWhere`, after better-auth's adapter factory has mapped the field to
 * its column and converted the value). As Kysely's adapter reads them, the
 * `AND` entries are all required and the `OR` entries form one group of which
 * one must hold: `(a AND b) AND (c OR d)`.
 *
 * Every value is bound, never inlined. String comparisons are exact by
 * default, on every engine: the adapter's string columns compare exactly
 * (bun-sql's binary collation on MySQL and MariaDB), Postgres's `LIKE` is
 * case-sensitive, and on SQLite, whose `LIKE` ignores ASCII case, the pattern
 * operators use `GLOB` instead. `mode: "insensitive"` compares
 * lowercased (Postgres's `ILIKE` for patterns). A pattern's own `%`, `_` and
 * escape character are escaped.
 */
import type { SqlAdapter } from "@kingsleyweb/bun-sql/dialect";
import type { CleanedWhere } from "better-auth/adapters";

/** Collects bound values and renders their placeholders. */
export interface Binder {
  /** Binds `value` and returns its placeholder (`$3`, `?`). */
  bind: (value: unknown) => string;
  /** The values bound so far, in placeholder order. */
  readonly params: unknown[];
}

/** A binder whose placeholders are `placeholder(1)`, `placeholder(2)`, … */
export function createBinder(placeholder: (index: number) => string): Binder {
  const params: unknown[] = [];
  return {
    params,
    bind: (value) => {
      params.push(value === undefined ? null : value);
      return placeholder(params.length);
    },
  };
}

/** The `LIKE` escape character: not `\`, which MySQL also reads inside string literals. */
const ESCAPE = "!";

/** `value` with `LIKE`'s wildcards and the escape character escaped. */
function escapeLike(value: string): string {
  return value.replaceAll(/[!%_]/g, (char) => `${ESCAPE}${char}`);
}

/** One clause as a predicate. */
function predicate(
  engine: SqlAdapter,
  column: string,
  clause: CleanedWhere,
  binder: Binder,
): string {
  const { operator, value } = clause;
  const strings = (input: unknown): input is string | string[] =>
    typeof input === "string" ||
    (Array.isArray(input) && input.every((item) => typeof item === "string"));
  const insensitive = clause.mode === "insensitive" && strings(value);
  const lower = (text: string) => `LOWER(${text})`;
  const lhs = insensitive ? lower(column) : column;
  const folded = (input: unknown) =>
    insensitive && typeof input === "string" ? input.toLowerCase() : input;

  switch (operator) {
    case "in":
    case "not_in": {
      const values = Array.isArray(value) ? value : [value];
      if (values.length === 0) {
        // Nothing is in an empty list; everything is outside it.
        return operator === "in" ? "1 = 0" : "1 = 1";
      }
      const list = values.map((item) => binder.bind(folded(item))).join(", ");
      return `${lhs} ${operator === "in" ? "IN" : "NOT IN"} (${list})`;
    }
    case "contains":
    case "starts_with":
    case "ends_with": {
      const text = String(value);
      if (insensitive) {
        const pattern = likePattern(operator, escapeLike(text.toLowerCase()));
        return engine === "postgres"
          ? `${column} ILIKE ${binder.bind(pattern)} ESCAPE '${ESCAPE}'`
          : `${lower(column)} LIKE ${binder.bind(pattern)} ESCAPE '${ESCAPE}'`;
      }
      if (engine === "sqlite") {
        // SQLite's LIKE folds ASCII case; GLOB does not. Its wildcards are
        // escaped by wrapping each in a character class.
        const glob = text.replaceAll(/[[*?]/g, (char) => `[${char}]`);
        const pattern =
          operator === "contains"
            ? `*${glob}*`
            : operator === "starts_with"
              ? `${glob}*`
              : `*${glob}`;
        return `${column} GLOB ${binder.bind(pattern)}`;
      }
      return `${column} LIKE ${binder.bind(likePattern(operator, escapeLike(text)))} ESCAPE '${ESCAPE}'`;
    }
    case "eq":
      return value === null
        ? `${column} IS NULL`
        : `${lhs} = ${binder.bind(folded(value))}`;
    case "ne":
      return value === null
        ? `${column} IS NOT NULL`
        : `${lhs} <> ${binder.bind(folded(value))}`;
    case "gt":
      return `${column} > ${binder.bind(value)}`;
    case "gte":
      return `${column} >= ${binder.bind(value)}`;
    case "lt":
      return `${column} < ${binder.bind(value)}`;
    case "lte":
      return `${column} <= ${binder.bind(value)}`;
  }
}

/** A `LIKE` pattern for a pattern operator over already escaped text. */
function likePattern(
  operator: "contains" | "starts_with" | "ends_with",
  text: string,
): string {
  if (operator === "contains") {
    return `%${text}%`;
  }
  return operator === "starts_with" ? `${text}%` : `%${text}`;
}

/**
 * The condition `where` describes, without the `WHERE` keyword, or `""` for
 * no clauses. `column` renders a column for a field name (quoted, and
 * qualified where the query needs it).
 */
export function compileWhere(
  engine: SqlAdapter,
  where: readonly CleanedWhere[] | undefined,
  column: (field: string) => string,
  binder: Binder,
): string {
  if (!where || where.length === 0) {
    return "";
  }
  const and: string[] = [];
  const or: string[] = [];
  for (const clause of where) {
    const rendered = predicate(engine, column(clause.field), clause, binder);
    (clause.connector === "OR" ? or : and).push(rendered);
  }
  const parts = [
    ...and.map((part) => `(${part})`),
    ...(or.length > 0
      ? [`(${or.map((part) => `(${part})`).join(" OR ")})`]
      : []),
  ];
  return parts.join(" AND ");
}
