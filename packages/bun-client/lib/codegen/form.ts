/**
 * Bodies beyond JSON, as the documents describe them (typed-client plan,
 * `other-transports.md` §3, §4, PR-C9), shared by the route map's generator
 * (`./openapi`) and the zod emitter (`./zod`):
 *
 * - a `multipart/form-data` body's schema split into its **fields** (the
 *   call's `body`) and its **files** (the call's `files`): a property is a
 *   file when it is a binary string (`format: "binary"`, OpenAPI 3.0's
 *   spelling, which bun-common's `RouteDoc.request.files` writes, or a
 *   `contentMediaType` without a `contentEncoding`, 3.1's), or an array of
 *   them; its size from `x-bun-max-bytes`, its media types from the media
 *   type object's `encoding.<field>.contentType`;
 * - a response body's **framing**: `x-bun-chunks` (bun-common's `chunks()`)
 *   or an NDJSON media type.
 */
import type { SchemaContext } from "./schema";
import { isRecord, resolvePointer } from "./schema";

/** One file field of a multipart body. */
export interface FileField {
  /** The field's name. */
  readonly name: string;
  /** The body must carry it. */
  readonly required: boolean;
  /** It takes a list of files (an array schema), not one. */
  readonly multiple: boolean;
  /** The list's `maxItems`, when it has one. */
  readonly maxItems?: number;
  /** The largest file, in bytes (`x-bun-max-bytes`). */
  readonly maxBytes?: number;
  /** The media types a file may have (`encoding.<field>.contentType`, split on commas). */
  readonly mediaTypes?: readonly string[];
  /** The property's description. */
  readonly description?: string;
}

/** A multipart schema split into its fields and its files. */
export interface SplitForm {
  /** The fields' schema, the files taken out; `undefined` when only files remain. */
  readonly fields: unknown;
  /** The files, in the order the schema lists them. */
  readonly files: readonly FileField[];
}

/** A `$ref` followed (repeatedly) to what it points at; the schema itself otherwise. */
function resolve(schema: unknown, context: SchemaContext): unknown {
  let current = schema;
  for (let depth = 0; depth < 32; depth++) {
    if (!isRecord(current) || typeof current.$ref !== "string") return current;
    current = resolvePointer(context.document, current.$ref);
  }
  return current;
}

/** Whether a (resolved) schema is one binary string: a file. */
function isFileSchema(schema: unknown): boolean {
  return (
    isRecord(schema) &&
    (schema.type === "string" || schema.type === undefined) &&
    (schema.format === "binary" ||
      (typeof schema.contentMediaType === "string" &&
        schema.contentEncoding === undefined))
  );
}

/** A property as a file field, or `undefined` when it is not one. */
function fileField(
  name: string,
  raw: unknown,
  required: boolean,
  encoding: unknown,
  context: SchemaContext,
): FileField | undefined {
  const schema = resolve(raw, context);
  if (!isRecord(schema)) return undefined;
  let one: Record<string, unknown>;
  let multiple = false;
  if (isFileSchema(schema)) {
    one = schema;
  } else if (
    schema.type === "array" &&
    isFileSchema(resolve(schema.items, context))
  ) {
    one = resolve(schema.items, context) as Record<string, unknown>;
    multiple = true;
  } else {
    return undefined;
  }
  const part = isRecord(encoding) ? encoding[name] : undefined;
  const contentType =
    isRecord(part) && typeof part.contentType === "string"
      ? part.contentType
      : typeof one.contentMediaType === "string"
        ? one.contentMediaType
        : undefined;
  const mediaTypes = contentType
    ?.split(",")
    .map((type) => type.trim())
    .filter((type) => type !== "");
  const maxBytes = one["x-bun-max-bytes"];
  const description =
    typeof schema.description === "string"
      ? schema.description
      : typeof one.description === "string"
        ? one.description
        : undefined;
  return {
    name,
    required,
    multiple,
    ...(multiple && typeof schema.maxItems === "number"
      ? { maxItems: schema.maxItems }
      : {}),
    ...(typeof maxBytes === "number" ? { maxBytes } : {}),
    ...(mediaTypes !== undefined && mediaTypes.length > 0
      ? { mediaTypes }
      : {}),
    ...(description === undefined ? {} : { description }),
  };
}

