/** @TypedRoute constrains the method's return type (compile-time only; tsc -p .). */
import "reflect-metadata";
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common/lib/types/standardSchema.ts";
import { z } from "zod";

type Out<R> = { [K in keyof R]: R[K] extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<R[K]> : undefined }[keyof R];
declare function TypedRoute<const R extends Record<number, StandardSchemaV1 | null>>(o: { responses: R }): <T extends (...a: never[]) => Out<R> | Promise<Out<R>>>(t: object, k: string | symbol, d: TypedPropertyDescriptor<T>) => void;
const User = z.object({ id: z.string() });
export class C {
  @TypedRoute({ responses: { 200: User } }) ok() { return { id: "1" }; }
  @TypedRoute({ responses: { 200: User } }) async okAsync() { return { id: "1" }; }
  // @ts-expect-error the return type matches no declared response
  @TypedRoute({ responses: { 200: User } }) bad() { return { nope: true }; }
}
