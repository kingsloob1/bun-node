/** Item 7 helper: is the schema metadata of @RawBody({ schema }) reaching the pipe? */
import "reflect-metadata";
import { Controller, Post, RawBody, StandardSchemaValidationPipe } from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/internal";
import { z } from "zod";
const Raw = z.custom<Buffer>((b) => Buffer.isBuffer(b)).transform((b) => ({ bytes: b.length }));
@Controller()
class C {
  @Post("raw-schema")
  rawSchema(@RawBody({ schema: Raw } as any) raw: any) {
    return raw;
  }
}
const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, C, "rawSchema");
console.log(Object.entries(meta).map(([k, v]: any) => ({ k, hasSchema: !!v.schema, pipes: v.pipes?.length })));
const pipe = new StandardSchemaValidationPipe();
console.log(await pipe.transform(Buffer.from("xy"), { type: "rawBody" as any, schema: Raw } as any));
