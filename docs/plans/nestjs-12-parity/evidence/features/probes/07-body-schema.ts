/** Item 7: rawBody + useBodyParser, @RawBody/@Body/@Query/@Param({ schema }), StandardSchema pipe & serializer. */
import * as common from "@nestjs/common";
import { Body, Controller, Get, Module, Param, Post, Query, RawBody, UseInterceptors } from "@nestjs/common";
import { z } from "zod";
import { build, runCases, snap } from "./harness";

const C12 = common as any;
const has = typeof C12.StandardSchemaValidationPipe === "function";
const Item = z.object({ name: z.string().min(2), qty: z.coerce.number().int() });
const Page = z.object({ page: z.coerce.number().int().min(1), tags: z.any().optional(), filter: z.any().optional() });
const Id = z.coerce.number().int();
const Raw = z.custom<Buffer>((b) => Buffer.isBuffer(b), "expected a Buffer").transform((b) => ({ bytes: b.length, text: b.toString() }));
const Out = z.object({ id: z.number(), name: z.string() }); // strips unknown keys

function makeModule() {
  const SerializeOptions = C12.SerializeOptions;
  const Ser = C12.StandardSchemaSerializerInterceptor;
  @Controller()
  class C {
    @Post("raw")
    raw(@RawBody() raw: any, @Body() body: any) {
      return { isBuffer: Buffer.isBuffer(raw), raw: raw === undefined ? "undefined" : Buffer.isBuffer(raw) ? raw.toString() : raw, body };
    }
    @Post("raw-schema")
    rawSchema(@RawBody({ schema: Raw } as any) raw: any) {
      return raw;
    }
    @Post("item")
    item(@Body({ schema: Item } as any) item: any) {
      return { item, qtyType: typeof item?.qty };
    }
    @Get("page")
    page(@Query({ schema: Page } as any) q: any) {
      return { q, pageType: typeof q?.page };
    }
    @Get("thing/:id")
    thing(@Param("id", { schema: Id } as any) id: any) {
      return { id, type: typeof id };
    }
    @Get("ser")
    @UseInterceptors(Ser)
    @SerializeOptions({ schema: Out } as any)
    ser() {
      return { id: 1, name: "n", secret: "hide-me" };
    }
  }
  @Module({ controllers: [C] })
  class M {}
  return M;
}

await runCases("07-body-schema", {
  all: async () => {
    if (!has) return "not-applicable: no StandardSchemaValidationPipe in this @nestjs/common";
    const b = await build(makeModule(), { rawBody: true }, {
      setup: (app) => {
        app.useGlobalPipes(new C12.StandardSchemaValidationPipe());
        app.useBodyParser("text");
      },
    });
    try {
      const json = { "content-type": "application/json" };
      const r: Record<string, unknown> = {};
      r.rawJson = await snap(await b.request("/raw", { method: "POST", headers: json, body: '{"a":1}' }));
      r.rawText = await snap(await b.request("/raw", { method: "POST", headers: { "content-type": "text/plain" }, body: "plain text" }));
      r.rawUrlencoded = await snap(await b.request("/raw", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=1&b=2" }));
      r.rawOctet = await snap(await b.request("/raw", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "bin" }));
      r.rawNoBody = await snap(await b.request("/raw", { method: "POST" }));
      r.rawSchema = await snap(await b.request("/raw-schema", { method: "POST", headers: json, body: '{"z":true}' }));
      r.itemOk = await snap(await b.request("/item", { method: "POST", headers: json, body: '{"name":"ab","qty":"3","extra":1}' }));
      r.itemBad = await snap(await b.request("/item", { method: "POST", headers: json, body: '{"name":"a","qty":"x"}' }));
      r.pageOk = await snap(await b.request("/page?page=2&tags=a&tags=b&filter[x]=1"));
      r.pageBad = await snap(await b.request("/page?page=0"));
      r.paramOk = await snap(await b.request("/thing/42"));
      r.paramBad = await snap(await b.request("/thing/abc"));
      r.serializer = await snap(await b.request("/ser"));
      return r;
    } finally {
      await b.close();
    }
  },
});
