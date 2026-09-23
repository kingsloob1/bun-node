/* eslint-disable */
import "reflect-metadata";
import { IsString, IsInt, Min, IsOptional, validate as cvValidate, ValidationError } from "class-validator";
import { plainToInstance, Type, Transform } from "class-transformer";

class Address { @IsString() city!: string; }
class CreateUser {
  @IsString() name!: string;
  @IsInt() @Min(1) age!: number;
  @IsOptional() @IsString() nickname?: string;
  @Type(() => Address) address!: Address;
  @IsString({ each: true }) tags!: string[];
}

const raw = { name: "ada", age: "42", address: { city: "London" }, tags: ["a", "b"], extra: "drop me" };
const inst = plainToInstance(CreateUser, raw, { enableImplicitConversion: true, excludeExtraneousValues: false });
console.log("plainToInstance ->", JSON.stringify(inst), "| is instance:", inst instanceof CreateUser);
console.log("age coerced to:", typeof (inst as any).age);
console.log("nested is Address:", (inst as any).address instanceof Address);
const errs: ValidationError[] = await cvValidate(inst as object, { whitelist: true, forbidNonWhitelisted: false });
console.log("errors (valid input):", errs.length);

const bad = plainToInstance(CreateUser, { name: 1, age: 0, address: {}, tags: [1] }, { enableImplicitConversion: false });
const errs2 = await cvValidate(bad as object);
console.log("errors (bad input):", errs2.map(e => `${e.property}:${Object.keys(e.constraints ?? {}).join("/")}`).join(", "));

// the JSON-Schema source: class-validator's own metadata storage
const { getMetadataStorage } = await import("class-validator");
const md = (getMetadataStorage as any)().getTargetValidationMetadatas(CreateUser, "", false, false);
console.log("validation metadata entries:", md.length, "->", md.map((m: any) => `${m.propertyName}:${m.type}`).slice(0, 8).join(", "));