/** Whether an object schema says nothing once its properties are gone. */
function isEmptyObject(schema: Record<string, unknown>): boolean {
  return Object.keys(schema).every(
    (key) =>
      key === "type" ||
      key === "additionalProperties" ||
      (key === "properties" &&
        isRecord(schema.properties) &&
        Object.keys(schema.properties).length === 0) ||
      (key === "required" &&
        Array.isArray(schema.required) &&
        schema.required.length === 0),
  );
}

/** Takes the file properties out of one object schema. */
function splitObject(
  schema: Record<string, unknown>,
  encoding: unknown,
  context: SchemaContext,
  files: FileField[],
): Record<string, unknown> | undefined {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === "string")
    : [];
  const kept: Record<string, unknown> = {};
  const taken = new Set<string>();
  for (const [name, property] of Object.entries(properties)) {
    const file = fileField(
      name,
      property,
      required.includes(name),
      encoding,
      context,
    );
    if (file === undefined) kept[name] = property;
    else {
      files.push(file);
      taken.add(name);
    }
  }
  if (taken.size === 0) return schema;
  const rest = required.filter((name) => !taken.has(name));
  const out: Record<string, unknown> = { ...schema, properties: kept };
  if (rest.length > 0) out.required = rest;
  else delete out.required;
  return isEmptyObject(out) ? undefined : out;
}

/**
 * Splits a multipart body's schema into fields and files. An object's file
 * properties are taken out (a `$ref` to one followed); under `allOf`, each
 * member is split the same way, a member left with nothing dropped, and a
 * member with no file kept as written (a `$ref` stays one).
 *
 * @param schema   The media type object's `schema`.
 * @param encoding The media type object's `encoding`.
 * @param context  The document, for `$ref`s.
 */
export function splitMultipart(
  schema: unknown,
  encoding: unknown,
  context: SchemaContext,
): SplitForm {
  const files: FileField[] = [];
  const resolved = resolve(schema, context);
  if (!isRecord(resolved)) return { fields: schema, files };
  if (Array.isArray(resolved.allOf)) {
    const members: unknown[] = [];
    for (const member of resolved.allOf) {
      const target = resolve(member, context);
      if (!isRecord(target)) {
        members.push(member);
        continue;
      }
      const before = files.length;
      const split = splitObject(target, encoding, context, files);
      if (files.length === before) members.push(member);
      else if (split !== undefined) members.push(split);
    }
    const { allOf: _allOf, ...rest } = resolved;
    if (files.length === 0) return { fields: schema, files };
    const fields =
      members.length === 0
        ? undefined
        : members.length === 1 && Object.keys(rest).length === 0
          ? members[0]
          : { ...rest, allOf: members };
    return { fields, files };
  }
  const split = splitObject(resolved, encoding, context, files);
  return { fields: files.length === 0 ? schema : split, files };
}

/** How a streamed body is cut: one JSON value per line, or bytes. */
export type Framing = "ndjson" | "raw";

/** An NDJSON media type: `application/x-ndjson`, `application/ndjson`, `application/jsonl`, `application/jsonlines`. */
export function isNdjsonType(mediaType: string): boolean {
  return /^application\/(?:x-)?(?:nd-?json|jsonl|jsonlines)$/i.test(
    mediaType.split(";")[0].trim(),
  );
}

/**
 * A response body's framing: its schema's `x-bun-chunks` (bun-common's
 * `chunks()`), else `"ndjson"` for an NDJSON media type; `undefined` for a
 * body read whole.
 */
export function framingOf(
  mediaType: string,
  schema: unknown,
): Framing | undefined {
  const marked = isRecord(schema) ? schema["x-bun-chunks"] : undefined;
  if (marked === "ndjson" || marked === "raw") return marked;
  return isNdjsonType(mediaType) ? "ndjson" : undefined;
}
