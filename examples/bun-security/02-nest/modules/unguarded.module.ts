/**
 * A module whose defence is not in the pipeline: `globalGuard: false` and no
 * `@UseGuards(SecurityGuard)` anywhere, so the route stage would never run.
 * The module's boot self-test refuses to start it.
 */
import { SecurityModule } from "@kingsleyweb/bun-nest/security";
import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";

@Module({
  imports: [
    SecurityModule.forRoot({
      policy: {},
      globalGuard: false,
      logger: () => {},
    }),
  ],
  controllers: [AppController],
})
export class UnguardedModule {}
