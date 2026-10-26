/**
 * The control fixture: byte-identical to `../off/dto.ts`; only the tsconfig
 * differs (`experimentalDecorators` + `emitDecoratorMetadata` on), so the
 * class boots. Keep the two files in sync.
 */
import { IsString } from "class-validator";

export class Stage3Dto {
  @IsString()
  name!: string;
}

console.log("booted", Stage3Dto.name);
