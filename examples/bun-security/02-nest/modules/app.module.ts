/**
 * The example application's module: `SecurityModule.forRoot()` creates the
 * engine, installs its three stages on the bun-nest adapter, and registers
 * `SecurityGuard` as the global guard.
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import { SecurityModule } from "@kingsleyweb/bun-nest/security";
import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";

@Module({
  imports: [
    SecurityModule.forRoot({
      policy: {
        lists: [
          { ip: "203.0.113.0/24", action: "block" },
          { user: "u_mallory", action: "block" },
        ],
        limits: [{ id: "per-user", limit: 3, window: "1m", key: "user" }],
      },
      identify: (req: BunRequest) => {
        const user = req.request.headers.get("x-user-id");
        return user === null ? undefined : { user };
      },
      logger: () => {},
    }),
  ],
  controllers: [AppController],
})
export class AppModule {}
