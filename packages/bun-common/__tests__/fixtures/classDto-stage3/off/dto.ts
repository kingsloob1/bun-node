/**
 * The stage-3 fixture's DTO (plan risk 1e): under this directory's
 * `tsconfig.json` (no `experimentalDecorators`), class-validator's legacy
 * decorator is invoked the stage-3 way and crashes at class-definition
 * time — the consumer-facing requirement the README states. The `on/`
 * sibling carries the same file under `experimentalDecorators: true` and
 * boots. Run as `bun dto.ts` with this directory as the cwd: Bun resolves
 * tsconfig from the cwd upward (measured on Bun 1.4.4).
 */
import { IsString } from "class-validator";

export class Stage3Dto {
  @IsString()
  name!: string;
}

console.log("booted", Stage3Dto.name);
