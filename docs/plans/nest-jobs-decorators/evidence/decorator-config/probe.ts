// Copied into each subdirectory by decorator-config.ts and run there with `bun`.
import "reflect-metadata";
import { Inject, Injectable, Module } from "@nestjs/common";
import { ModuleRef, NestFactory } from "@nestjs/core";
@Injectable()
class A { constructor(@Inject(ModuleRef) readonly ref: ModuleRef) {} }
@Module({ providers: [A] }) class M {}
const app = await NestFactory.createApplicationContext(M, { logger: false });
console.log(`injected: ${typeof app.get(A).ref}; design:paramtypes: ${Reflect.getMetadata("design:paramtypes", A)?.length ?? "none"}`);
await app.close();
