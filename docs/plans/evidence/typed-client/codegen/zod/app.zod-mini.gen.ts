// Generated from the server's route model. Do not edit.
// hash: aa196cb08f89b79e
import { z } from "zod/mini";
export const schemas = {
  "DELETE /users/:id": { params: z.looseObject({ "id": z.string() }), responses: { 204: null, 404: z.looseObject({ "type": z.string(), "title": z.string(), "status": z.number(), "code": z.optional(z.string()) }) } },
  // warning GET /legacy: no validator: request and response untyped
  "GET /legacy": { responses: {  } },
  // warning GET /orgs/:org/members/:id: GET /orgs/:org/members/:id 200: Date cannot be represented in JSON Schema; described as unknown
  "GET /orgs/:org/members/:id": { params: z.looseObject({ "org": z.string(), "id": z.string() }), responses: { 200: z.looseObject({ "org": z.string(), "id": z.string(), "since": z.unknown() }) } },
  "GET /users": { query: z.looseObject({ "page": z.optional(z.int().check(z.gte(1))), "q": z.optional(z.string()) }), responses: { 200: z.looseObject({ "items": z.array(z.looseObject({ "id": z.string(), "name": z.string(), "email": z.email(), "role": z.enum(["admin","member"]), "createdAt": z.iso.datetime() })), "next": z.nullable(z.number()) }) } },
  "GET /users/:id": { params: z.looseObject({ "id": z.string() }), responses: { 200: z.looseObject({ "id": z.string(), "name": z.string(), "email": z.email(), "role": z.enum(["admin","member"]), "createdAt": z.iso.datetime() }), 404: z.looseObject({ "type": z.string(), "title": z.string(), "status": z.number(), "code": z.optional(z.string()) }) } },
  "POST /users": { body: z.looseObject({ "name": z.string().check(z.minLength(1)), "email": z.email(), "role": z.optional(z.enum(["admin","member"])) }), responses: { 201: z.looseObject({ "id": z.string(), "name": z.string(), "email": z.email(), "role": z.enum(["admin","member"]), "createdAt": z.iso.datetime() }), 409: z.looseObject({ "type": z.string(), "title": z.string(), "status": z.number(), "code": z.optional(z.string()) }) } },
} as const;
